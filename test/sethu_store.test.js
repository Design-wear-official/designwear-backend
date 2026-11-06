import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { CmsCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { SethuStore, createStore } from '../src/store.js';
import { asGateway } from './gateway_fake.js';

// A stand-in for the SethuCMS gateway holding one collection of records.
function fakeGateway({ pageSize = 500 } = {}) {
  const records = new Map();
  const seen = { auth: new Set(), keys: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    seen.auth.add(init.headers?.authorization);
    const method = init.method ?? 'GET';
    if (method !== 'GET') seen.keys.push(init.headers['idempotency-key']);
    const id = decodeURIComponent(u.pathname.split('/records')[1]?.slice(1) ?? '');
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (method === 'GET' && id) return records.has(id) ? json(200, { data: records.get(id) }) : json(404, {});
    if (method === 'GET') {
      const filter = JSON.parse(u.searchParams.get('filter'));
      const all = [...records.values()].filter((r) => r[filter.field] === filter.value);
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return json(200, { data: page, page: { nextCursor: next, limit: pageSize } });
    }
    if (method === 'PATCH') {
      if (!records.has(id)) return json(404, {});
      records.set(id, { ...records.get(id), ...JSON.parse(init.body) });
      return json(200, {});
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      records.set(body.id, body);
      return json(201, {});
    }
    if (method === 'DELETE') return records.delete(id) ? json(204, {}) : json(404, {});
  };
  return { fetchImpl, records, seen };
}

const settings = { url: 'https://cms.test', connectionId: 'c1', token: 'store-token' };

describe('SethuStore', () => {
  it('stores, lists (by collection, across pages) and deletes records', async () => {
    const { fetchImpl, records, seen } = fakeGateway({ pageSize: 2 });
    const store = new SethuStore(settings, asGateway(fetchImpl));

    for (let n = 1; n <= 5; n += 1) await store.put('users', `u_${n}`, { id: `u_${n}`, n });
    await store.put('emails', 'ada@example.com', { id: 'ada@example.com', userId: 'u_1' });
    await store.put('likes', 'd_1:u_1', { id: 'd_1:u_1' });
    await store.put('users', 'u_2', { id: 'u_2', n: 20 }); // overwrite

    assert.deepEqual(await store.get('users', 'u_2'), { id: 'u_2', n: 20 });
    assert.equal(await store.get('users', 'nobody'), null);
    assert.equal((await store.get('emails', 'ada@example.com')).userId, 'u_1');
    assert.ok(await store.get('likes', 'd_1:u_1'), 'ids with colons and dots work');
    assert.equal((await store.list('users')).length, 5, 'all pages are read');
    assert.deepEqual((await store.list('users', (u) => u.n > 4)).map((u) => u.id).sort(), ['u_2', 'u_5']);
    assert.equal((await store.list('emails')).length, 1, 'other collections are not mixed in');

    await store.del('users', 'u_1');
    assert.equal(await store.get('users', 'u_1'), null);
    await store.del('users', 'u_1'); // deleting twice is fine
    assert.equal(records.size, 6, 'one record per document');
    assert.deepEqual([...seen.auth], ['Bearer store-token']);
    assert.ok(seen.keys.every(Boolean) && new Set(seen.keys).size === seen.keys.length, 'every write has its own idempotency key');
  });

  it('reports a failing gateway instead of pretending the write worked', async () => {
    const store = new SethuStore(settings, asGateway(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await assert.rejects(() => store.put('users', 'a', {}), /sethucms_store_error:503/);
    await assert.rejects(() => store.list('users'), /sethucms_store_error:503/);
  });

  it('is chosen from SETHUCMS_STORE_TOKEN, and counts as a database on Vercel', async () => {
    const env = { SETHUCMS_URL: 'https://cms.test', SETHUCMS_CONNECTION_ID: 'c1', SETHUCMS_STORE_TOKEN: 't' };
    assert.ok((await createStore(loadConfig(env))) instanceof SethuStore);
    assert.doesNotThrow(() => loadConfig({
      ...env, NODE_ENV: 'production', VERCEL: '1', DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://a.test',
    }));
  });

  it('runs the whole API on SethuCMS alone: two instances share one database', async () => {
    const { fetchImpl } = fakeGateway();
    const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40) });
    config.rateLimitMultiplier = 1000;
    const catalog = { configured: true, products: async () => [], product: async () => null };
    const build = () => createApp({ config, store: new SethuStore(settings, asGateway(fetchImpl)), catalog, ai: {}, mailer: { send: async () => {} } });

    const request = async (app, method, path, body, token) => {
      const server = createServer(app);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: body && JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      } finally { server.close(); }
    };

    const a = build();
    const b = build();
    const credentials = { name: 'Ada', email: 'ada@example.com', password: 'password123' };
    assert.equal((await request(a, 'POST', '/v1/auth/register', credentials)).status, 201);
    assert.equal((await request(a, 'POST', '/v1/auth/register', credentials)).status, 409);
    const login = await request(b, 'POST', '/v1/auth/login', credentials);
    assert.equal(login.status, 200);
    assert.equal((await request(a, 'GET', '/v1/me', undefined, login.body.token)).body.user.email, 'ada@example.com');
  });
});

describe('catalog paging', () => {
  it('follows the gateway cursor (page.nextCursor) to read every product', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, title: `T${i}`, price: 100, stockCount: 1 }));
    const fetchImpl = async (url) => {
      const start = Number(new URL(url).searchParams.get('cursor') ?? 0);
      const next = start + 2 < all.length ? String(start + 2) : null;
      return { ok: true, status: 200, json: async () => ({ data: all.slice(start, start + 2), page: { nextCursor: next, limit: 2 } }) };
    };
    const catalog = new CmsCatalog({ url: 'https://cms.test', connectionId: 'c', token: 't' }, asGateway(fetchImpl), 0);
    assert.equal((await catalog.products()).length, 5);
  });
});
