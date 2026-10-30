import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CmsOrderSync } from '../src/order_sync.js';
import { FcmPush } from '../src/push.js';
import { Store } from '../src/store.js';

const SECRET = 'whsec_test_secret';
const address = { label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };
const products = [{ id: 'p1', title: 'Graphic Tee', price: 500, imageUrl: null, stock: 9, tags: [], productType: 'T-Shirt', description: '' }];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

let server, base, token, mails, records, pushed, deadTokens;

before(async () => {
  mails = [];
  records = new Map();
  pushed = [];
  deadTokens = new Set();

  // A stand-in SethuCMS `orders` collection.
  const cmsFetch = async (url, init = {}) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/records')[1]?.slice(1) ?? '');
    const method = init.method ?? 'GET';
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (method === 'GET') return records.has(id) ? json(200, { data: records.get(id) }) : json(404, {});
    if (method === 'PATCH') {
      if (!records.has(id)) return json(404, {});
      records.set(id, { ...records.get(id), ...JSON.parse(init.body) });
      return json(200, {});
    }
    const body = JSON.parse(init.body);
    records.set(body.id, body);
    return json(201, {});
  };

  // A stand-in for Google's token endpoint and FCM.
  const googleFetch = async (url, init = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).includes('oauth2.googleapis.com')) return json(200, { access_token: 'tok', expires_in: 3600 });
    const { message } = JSON.parse(init.body);
    if (deadTokens.has(message.token)) return json(404, {});
    pushed.push(message);
    return json(200, {});
  };

  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), SETHUCMS_WEBHOOK_SECRET: SECRET });
  config.rateLimitMultiplier = 1000;
  const app = createApp({
    config,
    store: await new Store(':memory:').load(),
    catalog: { configured: true, products: async () => products, product: async (id) => products.find((p) => p.id === id) ?? null },
    ai: {},
    mailer: { send: async (to, subject, text, options = {}) => mails.push({ to, subject, text, html: options.html }) },
    orderSync: new CmsOrderSync({ url: 'https://cms.test', connectionId: 'c1', token: 't' }, cmsFetch),
    push: new FcmPush({ credentials: { project_id: 'demo', client_email: 'svc@demo.iam.gserviceaccount.com', private_key: privateKey } }, googleFetch),
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/v1/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'password123' })).body.token;
});
after(() => server.close());

async function call(method, path, body, { auth = token, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    body: raw ?? (body && JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const place = async () => (await call('POST', '/v1/orders', { address, lines: [{ productId: 'p1', size: 'M', quantity: 1 }] })).body.order;
const signed = (payload, secret = SECRET, t = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(payload);
  return { raw, headers: { 'x-sethu-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` } };
};

describe('notifications', () => {
  it('placing an order lands in the inbox and in an email; reading clears the badge', async () => {
    const order = await place();
    const inbox = await call('GET', '/v1/notifications');
    assert.equal(inbox.body.items[0].title, 'Order placed');
    assert.equal(inbox.body.items[0].orderId, order.id);
    assert.equal(inbox.body.unread, 1);
    const receipt = mails.find((m) => m.to === 'ada@example.com' && m.subject.includes(`receipt for order #${order.id}`));
    assert.ok(receipt, 'the placed order is mailed as a receipt');
    assert.match(receipt.text, /Graphic Tee/);
    assert.match(receipt.text, /Total\s+Rs 590\.00/);
    assert.match(receipt.html, /Receipt INV-/);
    await call('POST', '/v1/notifications/read');
    assert.equal((await call('GET', '/v1/notifications')).body.unread, 0);
    assert.equal((await call('GET', '/v1/notifications', undefined, { auth: null })).status, 401);
  });

  it('the receipt can be sent again, only by the owner, and each send is recorded', async () => {
    const order = await place();
    const before = mails.length;
    const again = await call('POST', `/v1/orders/${order.id}/receipt`);
    assert.equal(again.status, 200);
    assert.equal(mails.length, before + 1);
    assert.match(mails.at(-1).subject, new RegExp(order.id));

    const other = (await call('POST', '/v1/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'password123' }, { auth: null })).body.token;
    assert.equal((await call('POST', `/v1/orders/${order.id}/receipt`, undefined, { auth: other })).status, 404);
    assert.equal((await call('POST', `/v1/orders/${order.id}/receipt`, undefined, { auth: null })).status, 401);
  });

  it('a status change made in SethuCMS notifies once, however often the order is read', async () => {
    const order = await place();
    records.get(order.id).status = 'shipped';
    Object.assign(records.get(order.id), { trackingId: 'TRK7', carrier: 'Delhivery' });
    await call('GET', '/v1/orders');
    await call('GET', '/v1/orders');
    const inbox = (await call('GET', '/v1/notifications')).body.items.filter((i) => i.orderId === order.id);
    assert.deepEqual(inbox.map((i) => i.title).sort(), ['Order on its way', 'Order placed']);
    assert.match(inbox.find((i) => i.title === 'Order on its way').body, /Delhivery TRK7/);
  });

  it('the SethuCMS webhook notifies straight away, and rejects forgeries', async () => {
    const order = await place();
    records.get(order.id).status = 'confirmed';
    const ok = signed({ type: 'record.updated', collection: 'orders', recordId: order.id });
    assert.equal((await call('POST', '/v1/hooks/sethucms', null, { auth: null, raw: ok.raw, headers: ok.headers })).status, 200);
    const titles = (await call('GET', '/v1/notifications')).body.items.filter((i) => i.orderId === order.id).map((i) => i.title);
    assert.ok(titles.includes('Order confirmed'));

    const forged = signed({ type: 'record.updated', collection: 'orders', recordId: order.id }, 'whsec_wrong');
    assert.equal((await call('POST', '/v1/hooks/sethucms', null, { auth: null, raw: forged.raw, headers: forged.headers })).status, 401);
    const stale = signed({ type: 'record.updated', collection: 'orders', recordId: order.id }, SECRET, 1000);
    assert.equal((await call('POST', '/v1/hooks/sethucms', null, { auth: null, raw: stale.raw, headers: stale.headers })).status, 401);
    const other = signed({ type: 'record.updated', collection: 'articles', recordId: 'x' });
    assert.equal((await call('POST', '/v1/hooks/sethucms', null, { auth: null, raw: other.raw, headers: other.headers })).status, 200);
  });

  it('pushes to registered phones, and forgets tokens Firebase no longer knows', async () => {
    assert.equal((await call('POST', '/v1/me/devices', { token: 'phone-a', platform: 'android' })).status, 200);
    await call('POST', '/v1/me/devices', { token: 'phone-dead', platform: 'android' });
    deadTokens.add('phone-dead');
    pushed.length = 0;

    const order = await place();
    const sent = pushed.filter((m) => m.token === 'phone-a');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].notification.title, 'Order placed');
    assert.equal(sent[0].data.orderId, order.id);

    pushed.length = 0;
    await place();
    assert.equal(pushed.filter((m) => m.token === 'phone-dead').length, 0, 'the dead token was dropped');

    await call('DELETE', '/v1/me/devices', { token: 'phone-a' });
    pushed.length = 0;
    await place();
    assert.equal(pushed.length, 0, 'a removed device gets nothing');
  });
});

describe('without a webhook secret', () => {
  it('the webhook route does not exist', async () => {
    const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40) });
    const app = createApp({ config, store: await new Store(':memory:').load(), catalog: {}, ai: {}, mailer: {} });
    const s = createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/v1/hooks/sethucms`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 404);
    } finally {
      s.close();
    }
  });
});
