import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RedisStore, createStore } from '../src/store.js';

// A tiny in-memory stand-in for Upstash's REST API (hash commands only).
function fakeRedis() {
  const hashes = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer secret-token');
    const [command, key, field, value] = JSON.parse(init.body);
    calls.push(command);
    const hash = hashes.get(key) ?? new Map();
    let result = null;
    if (command === 'HGET') result = hash.get(field) ?? null;
    if (command === 'HSET') {
      hash.set(field, value);
      hashes.set(key, hash);
      result = 1;
    }
    if (command === 'HDEL') result = hash.delete(field) ? 1 : 0;
    if (command === 'HVALS') result = [...hash.values()];
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { fetchImpl, calls };
}

const redisConfig = { url: 'https://redis.test', token: 'secret-token' };

describe('RedisStore', () => {
  it('stores, lists and deletes documents per collection', async () => {
    const { fetchImpl } = fakeRedis();
    const store = new RedisStore({ ...redisConfig, fetchImpl });

    await store.put('users', 'a', { id: 'a', n: 1 });
    await store.put('users', 'b', { id: 'b', n: 2 });
    await store.put('orders', 'a', { id: 'a', total: 9 });

    assert.deepEqual(await store.get('users', 'a'), { id: 'a', n: 1 });
    assert.equal(await store.get('users', 'missing'), null);
    assert.deepEqual((await store.list('users', (u) => u.n > 1)).map((u) => u.id), ['b']);
    assert.equal((await store.list('orders')).length, 1);

    await store.del('users', 'a');
    assert.equal(await store.get('users', 'a'), null);
  });

  it('surfaces database errors instead of pretending the write worked', async () => {
    const store = new RedisStore({
      ...redisConfig,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    });
    await assert.rejects(() => store.put('users', 'a', {}), /redis_error:500:boom/);
  });

  it('createStore picks Redis when configured (also the KV_REST_API_* names)', async () => {
    const withRedis = loadConfig({ KV_REST_API_URL: 'https://r.test', KV_REST_API_TOKEN: 't' });
    assert.ok((await createStore(withRedis)) instanceof RedisStore);
    const without = loadConfig({ DESIGNWEAR_DATA_FILE: ':memory:' });
    assert.ok(!((await createStore(without)) instanceof RedisStore));
  });

  it('production on Vercel refuses to start without a database', () => {
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production', VERCEL: '1', DESIGNWEAR_JWT_SECRET: 'x'.repeat(40),
        ALLOWED_ORIGINS: 'https://a.test', MAIL_WEBHOOK_URL: 'https://m.test',
      }),
      /UPSTASH_REDIS_REST_URL/,
    );
  });

  it('serves the whole API from Redis: sign up on one instance, sign in on another', async () => {
    const { fetchImpl, calls } = fakeRedis();
    const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://shop.test' });
    config.rateLimitMultiplier = 1000;
    const catalog = { configured: true, products: async () => [], product: async () => null };
    const mailer = { send: async () => {} };
    const build = () => createApp({ config, store: new RedisStore({ ...redisConfig, fetchImpl }), catalog, ai: {}, mailer });

    async function request(app, method, path, body, token) {
      const server = createServer(app);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: body && JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      } finally {
        server.close();
      }
    }

    const instanceA = build();
    const instanceB = build(); // a different serverless instance, same database
    const credentials = { name: 'Ada', email: 'ada@example.com', password: 'password123' };

    assert.equal((await request(instanceA, 'POST', '/v1/auth/register', credentials)).status, 201);
    assert.equal((await request(instanceA, 'POST', '/v1/auth/register', credentials)).status, 409);

    const login = await request(instanceB, 'POST', '/v1/auth/login', credentials);
    assert.equal(login.status, 200);
    const me = await request(instanceA, 'GET', '/v1/me', undefined, login.body.token);
    assert.equal(me.body.user.email, 'ada@example.com');
    assert.ok(!calls.includes('HVALS'), 'account lookups use indexes, not full scans');
  });
});
