import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Small document store: collections of JSON documents keyed by id.
 * Persists to one JSON file with atomic writes. Pass ':memory:' for tests.
 * One process only; swap this class for a database to scale out.
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

  get(coll, id) {
    const doc = this.#coll(coll)[id];
    return doc ? structuredClone(doc) : null;
  }

  list(coll, predicate = () => true) {
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
