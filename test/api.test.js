import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { AiProvider } from '../src/ai.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { signToken, verifyToken } from '../src/security.js';

const products = [
  { id: 'p1', title: 'Graphic Tee', description: 'cotton tee', price: 500, imageUrl: 'https://img.test/a.png', stock: 5, tags: ['summer'], productType: 'T-Shirt' },
  { id: 'p2', title: 'Hoodie', description: 'warm', price: 1200, imageUrl: null, stock: 0, tags: [], productType: 'Hoodie' },
];
const catalog = {
  configured: true,
  products: async () => products,
  product: async (id) => products.find((p) => p.id === id) ?? null,
};
const mails = [];
const mailer = { send: async (to, subject, text) => mails.push({ to, subject, text }) };

let server, base, config;

before(async () => {
  config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://shop.test' });
  const aiCalls = [];
  const ai = new AiProvider(config, async (url, init) => {
    aiCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Try navy.' }] } }] }) };
  });
  ai.gemini.apiKey = 'k';
  globalThis.__aiCalls = aiCalls;
  // Generous limits so many test users can sign up from one address; the
  // limiter itself is exercised separately below.
  config.rateLimitMultiplier = 1000;
  const app = createApp({ config, store: await new Store(':memory:').load(), catalog, ai, mailer });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signUp(name, email = `${name.toLowerCase()}@example.com`) {
  const r = await call('POST', '/v1/auth/register', { body: { name, email, password: 'password123' } });
  assert.equal(r.status, 201);
  return r.body.token;
}

const address = { label: 'Home', name: 'Asha', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };

describe('auth', () => {
  it('registers, logs in, rejects bad credentials and duplicates', async () => {
    const t = await signUp('Asha');
    assert.equal((await call('GET', '/v1/me', { token: t })).body.user.email, 'asha@example.com');
    assert.equal((await call('POST', '/v1/auth/register', { body: { name: 'A', email: 'ASHA@example.com', password: 'password123' } })).status, 409);
    assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'asha@example.com', password: 'wrong-pass' } })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-pass' } })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'asha@example.com', password: 'password123' } })).status, 200);
    assert.equal((await call('POST', '/v1/auth/register', { body: { name: 'B', email: 'b@example.com', password: 'short' } })).status, 400);
  });

  it('rejects missing, tampered and alg=none tokens', async () => {
    assert.equal((await call('GET', '/v1/me')).status, 401);
    const t = await signUp('Tamper');
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'u_other' })).toString('base64url');
    assert.equal((await call('GET', '/v1/me', { token: `${h}.${forged}.${s}` })).status, 401);
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    assert.equal((await call('GET', '/v1/me', { token: `${none}.${p}.` })).status, 401);
    assert.equal(verifyToken(signToken({ sub: 'x' }, 'k'.repeat(32), -10_000_000), 'k'.repeat(32)), null);
  });

  it('password reset: code works once, old sessions die, no account enumeration', async () => {
    const old = await signUp('Reset');
    assert.equal((await call('POST', '/v1/auth/password-reset/request', { body: { email: 'ghost@example.com' } })).status, 202);
    assert.equal(mails.filter((m) => m.to === 'ghost@example.com').length, 0);
    assert.equal((await call('POST', '/v1/auth/password-reset/request', { body: { email: 'reset@example.com' } })).status, 202);
    const code = /\d{6}/.exec(mails.at(-1).text)[0];
    const bad = await call('POST', '/v1/auth/password-reset/confirm', { body: { email: 'reset@example.com', code: '000000', password: 'newpassword1' } });
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/v1/auth/password-reset/confirm', { body: { email: 'reset@example.com', code, password: 'newpassword1' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/v1/me', { token: old })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { body: { email: 'reset@example.com', password: 'newpassword1' } })).status, 200);
    assert.equal((await call('POST', '/v1/auth/password-reset/confirm', { body: { email: 'reset@example.com', code, password: 'another12345' } })).status, 400);
  });
});

