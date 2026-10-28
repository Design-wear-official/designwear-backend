import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/** Redis when configured (serverless), otherwise the JSON file (one process). */
export async function createStore(config) {
  if (config.redis.url && config.redis.token) {
    return new RedisStore(config.redis).load();
  }
  return new Store(config.dataFile).load();
}
