import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { CmsCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const collections = {
  products: [{ id: 'p1', title: 'Graphic Tee', price: 500, stockCount: 99 }],
  teams: [{ id: 't1', name: 'Pune Team', phone: '9000000001', pins: '411001' }],
  team_stock: [{ id: 'row1', teamId: 't1', productId: 'p1', quantity: 3 }],
};
const writes = [];
const gateway = async (url, init = {}) => {
  const path = new URL(url).pathname.split('/collections/')[1].split('/');
  if (init.method === 'PATCH' || init.method === 'POST') {
    writes.push({ method: init.method, path: path.join('/'), body: JSON.parse(init.body), auth: init.headers.authorization });
    if (init.method === 'PATCH') collections[path[0]].find((r) => r.id === path[2]).quantity = JSON.parse(init.body).quantity;
    return { ok: true, status: 200, json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({ data: collections[path[0]], nextCursor: null }) };
};
const refunds = [];
const address = { label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };
const ADMIN = 'a'.repeat(32);

let server, call;
before(async () => {
  const config = loadConfig({
    DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), DESIGNWEAR_ADMIN_TOKEN: ADMIN, SETHUCMS_STOCK_TOKEN: 'stock-write',
    RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's',
  });
  config.rateLimitMultiplier = 1000;
  config.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/orders')) return { ok: true, json: async () => ({ id: 'rzp_order_1', amount: 0, currency: 'INR' }) };
    refunds.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: 'rfnd_1' }) };
  };
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
  if (staff) assert.equal((await call('PUT', '/v1/admin/staff', { token: ADMIN, body: { email, ...staff } })).status, 200);
  return r.body.token;
}