describe('orders', () => {
  it('prices on the server and ignores client prices', async () => {
    const t = await signUp('Buyer');
    const r = await call('POST', '/v1/orders', {
      token: t,
      body: { address, lines: [{ productId: 'p1', size: 'M', quantity: 2, unitPrice: 1 }] },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.order.subtotal, 1000);
    assert.equal(r.body.order.tax, 180);
    assert.equal(r.body.order.total, 1180);
    assert.equal((await call('GET', '/v1/orders', { token: t })).body.orders.length, 1);
  });

  it('rejects out of stock, unknown products, bad sizes and bad addresses', async () => {
    const t = await signUp('Picky');
    const order = (lines, addr = address) => call('POST', '/v1/orders', { token: t, body: { address: addr, lines } });
    assert.equal((await order([{ productId: 'p2', size: 'M', quantity: 1 }])).body.error.code, 'out_of_stock');
    assert.equal((await order([{ productId: 'nope', size: 'M', quantity: 1 }])).body.error.code, 'unknown_product');
    assert.equal((await order([{ productId: 'p1', size: 'HUGE', quantity: 1 }])).body.error.code, 'invalid_size');
    assert.equal((await order([{ productId: 'p1', size: 'M', quantity: 0 }])).status, 400);
    assert.equal((await order([{ productId: 'p1', size: 'M', quantity: 1 }], { ...address, pin: '12' })).status, 400);
  });

  it("users can't see or cancel each other's orders; owner can cancel once", async () => {
    const a = await signUp('Owner');
    const b = await signUp('Other');
    const o = (await call('POST', '/v1/orders', { token: a, body: { address, lines: [{ productId: 'p1', size: 'S', quantity: 1 }] } })).body.order;
    assert.equal((await call('GET', '/v1/orders', { token: b })).body.orders.length, 0);
    assert.equal((await call('POST', `/v1/orders/${o.id}/cancel`, { token: b })).status, 404);
    assert.equal((await call('POST', `/v1/orders/${o.id}/cancel`, { token: a })).status, 200);
    assert.equal((await call('POST', `/v1/orders/${o.id}/cancel`, { token: a })).status, 409);
  });

  it('online payments are refused when not configured', async () => {
    const t = await signUp('Online');
    const r = await call('POST', '/v1/orders', { token: t, body: { address, paymentMethod: 'razorpay', lines: [{ productId: 'p1', size: 'M', quantity: 1 }] } });
    assert.equal(r.body.error.code, 'payments_unavailable');
  });
});

describe('community designs', () => {
  const design = (extra = {}) => ({
    name: 'Sunrise', garment: 'T-Shirt', baseColor: 0xff2c5f5a, published: true,
    front: [{ id: 'e1', type: 'text', content: 'Hello', x: 0.5, y: 0.5, size: 40, color: 0xff000000 }], back: [], ...extra,
  });

  it('publishes, lists publicly, hides drafts, likes and remixes with lineage', async () => {
    const a = await signUp('Creator');
    const b = await signUp('Remixer');
    const pub = (await call('POST', '/v1/designs', { token: a, body: design() })).body.design;
    const draft = (await call('POST', '/v1/designs', { token: a, body: design({ name: 'Secret', published: false }) })).body.design;
    const feed = (await call('GET', '/v1/designs')).body.designs;
    assert.ok(feed.some((d) => d.id === pub.id));
    assert.ok(!feed.some((d) => d.id === draft.id));
    assert.equal((await call('GET', `/v1/designs/${draft.id}`, { token: b })).status, 404);
    assert.equal((await call('GET', `/v1/designs/${draft.id}`, { token: a })).status, 200);

    const like = await call('POST', `/v1/designs/${pub.id}/like`, { token: b });
    assert.deepEqual([like.body.liked, like.body.likeCount], [true, 1]);
    assert.equal((await call('POST', `/v1/designs/${pub.id}/like`, { token: b })).body.likeCount, 0);

    const remix = (await call('POST', '/v1/designs', { token: b, body: design({ name: 'Remix', remixOf: pub.id }) })).body.design;
    assert.equal(remix.remixedFrom.id, pub.id);
    assert.equal(remix.lineage.length, 1);
    assert.equal((await call('GET', `/v1/designs/${pub.id}`)).body.design.remixCount, 1);
  });

  it("can't edit or delete someone else's design; validates content", async () => {
    const a = await signUp('Maker');
    const b = await signUp('Intruder');
    const d = (await call('POST', '/v1/designs', { token: a, body: design() })).body.design;
    assert.equal((await call('POST', '/v1/designs', { token: b, body: { ...design(), id: d.id } })).status, 403);
    assert.equal((await call('DELETE', `/v1/designs/${d.id}`, { token: b })).status, 404);
    assert.equal((await call('POST', '/v1/designs', { token: a, body: design({ garment: 'Cape' }) })).status, 400);
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, type: 'text', content: 'x' }));
    assert.equal((await call('POST', '/v1/designs', { token: a, body: design({ front: many }) })).status, 400);
  });

  it('prices a design line from the garment table, only for owner or published', async () => {
    const a = await signUp('Seller');
    const b = await signUp('Shopper');
    const d = (await call('POST', '/v1/designs', { token: a, body: design({ garment: 'Hoodie', published: false }) })).body.design;
    const line = [{ productId: `design:${d.id}`, designId: d.id, size: 'L', quantity: 1 }];
    assert.equal((await call('POST', '/v1/orders', { token: b, body: { address, lines: line } })).body.error.code, 'unknown_design');
    assert.equal((await call('POST', '/v1/orders', { token: a, body: { address, lines: line } })).body.order.subtotal, 999);
  });
});

