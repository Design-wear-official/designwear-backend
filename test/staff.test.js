import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { CmsCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const collections = {
  products: [{ id: 'p1', title: 'Graphic Tee', price: 500, stockCount: 99 }],
  teams: [
    { id: 't1', name: 'Pune Team', phone: '9000000001', pins: '411001' },
    { id: 't2', name: 'Delhi Team', phone: '9000000002', pins: '110001' },
  ],
  team_stock: [
    { teamId: 't1', productId: 'p1', quantity: 50 },
    { teamId: 't2', productId: 'p1', quantity: 50 },
  ],
};
const gateway = async (url) => {
  const name = new URL(url).pathname.split('/collections/')[1].split('/')[0];
  return collections[name]
    ? { ok: true, status: 200, json: async () => ({ data: collections[name], nextCursor: null }) }
    : { ok: false, status: 404, json: async () => ({}) };
};
const address = (pin) => ({ label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'X', state: 'MH', pin });
const ADMIN = 'a'.repeat(32);

let server, call;
before(async () => {
  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), DESIGNWEAR_ADMIN_TOKEN: ADMIN });
  config.rateLimitMultiplier = 1000;
  const catalog = new CmsCatalog({ url: 'https://cms.test', connectionId: 'c', token: 't' }, gateway, 0);
  const app = createApp({ config, store: await new Store(':memory:').load(), catalog, ai: {}, mailer: { send: async () => {} } });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
});
after(() => server.close());

async function person(name, staff) {
  const email = `${name}@example.com`;
  const r = await call('POST', '/v1/auth/register', { body: { name, email, password: 'password123' } });
  if (staff) {
    const s = await call('PUT', '/v1/admin/staff', { token: ADMIN, body: { email, ...staff } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }
  return r.body.token;
}

describe('staff', () => {
  let customer, pune, delhi, desk, courier, owner, orderId, otherId;
  before(async () => {
    customer = await person('cust');
    pune = await person('pune', { role: 'vendor', teamId: 't1' });
    delhi = await person('delhi', { role: 'vendor', teamId: 't2' });
    desk = await person('desk', { role: 'desk' });
    courier = await person('courier', { role: 'delivery' });
    owner = await person('owner', { role: 'owner' });
    const place = (pin) => call('POST', '/v1/orders', { token: customer, body: { address: address(pin), lines: [{ productId: 'p1', size: 'M', quantity: 1 }] } });
    orderId = (await place('411001')).body.order.id;
    otherId = (await place('110001')).body.order.id;
  });
  const move = (token, id, body) => call('POST', `/v1/staff/orders/${id}/status`, { token, body });

  it('only the owner can create staff, and customers are not staff', async () => {
    assert.equal((await call('PUT', '/v1/admin/staff', { token: customer, body: { email: 'cust@example.com', role: 'owner' } })).status, 401);
    assert.equal((await call('PUT', '/v1/admin/staff', { token: ADMIN, body: { email: 'cust@example.com', role: 'vendor' } })).status, 400, 'vendor needs a team');
    assert.equal((await call('GET', '/v1/staff/me', { token: customer })).status, 403);
    assert.equal((await call('GET', '/v1/staff/me')).status, 401);
    assert.equal((await call('GET', '/v1/staff/me', { token: pune })).body.staff.role, 'vendor');
  });

  it('a vendor sees only their own team’s orders', async () => {
    const mine = (await call('GET', '/v1/staff/orders', { token: pune })).body.orders.map((o) => o.id);
    assert.deepEqual(mine, [orderId]);
    assert.equal((await move(pune, otherId, { status: 'confirmed' })).status, 404, 'another team’s order does not exist for them');
    assert.equal((await call('GET', '/v1/staff/orders', { token: desk })).body.orders.length, 2);
  });

  it('follows the lifecycle: vendor confirms and packs, courier ships and delivers', async () => {
    assert.equal((await move(courier, orderId, { status: 'confirmed' })).status, 404, 'not packed yet, so not visible');
    assert.equal((await move(pune, orderId, { status: 'packed' })).status, 409, 'cannot skip confirm');
    assert.equal((await move(pune, orderId, { status: 'confirmed' })).body.order.status, 'confirmed');
    assert.equal((await move(pune, orderId, { status: 'packed' })).body.order.status, 'packed');
    assert.equal((await move(pune, orderId, { status: 'shipped' })).status, 409, 'vendors do not ship');
    assert.equal((await move(courier, orderId, { status: 'shipped' })).status, 400, 'needs a tracking id');
    const shipped = await move(courier, orderId, { status: 'shipped', trackingId: 'TRK1', carrier: 'Blue' });
    assert.equal(shipped.body.order.tracking.id, 'TRK1');
    const done = await move(courier, orderId, { status: 'delivered' });
    assert.equal(done.body.order.payment.status, 'collected');
    assert.equal(done.body.order.history.at(-1).role, 'delivery');
    assert.equal((await move(owner, orderId, { status: 'cancelled' })).status, 409, 'final');

    // The customer sees every step the staff took.
    const mine = (await call('GET', '/v1/orders', { token: customer })).body.orders.find((o) => o.id === orderId);
    assert.deepEqual(mine.history.map((h) => h.status), ['placed', 'confirmed', 'packed', 'shipped', 'delivered']);
    const inbox = await call('GET', '/v1/notifications', { token: customer });
    const types = JSON.stringify(inbox.body);
    for (const step of ['confirmed', 'packed', 'shipped', 'delivered']) assert.ok(types.includes(`order.${step}`), `no ${step} notification`);
  });

  it('the desk assigns a team and the owner sees the numbers', async () => {
    assert.equal((await call('POST', `/v1/staff/orders/${otherId}/assign`, { token: pune, body: { teamId: 't1' } })).status, 403);
    assert.equal((await call('POST', `/v1/staff/orders/${otherId}/assign`, { token: desk, body: { teamId: 'nope' } })).status, 400);
    const a = await call('POST', `/v1/staff/orders/${otherId}/assign`, { token: desk, body: { teamId: 't1' } });
    assert.equal(a.body.order.team.id, 't1');
    const s = (await call('GET', '/v1/staff/summary', { token: owner })).body;
    assert.equal(s.byStatus.delivered, 1);
    assert.equal(s.byStatus.placed, 1);
    assert.ok(s.sales > 0 && s.cashToCollect > 0);
    assert.equal((await call('GET', '/v1/staff/summary', { token: courier })).status, 403);
    assert.equal((await move(owner, otherId, { status: 'cancelled', note: 'customer called' })).body.order.status, 'cancelled');
  });
});
