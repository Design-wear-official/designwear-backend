import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createAccessTokenSource } from './google_auth.js';
import { eq, failureOf, hasStatus, sethuClient } from './sethu.js';

/**
 * Small document store: collections of JSON documents keyed by id.
 * Persists to one JSON file with atomic writes. Pass ':memory:' for tests.
 * One process only. For serverless hosting use RedisStore below.
 */
export class Store {
  constructor(file = ':memory:') {
    this.file = file;
    this.data = {};
    this.chain = Promise.resolve();
    this.queued = null;
  }

  async load() {
    if (this.file === ':memory:') return this;
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  #coll(name) {
    return (this.data[name] ??= {});
  }

  async get(coll, id) {
    const doc = this.#coll(coll)[id];
    return doc ? structuredClone(doc) : null;
  }

  async list(coll, predicate = () => true) {
    return Object.values(this.#coll(coll)).filter(predicate).map((d) => structuredClone(d));
  }

  async put(coll, id, doc) {
    this.#coll(coll)[id] = structuredClone(doc);
    await this.#flush();
    return doc;
  }

  async del(coll, id) {
    delete this.#coll(coll)[id];
    await this.#flush();
  }

  // Writes are coalesced: while one is in flight, further puts share a single
  // follow-up write of the latest data, so a burst of N changes costs at most
  // two file writes instead of N full rewrites. The returned promise resolves
  // once the data including this change is on disk.
  #flush() {
    if (this.file === ':memory:') return Promise.resolve();
    if (!this.queued) {
      this.queued = this.chain.then(async () => {
        this.queued = null;
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
        await rename(tmp, this.file);
      });
      this.chain = this.queued.catch(() => {});
    }
    return this.queued;
  }
}

/**
 * The same interface on Redis over HTTPS (Upstash, also what Vercel's Redis
 * integration provides), so any number of short-lived serverless instances can
 * share one database. Each collection is one Redis hash: id -> JSON document.
 */
export class RedisStore {
  constructor({ url, token, fetchImpl = fetch, prefix = 'dw:' }) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.prefix = prefix;
  }

  async load() {
    return this;
  }

  async #command(...args) {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(`redis_error:${response.status}:${body.error ?? ''}`);
    }
    return body.result;
  }

  async get(coll, id) {
    const raw = await this.#command('HGET', this.prefix + coll, id);
    return raw ? JSON.parse(raw) : null;
  }

  // Reads the whole collection, then filters. Fine for a small shop; add
  // indexes (as with `emails`) before a collection grows large.
  async list(coll, predicate = () => true) {
    const values = (await this.#command('HVALS', this.prefix + coll)) ?? [];
    return values.map((raw) => JSON.parse(raw)).filter(predicate);
  }

  async put(coll, id, doc) {
    await this.#command('HSET', this.prefix + coll, id, JSON.stringify(doc));
    return doc;
  }

  async del(coll, id) {
    await this.#command('HDEL', this.prefix + coll, id);
  }
}

/**
 * The same interface on Firebase's Firestore, over its REST API with a service
 * account (no SDK). Each document stores the record as one JSON string in the
 * field `d`, so records keep their exact shape. Firestore caps a document at
 * 1 MiB, so a design with very large previews can be refused on save.
 */
export class FirestoreStore {
  constructor({ credentials, fetchImpl = fetch, now = () => Date.now() }) {
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.now = now;
    this.root = `https://firestore.googleapis.com/v1/projects/${credentials.project_id}/databases/(default)/documents`;
    this.token = createAccessTokenSource({
      credentials,
      scope: 'https://www.googleapis.com/auth/datastore',
      fetchImpl,
      now,
      errorPrefix: 'firestore_auth_error',
    });
  }

  async load() {
    return this;
  }