describe('cart', () => {
  it('stores the cart per user with server titles and prices, drops unavailable designs', async () => {
    const a = await signUp('Carter');
    const b = await signUp('Stranger');
    const d = (await call('POST', '/v1/designs', { token: a, body: { name: 'Mine', garment: 'Hoodie', front: [] } })).body.design;
    const put = await call('PUT', '/v1/cart', {
      token: a,
      body: { lines: [
        { productId: 'p1', size: 'M', quantity: 2, unitPrice: 1 },
        { productId: `design:${d.id}`, designId: d.id, size: 'L', quantity: 1 },
      ] },
    });
    assert.deepEqual(put.body.lines.map((l) => [l.title, l.unitPrice]), [['Graphic Tee', 500], ['Mine (Hoodie)', 999]]);
    assert.equal((await call('GET', '/v1/cart', { token: a })).body.lines.length, 2);
    assert.equal((await call('GET', '/v1/cart', { token: b })).body.lines.length, 0);
    const other = await call('PUT', '/v1/cart', { token: b, body: { lines: [{ productId: `design:${d.id}`, designId: d.id, size: 'L', quantity: 1 }] } });
    assert.equal(other.body.lines.length, 0);
  });
});

describe('search, ai, config and hygiene', () => {
  it('serves the public catalog (raw records, sellable only) with a limit', async () => {
    const list = await call('GET', '/v1/products');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((p) => p.id), ['p1', 'p2']);
    assert.equal((await call('GET', '/v1/products?limit=1')).body.data.length, 1);
    assert.equal((await call('GET', '/v1/products/p1')).body.data.id, 'p1');
    assert.equal((await call('GET', '/v1/products/nope')).status, 404);
  });

  it('ranks title matches first and filters stock', async () => {
    const r = (await call('GET', '/v1/search?q=hoodie')).body.results;
    assert.equal(r[0].id, 'p2');
    assert.equal((await call('GET', '/v1/search?q=hoodie&inStock=1')).body.results.length, 0);
    assert.equal((await call('GET', '/v1/search?q=summer')).body.results[0].id, 'p1');
  });

  it('chat requires sign-in and returns the reply; try-on reports unavailable', async () => {
    assert.equal((await call('POST', '/v1/ai/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401);
    const t = await signUp('Chatty');
    assert.equal((await call('POST', '/v1/ai/chat', { token: t, body: { messages: [{ role: 'user', content: 'what colour?' }] } })).body.reply, 'Try navy.');
    const sent = globalThis.__aiCalls.at(-1);
    assert.match(sent.url, /models\/gemini-4-argon:generateContent$/);
    assert.equal(sent.body.contents[0].role, 'user');
    assert.ok(sent.body.systemInstruction);
    const photo = Buffer.alloc(200, 1).toString('base64');
    // Photo is not a real image, so the server rejects it before calling the model.
    assert.equal((await call('POST', '/v1/ai/try-on', { token: t, body: { photo, productId: 'p1' } })).status, 400);
    const cfg = (await call('GET', '/v1/config')).body;
    assert.deepEqual([cfg.chat, cfg.tryOn, cfg.onlinePayments], [true, true, false]);
  });

  it('cors allow-list, 404/405, bad json, security headers', async () => {
    const ok = await call('GET', '/v1/health', { headers: { origin: 'https://shop.test' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.test');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const evil = await call('GET', '/v1/health', { headers: { origin: 'https://evil.test' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    // Development: any localhost port is fine (a browser dev server). Production: never.
    const local = await call('GET', '/v1/health', { headers: { origin: 'http://localhost:8080' } });
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    const prod = createApp({ config: { ...config, production: true }, store: await new Store(':memory:').load(), catalog, ai: new AiProvider(config), mailer });
    const ps = createServer(prod);
    await new Promise((r) => ps.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${ps.address().port}/v1/health`, { headers: { origin: 'http://localhost:8080' } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally { ps.close(); }
    assert.equal((await call('GET', '/v1/nothing')).status, 404);
    assert.equal((await call('DELETE', '/v1/health')).status, 405);
    const res = await fetch(base + '/v1/auth/login', { method: 'POST', body: '{nope' });
    assert.equal(res.status, 400);
  });

  it('rate limits repeated login attempts', async () => {
    const strict = createApp({
      config: { ...config, rateLimitMultiplier: 1 },
      store: await new Store(':memory:').load(), catalog, ai: new AiProvider(config), mailer,
    });
    const s = createServer(strict);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      let last;
      for (let i = 0; i < 12; i++) {
        last = await fetch(`http://127.0.0.1:${s.address().port}/v1/auth/login`, {
          method: 'POST',
          body: JSON.stringify({ email: 'flood@example.com', password: 'wrongwrong' }),
        });
      }
      assert.equal(last.status, 429);
    } finally {
      s.close();
    }
  });
});

describe('catalog filtering', () => {
  it('drops remixes and unpriced entries so they can be neither listed nor ordered', async () => {
    const { CmsCatalog } = await import('../src/catalog.js');
    const cat = new CmsCatalog({ url: 'https://c.test', connectionId: 'c', token: 't' }, async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'ok', title: 'T-shirt', price: 10, stockCount: 3 },
          { id: 'r1', title: 'Remix by @user', price: 499 },
          { id: 'r2', title: 'Fork', price: 499, remixedFromHandle: 'asha' },
          { id: 'z', title: 'Midnight', price: 0 },
          { id: 'credit', title: 'Original', price: 5, creatorHandle: 'kasinadhsarma' },
        ],
        nextCursor: null,
      }),
    }));
    assert.deepEqual((await cat.products()).map((p) => p.id), ['ok', 'credit']);
    assert.equal(await cat.product('r1'), null);
  });
});

