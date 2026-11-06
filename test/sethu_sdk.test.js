// The SethuCMS SDK against a real HTTP server on localhost (not a scripted fetch), so request
// shapes, redirects, retries and failures are the real thing.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { CmsCatalog } from '../src/catalog.js';
import { CmsOrderSync } from '../src/order_sync.js';
import { sethuClient } from '../src/sethu.js';

let server, url, hits, handler;
before(async () => {
  server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'] });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const setup = (fn) => { hits = []; handler = fn; };
const cfg = { connectionId: 'c1', token: 'tok' };

describe('catalog over real HTTP', () => {
  it('follows page.nextCursor with the Bearer token and reads every record', async () => {
    setup((req, res) => {
      const cursor = new URL(req.url, url).searchParams.get('cursor');
      if (!cursor) return json(res, 200, { data: [{ id: 'a', price: 1 }, { id: 'b', price: 2 }], page: { nextCursor: 'p2' } });
      json(res, 200, { data: [{ id: 'c', price: 3 }], page: { nextCursor: null } });
    });
    const catalog = new CmsCatalog({ url, ...cfg }, fetch, 0);
    assert.deepEqual((await catalog.products()).map((p) => p.id), ['a', 'b', 'c']);
    assert.ok(hits.every((h) => h.auth === 'Bearer tok'));
    assert.match(hits[0].url, /^\/v1\/connections\/c1\/collections\/products\/records\?/);
  });

  it('a catalog bigger than the page limit keeps what it read instead of failing', async () => {
    setup((req, res) => json(res, 200, { data: [{ id: `r${hits.length}`, price: 1 }], page: { nextCursor: `n${hits.length}` } }));
    const catalog = new CmsCatalog({ url, ...cfg }, fetch, 0);
    const products = await catalog.products();
    assert.equal(products.length, 20, 'stopped at 20 pages');
    assert.equal(hits.length, 20);
  });

  it('a collection that does not exist yet is empty (404), but a server error is not', async () => {
    setup((req, res) => json(res, 404, { error: { code: 'NOT_FOUND', message: 'no' } }));
    assert.deepEqual(await new CmsCatalog({ url, ...cfg }, fetch, 0).teams(), []);
    setup((req, res) => json(res, 500, { error: { code: 'INTERNAL', message: 'boom' } }));
    await assert.rejects(new CmsCatalog({ url, ...cfg }, fetch, 0).products(), /catalog_unavailable:500/);
  });

  it('says why when nobody answers, not just ":0"', async () => {
    const gone = new CmsCatalog({ url: 'http://127.0.0.1:1', ...cfg }, fetch, 0);
    await assert.rejects(gone.products(), /catalog_unavailable:CONNECTION_FAILED/);
  });
});

describe('order sync over real HTTP', () => {
  const sync = () => new CmsOrderSync({ url, ...cfg, collection: 'orders' }, fetch);

  it('customer-facing reads do not retry: a failing gateway is asked once', async () => {
    setup((req, res) => json(res, 503, { error: { code: 'CONNECTION_FAILED', message: 'down' } }));
    const started = Date.now();
    assert.equal(await sync().pull({ id: 'DW1', status: 'placed' }), null);
    assert.equal(hits.length, 1, 'no retries');
    assert.ok(Date.now() - started < 1500);
  });

  it('refuses to follow a redirect from the gateway', async () => {
    setup((req, res) => {
      if (req.url.startsWith('/elsewhere')) return json(res, 200, { data: { status: 'delivered' } });
      res.writeHead(302, { location: '/elsewhere' }).end();
    });
    assert.equal(await sync().pull({ id: 'DW1', status: 'placed' }), null);
    assert.ok(!hits.some((h) => h.url.startsWith('/elsewhere')), 'the redirect target was never requested');
  });

  it('writes carry the idempotency key, and a failure names its status', async () => {
    setup((req, res) => {
      req.resume();
      if (req.method === 'PATCH') return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no' } });
      json(res, 500, { error: { code: 'INTERNAL', message: 'boom' } });
    });
    const order = {
      id: 'DW9', createdAt: '2026-01-01T00:00:00Z', status: 'placed', lines: [{ title: 'T', size: 'M', quantity: 1 }],
      address: { phone: '1', line1: 'a', city: 'c', state: 's', pin: '411001' },
      subtotal: 1, tax: 0, total: 1, payment: { method: 'cod', status: 'pay_on_delivery' }, history: [],
    };
    await assert.rejects(sync().push(order, { name: 'A', email: 'a@x.com' }), /order_sync_failed:500/);
    assert.equal(hits[0].key, 'upd:DW9:0');
    assert.equal(hits[1].key, 'new:DW9');
  });
});

describe('gateway address rules', () => {
  it('refuses plain http to a non-local host unless it is allowed', () => {
    assert.throws(() => sethuClient({ url: 'http://cms.internal:3000', token: 't' }), /https/);
    assert.doesNotThrow(() => sethuClient({ url: 'http://cms.internal:3000', token: 't', allowHttp: true }));
    assert.doesNotThrow(() => sethuClient({ url: 'http://127.0.0.1:3000', token: 't' }));
  });

  it('the catalog reports a refused address by name', async () => {
    const catalog = new CmsCatalog({ url: 'http://cms.internal:3000', ...cfg }, fetch, 0);
    await assert.rejects(catalog.products(), /catalog_unavailable:TypeError/);
  });
});

describe('without the SDK installed', () => {
  it('still starts with the file store; only SethuCMS features say what is missing', async () => {
    const { mkdtempSync, cpSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    // A copy of src/ in a folder with no node_modules anywhere above it.
    const dir = mkdtempSync(join(tmpdir(), 'dw-nosdk-'));
    cpSync(new URL('../src', import.meta.url).pathname, join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const script = `
      const { Store } = await import('./src/store.js');
      const store = await new Store(':memory:').load();
      await store.put('x', '1', { id: '1' });
      console.log('store ok', (await store.get('x', '1')).id);
      const { sethuClient } = await import('./src/sethu.js');
      try { sethuClient({ url: 'https://cms.test', token: 't' }); } catch (e) { console.log(e.message); }`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /store ok 1/);
    assert.match(run.stdout, /Run `npm ci`/);
  });
});
