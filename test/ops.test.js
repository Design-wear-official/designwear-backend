import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { AiProvider } from '../src/ai.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Store } from '../src/store.js';

const products = [{ id: 'p1', title: 'Tee', description: '', price: 500, imageUrl: null, stock: 9, tags: [], productType: 'T-Shirt' }];
const catalog = { configured: true, products: async () => products, product: async (id) => products.find((p) => p.id === id) ?? null };
const address = { label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };

let server, base, token, store, mails, lines, failMail;

before(async () => {
  mails = [];
  lines = [];
  failMail = 0;
  const config = loadConfig({
    DESIGNWEAR_JWT_SECRET: 'x'.repeat(40),
    ALLOWED_ORIGINS: 'https://shop.test',
    RAZORPAY_KEY_ID: 'rzp_test_x',
    RAZORPAY_KEY_SECRET: 'secret',
  });
  config.rateLimitMultiplier = 1000;
  config.mailRetryDelayMs = 1;
  config.fetch = async () => ({ ok: true, json: async () => ({ id: 'order_rzp1', amount: 59000, currency: 'INR' }) });
  store = await new Store(':memory:').load();
  const mailer = {
    send: async (to, subject, text) => {
      if (failMail > 0) {
        failMail -= 1;
        throw new Error('smtp down');
      }
      mails.push({ to, subject, text });
    },
  };
  const app = createApp({
    config,
    store,
    catalog,
    ai: new AiProvider(config),
    mailer,
    logger: createLogger({ sink: (l) => lines.push(JSON.parse(l)) }),
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/v1/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'password123' }, { auth: null })).body.token;
});
after(() => server.close());

async function call(method, path, body, { auth = token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

describe('health', () => {
  it('live is a plain ok; deep checks the database and mail setup', async () => {
    assert.deepEqual((await call('GET', '/v1/health/live', undefined, { auth: null })).body, { ok: true });
    assert.deepEqual((await call('GET', '/v1/health', undefined, { auth: null })).body, { ok: true });
    const deep = await call('GET', '/v1/health?deep=1', undefined, { auth: null });
    assert.equal(deep.status, 200);
    assert.equal(deep.body.checks.store, 'ok');
    assert.equal(deep.body.checks.mail, 'not_configured');
  });

  it('deep health answers 503 and names the failing part when the database is down', async () => {
    const real = store.get;
    store.get = async (c) => {
      if (c === 'health') throw new Error('db down');
      return real.apply(store, arguments);
    };
    try {
      const deep = await call('GET', '/v1/health?deep=1', undefined, { auth: null });
      assert.equal(deep.status, 503);
      assert.equal(deep.body.checks.store, 'failed');
      assert.ok(!JSON.stringify(deep.body).includes('db down'), 'the reason stays out of the response');
    } finally {
      store.get = real;
    }
  });
});

describe('request ids and headers', () => {
  it('keeps a safe incoming id, replaces an unsafe one, and sends security headers', async () => {
    const kept = await call('GET', '/v1/health/live', undefined, { auth: null, headers: { 'x-request-id': 'app-12345678' } });
    assert.equal(kept.headers.get('x-request-id'), 'app-12345678');
    assert.ok(lines.some((l) => l.type === 'request' && l.id === 'app-12345678'));

    const replaced = await call('GET', '/v1/health/live', undefined, { auth: null, headers: { 'x-request-id': 'bad id\twith spaces' } });
    assert.notEqual(replaced.headers.get('x-request-id'), 'bad id\twith spaces');
    assert.match(kept.headers.get('strict-transport-security'), /max-age/);
    assert.equal(kept.headers.get('x-frame-options'), 'DENY');
  });
});

describe('logger levels', () => {
  it('drops request lines below the chosen level and tags 4xx and 5xx', () => {
    const out = [];
    const log = createLogger({ sink: (l) => out.push(JSON.parse(l)), level: 'warning' });
    log.request({ status: 200 });
    log.request({ status: 404 });
    log.request({ status: 500 });
    assert.deepEqual(out.map((l) => l.level), ['warning', 'error']);
  });
});

describe('payments, outbox and audit', () => {
  async function onlineOrder() {
    const order = (await call('POST', '/v1/orders', { address, paymentMethod: 'razorpay', lines: [{ productId: 'p1', size: 'M', quantity: 1 }] })).body.order;
    await call('POST', '/v1/payments/razorpay/order', { orderId: order.id });
    return order;
  }
  const sign = (rzpOrder, paymentId) => createHmac('sha256', 'secret').update(`${rzpOrder}|${paymentId}`).digest('hex');

  it('verifying a payment twice places and mails the order once, and writes audit rows', async () => {
    const order = await onlineOrder();
    const before = mails.length;
    const body = { orderId: order.id, paymentId: 'pay_1', signature: sign('order_rzp1', 'pay_1') };
    const first = await call('POST', '/v1/payments/razorpay/verify', body);
    const second = await call('POST', '/v1/payments/razorpay/verify', body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.order.status, 'placed');
    assert.equal(mails.length - before, 1, 'one receipt');

    const audit = await store.list('audit', (a) => a.target === order.id);
    assert.deepEqual(audit.map((a) => a.action).sort(), ['order.created', 'payment.verified']);
  });

  it('a mail that keeps failing is retried, never blocks the order, and is recorded as failed', async () => {
    failMail = 99;
    const order = (await call('POST', '/v1/orders', { address, paymentMethod: 'cod', lines: [{ productId: 'p1', size: 'M', quantity: 1 }] }));
    failMail = 0;
    assert.equal(order.status, 201);
    const rows = await store.list('outbox', (o) => o.orderId === order.body.order.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].attempts, 3);
    assert.equal(rows[0].to, 'a***@example.com');
    assert.match(rows[0].error, /smtp down/);
  });

  it('a mail that fails once is retried and succeeds', async () => {
    failMail = 1;
    const order = await call('POST', '/v1/orders', { address, paymentMethod: 'cod', lines: [{ productId: 'p1', size: 'M', quantity: 1 }] });
    const rows = await store.list('outbox', (o) => o.orderId === order.body.order.id);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].attempts, 2);
  });
});

describe('sign-in lockout', () => {
  const login = (email, password) => call('POST', '/v1/auth/login', { email, password }, { auth: null });
  const register = (email) => call('POST', '/v1/auth/register', { name: 'T', email, password: 'password123' }, { auth: null });

  it('five wrong passwords pause that account, even for the right password, and say nothing about whether it exists', async () => {
    await register('lock@example.com');
    for (let i = 0; i < 5; i += 1) assert.equal((await login('lock@example.com', 'nope-nope')).status, 401);
    const blocked = await login('lock@example.com', 'password123');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'locked');
    assert.equal((await login('other@example.com', 'password123')).status, 401, 'other accounts are unaffected');

    for (let i = 0; i < 5; i += 1) await login('ghost@example.com', 'nope-nope');
    assert.equal((await login('ghost@example.com', 'nope-nope')).status, 429, 'unknown emails lock the same way');

    const audit = await store.list('audit', (a) => a.action === 'auth.locked');
    assert.ok(audit.length >= 2);
    assert.ok(!JSON.stringify(audit).includes('lock@example.com'), 'no email in the audit log');
  });

  it('a correct sign-in clears the count', async () => {
    await register('reset@example.com');
    for (let i = 0; i < 4; i += 1) await login('reset@example.com', 'nope-nope');
    assert.equal((await login('reset@example.com', 'password123')).status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await login('reset@example.com', 'nope-nope')).status, 401);
    assert.equal((await login('reset@example.com', 'password123')).status, 200);
  });
});