describe('performance guards', () => {
  it('coalesces store writes and shares one catalog refresh', async () => {
    const { CmsCatalog } = await import('../src/catalog.js');
    let fetches = 0;
    const cat = new CmsCatalog({ url: 'https://c.test', connectionId: 'c', token: 't' }, async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => ({ data: [{ id: 'a', title: 'A', price: 1 }], nextCursor: null }) };
    });
    await Promise.all([cat.products(), cat.products(), cat.products(), cat.product('a')]);
    assert.equal(fetches, 1);

    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(`${tmpdir()}/dw-`);
    const store = await new Store(`${dir}/s.json`).load();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.put('t', `k${i}`, { i })));
    assert.equal(Object.keys(JSON.parse(await readFile(`${dir}/s.json`, 'utf8')).t).length, 50);
  });
});

describe('logging', () => {
  it('accepts, caps and redacts client logs; request logs carry no secrets', async () => {
    const lines = [];
    const sink = (l) => lines.push(JSON.parse(l));
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ sink });
    const app = createApp({
      config: { ...config, rateLimitMultiplier: 1000 }, logger,
      store: await new Store(':memory:').load(), catalog, ai: new AiProvider(config), mailer,
    });
    const s = createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const post = (path, body, headers = {}) =>
      fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const reg = await (await post('/v1/auth/register', { name: 'L', email: 'log@example.com', password: 'password123' })).json();
      const res = await post('/v1/logs', {
        app: { version: '1.0.0', flavour: 'external', platform: 'android' },
        entries: [
          { level: 'error', message: `crash for log@example.com with Bearer ${reg.token} password=hunter2`, stack: 'at x', tag: 'zone' },
          { level: 'nonsense', message: 'x'.repeat(5000) },
        ],
      }, { authorization: `Bearer ${reg.token}` });
      assert.equal(res.status, 202);
      assert.equal(res.headers.get('x-request-id').length, 12);
      const client = lines.filter((l) => l.type === 'client');
      assert.equal(client.length, 2);
      assert.equal(client[0].userId, reg.user.id);
      assert.equal(client[1].level, 'info');
      assert.equal(client[1].message.length, 1000);
      const dump = JSON.stringify(lines);
      for (const secret of [reg.token, 'hunter2', 'log@example.com']) assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 8)}`);
      const reqLog = lines.find((l) => l.type === 'request' && l.path === '/v1/logs');
      assert.deepEqual([reqLog.method, reqLog.status], ['POST', 202]);
      assert.equal((await post('/v1/logs', { entries: [] })).status, 400);
    } finally {
      s.close();
    }
  });
});

describe('design studio', () => {
  it('stores the studio design blob and previews; rejects bad ones', async () => {
    const t = await signUp('Studio');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(60).fill(1)]).toString('base64');
    const studio = { baseColor: '0xFFFFFFFF', elements: [{ id: 'a', type: 'image', content: 'x'.repeat(100) }] };
    const ok = await call('POST', '/v1/designs', { token: t, body: { name: 'S', garment: 'tshirt', designJson: studio, previewImage: png, published: true } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.design.garment, 'T-Shirt', 'studio garment ids map to catalog names');
    assert.deepEqual(ok.body.design.designJson, studio);
    assert.equal(ok.body.design.previewImage, png);
    const got = await call('GET', `/v1/designs/${ok.body.design.id}`);
    assert.equal(got.body.design.previewImage, png);
    const post = (extra) => call('POST', '/v1/designs', { token: t, body: { name: 'S', garment: 'tshirt', ...extra } });
    assert.equal((await post({ designJson: { elements: Array(61).fill({}) } })).status, 400);
    assert.equal((await post({ designJson: { elements: [{ content: 'x'.repeat(450_000) }] } })).status, 400);
    assert.equal((await post({ previewImage: Buffer.from('not an image at all, just text').toString('base64') })).status, 400);
  });

  it('design assistant: auth, reply with an applied design, malformed edits ignored', async () => {
    assert.equal((await call('POST', '/v1/ai/design-agent', { body: { message: 'hi' } })).status, 401);
    const { createLogger } = await import('../src/logger.js');
    const replies = [
      'Here you go!\n```json\n{"design":{"baseColor":"0xFF000000","elements":[{"id":"e1","type":"text","content":"HI"}]}}\n```',
      'Sure.\n```json\n{"design": nope}\n```',
    ];
    const seen = [];
    const ai = new AiProvider(config, async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: replies.shift() }] } }] }) };
    });
    ai.gemini.apiKey = 'k';
    const app = createApp({
      config: { ...config, rateLimitMultiplier: 1000 }, logger: createLogger({ sink: () => {} }),
      store: await new Store(':memory:').load(), catalog, ai, mailer,
    });
    const s = createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const post = (path, body, token) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    try {
      const reg = await (await post('/v1/auth/register', { name: 'A', email: 'agent@example.com', password: 'password123' })).json();
      const r1 = await (await post('/v1/ai/design-agent', { message: 'black tee with HI', design: { elements: [] } }, reg.token)).json();
      assert.equal(r1.text, 'Here you go!');
      assert.equal(r1.design.elements[0].content, 'HI');
      assert.match(seen[0].systemInstruction.parts[0].text, /DesignBot/);
      assert.ok(!seen[0].systemInstruction.parts[0].text.includes('{{CURRENT_STATE}}'));
      const r2 = await (await post('/v1/ai/design-agent', { message: 'again' }, reg.token)).json();
      assert.equal(r2.design, null);
      assert.equal(r2.text, 'Sure.');
    } finally {
      s.close();
    }
  });
});

describe('weekly challenges', () => {
  it('admin creates a challenge; entries are counted and ranked; closed ones refuse entries', async () => {
    const { createLogger } = await import('../src/logger.js');
    let clock = Date.parse('2026-07-01T00:00:00Z');
    const app = createApp({
      config: { ...config, rateLimitMultiplier: 1000, adminToken: 'a'.repeat(32) },
      logger: createLogger({ sink: () => {} }), now: () => clock,
      store: await new Store(':memory:').load(), catalog, ai: new AiProvider(config), mailer,
    });
    const s = createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const api = async (method, path, { token, body } = {}) => {
      const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const challenge = { title: 'Monsoon', description: 'Remix a rain-ready tee', startsAt: '2026-06-29T00:00:00Z', endsAt: '2026-07-05T00:00:00Z' };
    try {
      assert.equal((await api('GET', '/v1/challenges/current')).body.challenge, null);
      assert.equal((await api('PUT', '/v1/admin/challenges/monsoon', { body: challenge })).status, 401);
      assert.equal((await api('PUT', '/v1/admin/challenges/monsoon', { token: 'wrong'.repeat(8), body: challenge })).status, 401);
      assert.equal((await api('PUT', '/v1/admin/challenges/Bad Id', { token: 'a'.repeat(32), body: challenge })).status, 400);
      assert.equal((await api('PUT', '/v1/admin/challenges/monsoon', { token: 'a'.repeat(32), body: { ...challenge, endsAt: '2026-06-01T00:00:00Z' } })).status, 400);
      assert.equal((await api('PUT', '/v1/admin/challenges/monsoon', { token: 'a'.repeat(32), body: challenge })).status, 200);

      const cur = (await api('GET', '/v1/challenges/current')).body.challenge;
      assert.deepEqual([cur.id, cur.title, cur.open, cur.entries], ['monsoon', 'Monsoon', true, 0]);

      const a = (await api('POST', '/v1/auth/register', { body: { name: 'Ann', email: 'ann@example.com', password: 'password123' } })).body.token;
      const b = (await api('POST', '/v1/auth/register', { body: { name: 'Bob', email: 'bob@example.com', password: 'password123' } })).body.token;
      const design = (name, extra = {}) => ({ name, garment: 'tshirt', designJson: { elements: [] }, published: true, challengeId: 'monsoon', ...extra });
      assert.equal((await api('POST', '/v1/designs', { token: a, body: design('Not published', { published: false }) })).status, 400);
      assert.equal((await api('POST', '/v1/designs', { token: a, body: design('X', { challengeId: 'nope' }) })).status, 400);
      const d1 = (await api('POST', '/v1/designs', { token: a, body: design('Rain') })).body.design;
      const d2 = (await api('POST', '/v1/designs', { token: b, body: design('Umbrella') })).body.design;
      assert.equal(d1.challengeId, 'monsoon');
      await api('POST', `/v1/designs/${d2.id}/like`, { token: a });

      const board = (await api('GET', '/v1/challenges/monsoon/entries')).body;
      assert.equal(board.challenge.entries, 2);
      assert.deepEqual(board.designs.map((d) => d.name), ['Umbrella', 'Rain'], 'most liked first');

      // Updating an entry keeps its challenge; ending the challenge closes it.
      assert.equal((await api('POST', '/v1/designs', { token: a, body: { ...design('Rain v2'), id: d1.id, challengeId: undefined } })).body.design.challengeId, 'monsoon');
      clock = Date.parse('2026-07-06T00:00:00Z');
      assert.equal((await api('GET', '/v1/challenges/current')).body.challenge, null);
      assert.equal((await api('POST', '/v1/designs', { token: a, body: design('Late') })).body.error.code, 'challenge_closed');
      assert.equal((await api('GET', '/v1/challenges/monsoon/entries')).body.challenge.open, false);
    } finally {
      s.close();
    }
  });

  it('admin routes do not exist without an admin token', async () => {
    assert.equal((await call('PUT', '/v1/admin/challenges/x', { body: {} })).status, 404);
  });
});

describe('google sign-in (Firebase ID tokens)', () => {
  const PROJECT = 'designwear-test';
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  function token({ key = pair.privateKey, kid = 'k1', alg = 'RS256', claims = {} } = {}) {
    const nowS = Math.floor(Date.now() / 1000);
    const c = {
      iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'fb-uid-1', iat: nowS - 10, exp: nowS + 3600,
      email: 'gina@example.com', email_verified: true, name: 'Gina G', firebase: { sign_in_provider: 'google.com' }, ...claims,
    };
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(c);
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  let s2;
  let url;
  let fetchCount = 0;
  before(async () => {
    const { createLogger } = await import('../src/logger.js');
    const verifierFetch = async () => {
      fetchCount++;
      return { ok: true, headers: new Headers({ 'cache-control': 'public, max-age=3600' }), json: async () => ({ k1: pub }) };
    };
    const { createFirebaseVerifier } = await import('../src/firebase_token.js');
    const cfg = { ...config, rateLimitMultiplier: 1000, firebaseProjectId: PROJECT };
    const app = createApp({
      config: cfg, logger: createLogger({ sink: () => {} }),
      firebase: createFirebaseVerifier({ projectId: PROJECT, fetchImpl: verifierFetch }),
      store: await new Store(':memory:').load(), catalog, ai: new AiProvider(config), mailer,
    });
    s2 = createServer(app);
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${s2.address().port}`;
  });
  after(() => s2.close());

  const google = async (idToken) => {
    const res = await fetch(`${url}/v1/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
    return { status: res.status, body: await res.json() };
  };

  it('creates an account from a valid token, then signs the same person back in', async () => {
    const first = await google(token());
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.user.email, first.body.user.name], ['gina@example.com', 'Gina G']);
    const again = await google(token());
    assert.equal(again.body.user.id, first.body.user.id);
    const me = await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${first.body.token}` } });
    assert.equal((await me.json()).user.email, 'gina@example.com');
    assert.equal(fetchCount, 1, 'signing keys are cached');
  });

  it('a Google-only account has no password to guess', async () => {
    const res = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gina@example.com', password: 'anything-at-all' }) });
    assert.equal(res.status, 401);
  });

  it('links to an existing password account with the same verified email', async () => {
    const reg = await (await fetch(`${url}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hal', email: 'hal@example.com', password: 'password123' }) })).json();
    const r = await google(token({ claims: { sub: 'fb-uid-2', email: 'hal@example.com', name: 'Hal H' } }));
    assert.equal(r.body.user.id, reg.user.id);
    // That email is now bound to uid-2; a different Google account can't take it over.
    assert.equal((await google(token({ claims: { sub: 'fb-uid-3', email: 'hal@example.com' } }))).status, 409);
  });

  it('rejects forged, expired, wrong-project, unverified and non-Google tokens', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const bad = {
      'signed by another key': token({ key: other.privateKey }),
      expired: token({ claims: { exp: nowS - 5 } }),
      'wrong audience': token({ claims: { aud: 'someone-else' } }),
      'wrong issuer': token({ claims: { iss: 'https://evil.example.com' } }),
      'email not verified': token({ claims: { email_verified: false } }),
      'not google': token({ claims: { firebase: { sign_in_provider: 'password' } } }),
      'unknown kid': token({ kid: 'nope' }),
      'alg none': `${b64({ alg: 'none', kid: 'k1' })}.${b64({ sub: 'x', aud: PROJECT })}.`,
      'tampered claims': (() => { const t = token().split('.'); t[1] = b64({ ...JSON.parse(Buffer.from(t[1], 'base64url')), email: 'admin@example.com' }); return t.join('.'); })(),
      garbage: 'not-a-token',
      missing: undefined,
    };
    for (const [why, t] of Object.entries(bad)) {
      assert.equal((await google(t)).status, 401, why);
    }
  });

  it('is off (404) when no Firebase project is configured; config reports the flag', async () => {
    assert.equal((await call('POST', '/v1/auth/google', { body: { idToken: 'x' } })).status, 404);
    assert.equal((await call('GET', '/v1/config')).body.googleSignIn, false);
    const on = await (await fetch(`${url}/v1/config`)).json();
    assert.equal(on.googleSignIn, true);
  });
});
