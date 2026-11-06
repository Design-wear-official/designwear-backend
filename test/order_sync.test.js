import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CmsOrderSync } from '../src/order_sync.js';
import { Store } from '../src/store.js';
import { asGateway } from './gateway_fake.js';

const address = { label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };
const products = [{ id: 'p1', title: 'Graphic Tee', price: 500, imageUrl: null, stock: 9, tags: [], productType: 'T-Shirt', description: '' }];

// A stand-in SethuCMS `orders` collection.
function fakeCms({ down = false } = {}) {
  const records = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.split('/records')[1]?.slice(1) ?? '');
    const method = init.method ?? 'GET';
    calls.push({ method, id, key: init.headers?.['idempotency-key'], auth: init.headers?.authorization });
    if (down) return { ok: false, status: 503, json: async () => ({}) };
    if (method === 'GET') return records.has(id) ? { ok: true, status: 200, json: async () => ({ data: records.get(id) }) } : { ok: false, status: 404, json: async () => ({}) };
    if (method === 'PATCH') {
      if (!records.has(id)) return { ok: false, status: 404, json: async () => ({}) };
      records.set(id, { ...records.get(id), ...JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const body = JSON.parse(init.body);
    records.set(body.id, body);
    return { ok: true, status: 201, json: async () => ({}) };
  };
  return { fetchImpl, records, calls };
}

let server, base, cms, token;
const mails = [];

async function start(cmsFake) {
  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40) });
  config.rateLimitMultiplier = 1000;
  const orderSync = new CmsOrderSync({ url: 'https://cms.test', connectionId: 'c1', token: 'write-token' }, asGateway(cmsFake.fetchImpl));
  const app = createApp({
    config, orderSync,
    store: await new Store(':memory:').load(),
    catalog: { configured: true, products: async () => products, product: async (id) => products.find((p) => p.id === id) ?? null },
    ai: {}, mailer: { send: async (...m) => mails.push(m) },
  });
  const s = createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, path, body, tok) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const signup = await call('POST', '/v1/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  return { s, call, token: signup.body.token };
}

describe('order sync to SethuCMS', () => {
  let shop;
  before(async () => { cms = fakeCms(); shop = await start(cms); });
  after(() => shop.s.close());

  it('copies a placed order into the collection with the exact fields', async () => {
    const placed = await shop.call('POST', '/v1/orders', { address, lines: [{ productId: 'p1', size: 'M', quantity: 2 }] }, shop.token);
    assert.equal(placed.status, 201);
    const record = cms.records.get(placed.body.order.id);
    assert.equal(record.status, 'placed');
    assert.equal(record.customerEmail, 'ada@example.com');
    assert.equal(record.total, 1180);
    assert.equal(record.itemCount, 2);
    assert.equal(record.items, 'Graphic Tee (M) x2');
    assert.equal(record.pin, '411001');
    assert.ok(cms.calls.every((c) => c.auth === 'Bearer write-token'));
    assert.equal(cms.calls.find((c) => c.method === 'POST').key, `new:${record.id}`);
  });

  it('a customer cancel updates the same record', async () => {
    const placed = await shop.call('POST', '/v1/orders', { address, lines: [{ productId: 'p1', size: 'L', quantity: 1 }] }, shop.token);
    await shop.call('POST', `/v1/orders/${placed.body.order.id}/cancel`, undefined, shop.token);
    assert.equal(cms.records.get(placed.body.order.id).status, 'cancelled');
  });

  it("status and tracking set in SethuCMS show up on the customer's order", async () => {
    const placed = await shop.call('POST', '/v1/orders', { address, lines: [{ productId: 'p1', size: 'S', quantity: 1 }] }, shop.token);
    const id = placed.body.order.id;
    Object.assign(cms.records.get(id), { status: 'shipped', trackingId: 'TRK9', carrier: 'Delhivery' });

    const mine = await shop.call('GET', '/v1/orders', undefined, shop.token);
    const order = mine.body.orders.find((o) => o.id === id);
    assert.equal(order.status, 'shipped');
    assert.deepEqual(order.tracking, { id: 'TRK9', carrier: 'Delhivery' });
    assert.deepEqual(order.history.map((h) => h.status), ['placed', 'shipped']);

    // Delivered is final: SethuCMS cannot pull it back to an earlier step.
    Object.assign(cms.records.get(id), { status: 'delivered' });
    await shop.call('GET', '/v1/orders', undefined, shop.token);
    cms.records.get(id).status = 'placed';
    const again = await shop.call('GET', '/v1/orders', undefined, shop.token);
    assert.equal(again.body.orders.find((o) => o.id === id).status, 'delivered');
  });
});

describe('when SethuCMS is unreachable', () => {
  it('still places the order for the customer', async () => {
    const shop = await start(fakeCms({ down: true }));
    try {
      const placed = await shop.call('POST', '/v1/orders', { address, lines: [{ productId: 'p1', size: 'M', quantity: 1 }] }, shop.token);
      assert.equal(placed.status, 201);
      assert.equal((await shop.call('GET', '/v1/orders', undefined, shop.token)).status, 200);
    } finally {
      shop.s.close();
    }
  });
});