describe('returns, payouts and stock', () => {
  let customer, vendor, courier, desk, owner;
  before(async () => {
    customer = await person('cust');
    vendor = await person('vend', { role: 'vendor', teamId: 't1' });
    courier = await person('cour', { role: 'delivery' });
    desk = await person('desk', { role: 'desk' });
    owner = await person('own', { role: 'owner' });
  });
  const deliver = async () => {
    const id = (await call('POST', '/v1/orders', { token: customer, body: { address, lines: [{ productId: 'p1', size: 'M', quantity: 1 }] } })).body.order.id;
    const step = (token, body) => call('POST', `/v1/staff/orders/${id}/status`, { token, body });
    await step(vendor, { status: 'confirmed' }); await step(vendor, { status: 'packed' });
    await step(courier, { status: 'shipped', trackingId: 'T' }); await step(courier, { status: 'delivered' });
    return id;
  };

  it('a vendor sets their own team’s stock through the write token, and sees low stock', async () => {
    const before = (await call('GET', '/v1/staff/stock', { token: vendor })).body;
    assert.equal(before.stock[0].quantity, 3);
    assert.equal(before.stock[0].low, true);
    assert.equal((await call('PUT', '/v1/staff/stock', { token: vendor, body: { productId: 'p1', quantity: -1 } })).status, 400);
    const put = await call('PUT', '/v1/staff/stock', { token: vendor, body: { productId: 'p1', quantity: 40, teamId: 'someone-elses' } });
    assert.equal(put.body.teamId, 't1', 'a vendor cannot name another team');
    assert.deepEqual(writes.at(-1), { method: 'PATCH', path: 'team_stock/records/row1', body: { quantity: 40 }, auth: 'Bearer stock-write' });
    assert.equal((await call('GET', '/v1/staff/stock', { token: vendor })).body.stock[0].low, false);
    assert.equal((await call('GET', '/v1/staff/stock', { token: customer })).status, 403);
  });

  it('pays the vendor subtotal less commission, once', async () => {
    const id = await deliver();
    assert.equal((await call('GET', '/v1/staff/payouts', { token: vendor })).body.pending[0].payable, 425, '500 less 15%');
    assert.equal((await call('POST', '/v1/staff/payouts', { token: desk, body: { teamId: 't1' } })).status, 403);
    const paid = await call('POST', '/v1/staff/payouts', { token: owner, body: { teamId: 't1', reference: 'UTR1' } });
    assert.equal(paid.body.payout.amount, 425);
    assert.deepEqual(paid.body.payout.orderIds, [id]);
    assert.equal((await call('POST', '/v1/staff/payouts', { token: owner, body: { teamId: 't1' } })).status, 409, 'not twice');
    assert.equal((await call('GET', '/v1/staff/payouts', { token: vendor })).body.history.length, 1);
  });

  it('returns: request, approve, refund; and a paid-out order is clawed back from the next payout', async () => {
    const [first] = (await call('GET', '/v1/staff/orders?status=delivered', { token: owner })).body.orders;
    assert.equal((await call('POST', '/v1/orders/NOPE/return', { token: customer, body: { reason: 'too small' } })).status, 404);
    const req = await call('POST', `/v1/orders/${first.id}/return`, { token: customer, body: { reason: 'too small' } });
    assert.equal(req.status, 201);
    assert.equal((await call('POST', `/v1/orders/${first.id}/return`, { token: customer, body: { reason: 'again' } })).status, 409);
    const rid = req.body.return.id;
    assert.equal((await call('POST', `/v1/staff/returns/${rid}/refund`, { token: owner })).status, 409, 'must be approved first');
    assert.equal((await call('POST', `/v1/staff/returns/${rid}/decision`, { token: vendor, body: { decision: 'approve' } })).status, 403);
    assert.equal((await call('POST', `/v1/staff/returns/${rid}/decision`, { token: desk, body: { decision: 'approve' } })).body.return.status, 'approved');
    const done = await call('POST', `/v1/staff/returns/${rid}/refund`, { token: owner });
    assert.equal(done.body.return.status, 'refunded');
    assert.equal(done.body.return.refund.method, 'manual', 'cash on delivery is refunded by hand');

    await deliver(); // 425 earned, 425 clawed back for the refunded, already-settled order
    const pending = (await call('GET', '/v1/staff/payouts', { token: owner })).body.pending[0];
    assert.deepEqual([pending.earnings, pending.deductions, pending.payable], [425, 425, 0]);
  });

  it('refunds online payments through Razorpay, and a rejected return can be filed again', async () => {
    const placed = await call('POST', '/v1/orders', { token: customer, body: { paymentMethod: 'razorpay', address, lines: [{ productId: 'p1', size: 'M', quantity: 1 }] } });
    const id = placed.body.order.id;
    await call('POST', '/v1/payments/razorpay/order', { token: customer, body: { orderId: id } });
    const signature = createHmac('sha256', 's').update('rzp_order_1|pay_1').digest('hex');
    assert.equal((await call('POST', '/v1/payments/razorpay/verify', { token: customer, body: { orderId: id, paymentId: 'pay_1', signature } })).status, 200);
    const step = (token, body) => call('POST', `/v1/staff/orders/${id}/status`, { token, body });
    await step(vendor, { status: 'confirmed' }); await step(vendor, { status: 'packed' });
    await step(courier, { status: 'shipped', trackingId: 'T' }); await step(courier, { status: 'delivered' });

    const first = await call('POST', `/v1/orders/${id}/return`, { token: customer, body: { reason: 'wrong colour' } });
    await call('POST', `/v1/staff/returns/${first.body.return.id}/decision`, { token: desk, body: { decision: 'reject', note: 'worn' } });
    const second = await call('POST', `/v1/orders/${id}/return`, { token: customer, body: { reason: 'wrong colour, unworn' } });
    assert.equal(second.status, 201);
    await call('POST', `/v1/staff/returns/${second.body.return.id}/decision`, { token: desk, body: { decision: 'approve' } });
    const done = await call('POST', `/v1/staff/returns/${second.body.return.id}/refund`, { token: owner });
    assert.deepEqual(done.body.return.refund, { method: 'razorpay', id: 'rfnd_1' });
    assert.match(refunds.at(-1).url, /payments\/pay_1\/refund$/);
    assert.equal(refunds.at(-1).body.amount, Math.round(placed.body.order.total * 100), 'paise');
    assert.equal((await call('GET', '/v1/returns', { token: customer })).body.returns.filter((r) => r.orderId === id).length, 2);
  });
});
