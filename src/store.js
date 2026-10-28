import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { dirname } from 'node:path';

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
    this.accessToken = null;
    this.accessExpires = 0;
  }

  async load() {
    return this;
  }

  // Service-account login: sign a short JWT, trade it for an access token, and
  // reuse that token until shortly before it expires.
  async #token() {
    if (this.accessToken && this.now() < this.accessExpires - 60_000) return this.accessToken;

    const issued = Math.floor(this.now() / 1000);
    const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issued,
      exp: issued + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.credentials.private_key)
      .toString('base64url');

    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new Error(`firestore_auth_error:${response.status}`);
    }
    this.accessToken = body.access_token;
    this.accessExpires = this.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async #call(method, url, body) {
    const response = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
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

/** Firestore or Redis when configured (serverless), otherwise the JSON file (one process). */
export async function createStore(config) {
  if (config.firestore.credentials) {
    return new FirestoreStore(config.firestore).load();
  }
  if (config.redis.url && config.redis.token) {
    return new RedisStore(config.redis).load();
  }
  return new Store(config.dataFile).load();
}