  async #call(method, url, body) {
    const response = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404 && method !== 'PATCH') return null;
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`firestore_error:${response.status}`);
    return parsed;
  }

  #docUrl(coll, id) {
    return `${this.root}/${encodeURIComponent(coll)}/${encodeURIComponent(id)}`;
  }

  async get(coll, id) {
    const doc = await this.#call('GET', this.#docUrl(coll, id));
    return doc?.fields?.d ? JSON.parse(doc.fields.d.stringValue) : null;
  }

  // Reads the whole collection page by page, then filters.
  async list(coll, predicate = () => true) {
    const results = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ pageSize: '300', 'mask.fieldPaths': 'd' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.#call('GET', `${this.root}/${encodeURIComponent(coll)}?${query}`);
      for (const doc of page?.documents ?? []) {
        const record = JSON.parse(doc.fields.d.stringValue);
        if (predicate(record)) results.push(record);
      }
      pageToken = page?.nextPageToken ?? '';
    } while (pageToken);
    return results;
  }

  async put(coll, id, doc) {
    await this.#call('PATCH', `${this.#docUrl(coll, id)}?updateMask.fieldPaths=d`, {
      fields: { d: { stringValue: JSON.stringify(doc) } },
    });
    return doc;
  }

  async del(coll, id) {
    await this.#call('DELETE', this.#docUrl(coll, id));
  }
}

/**
 * The same interface on a SethuCMS collection, so SethuCMS is the only database
 * the shop needs. Every record of every store collection lives in one SethuCMS
 * collection (default `dw_store`) with three text fields:
 *   id    the key, "<collection>:<base64url of the id>"
 *   coll  which store collection it belongs to (users, orders, ...)
 *   data  the record as JSON
 * Give the token read-write access to that collection only, and keep the
 * collection hidden from everyone else: it holds password hashes.
 */
export class SethuStore {
  constructor({ url, connectionId, token, collection = 'dw_store', allowHttp = false }, fetchImpl = fetch) {
    Object.assign(this, { url, connectionId, token, collection, allowHttp, fetchImpl });
  }

  async load() {
    return this;
  }

  // Built on first use, so a store that is never reached needs no gateway address.
  get records() {
    // Every request reads or writes here, so a bad gateway must fail fast: 10 s, one retry for reads.
    this._records ??= sethuClient({
      url: this.url, token: this.token, fetchImpl: this.fetchImpl, allowHttp: this.allowHttp,
      timeoutMs: 10_000, maxRetries: 1,
    }).collection(this.connectionId, this.collection);
    return this._records;
  }

  #key(coll, id) {
    return `${coll}:${Buffer.from(String(id)).toString('base64url')}`;
  }

  async get(coll, id) {
    try {
      const record = await this.records.get(this.#key(coll, id));
      return record?.data ? JSON.parse(record.data) : null;
    } catch (error) {
      if (hasStatus(error, 404)) return null;
      throw new Error(`sethucms_store_error:${failureOf(error)}`);
    }
  }

  // Reads every record of the collection, page by page, then filters.
  async list(coll, predicate = () => true) {
    const results = [];
    try {
      for await (const record of this.records.where(eq('coll', coll)).limit(500).iterate({ maxPages: 1000 })) {
        const doc = JSON.parse(record.data);
        if (predicate(doc)) results.push(doc);
      }
    } catch (error) {
      throw new Error(`sethucms_store_error:${failureOf(error)}`);
    }
    return results;
  }

  async put(coll, id, doc) {
    const key = this.#key(coll, id);
    const data = JSON.stringify(doc);
    try {
      await this.records.update(key, { data });
      return doc;
    } catch (error) {
      if (!hasStatus(error, 404)) throw new Error(`sethucms_store_error:${failureOf(error)}`);
    }
    try {
      await this.records.create({ id: key, coll, data });
    } catch (error) {
      throw new Error(`sethucms_store_error:${failureOf(error)}`);
    }
    return doc;
  }

  async del(coll, id) {
    try {
      await this.records.delete(this.#key(coll, id));
    } catch (error) {
      if (!hasStatus(error, 404)) throw new Error(`sethucms_store_error:${failureOf(error)}`);
    }
  }
}

/**
 * Picks the database: Firestore or Redis (serverless), SethuCMS when its store
 * token is set, otherwise the JSON file (one process).
 */
export async function createStore(config) {
  if (config.firestore.credentials) {
    return new FirestoreStore(config.firestore).load();
  }
  if (config.redis.url && config.redis.token) {
    return new RedisStore(config.redis).load();
  }
  if (config.sethuStore.token && config.sethuStore.url && config.sethuStore.connectionId) {
    return new SethuStore(config.sethuStore).load();
  }
  return new Store(config.dataFile).load();
}
