import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createQuota, dayKey, nextReset, planOf } from '../src/quota.js';
import { Store } from '../src/store.js';
import { HttpError } from '../src/validate.js';

const ADMIN = 'a'.repeat(32);
const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]).toString('base64');

let server, base, store, calls, fail;
const ai = {
  agentConfigured: true,
  tryOnConfigured: true,
  designAgent: async ({ message }) => {
    calls.push('agent');
    if (fail) throw new HttpError(502, 'ai_error', 'down');
    return { text: 'ok', design: message.includes('edit') ? { elements: [] } : null };
  },
  designImage: async () => {
    calls.push('image');
    return 'QUJD';
  },
  tryOn: async () => 'QUJD',
};

before(async () => {
  calls = [];
  fail = false;
  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://shop.test', DESIGNWEAR_ADMIN_TOKEN: ADMIN });
  config.rateLimitMultiplier = 1000;
  store = await new Store(':memory:').load();
  const catalog = { configured: true, products: async () => [], product: async () => ({ id: 'p1', title: 'Tee', imageUrl: 'https://img.test/a.png' }) };
  server = createServer(createApp({ config, store, catalog, ai, mailer: { send: async () => {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const signUp = async (email) => {
  const r = (await call('POST', '/v1/auth/register', { name: 'T', email, password: 'password123' })).body;
  return { token: r.token, id: r.user.id, auth: { authorization: `Bearer ${r.token}` } };
};
const chat = (u) => call('POST', '/v1/ai/design-agent', { message: 'a sun tee' }, u.auth);

describe('daily AI limit', () => {
  it('a free person gets 3 creations a day across chat, images and try-on, then a clear 429', async () => {
    const u = await signUp('free@example.com');
    assert.equal((await chat(u)).status, 200);
    assert.equal((await call('POST', '/v1/ai/design-image', { prompt: 'sun' }, u.auth)).status, 200);
    assert.equal((await call('POST', '/v1/ai/try-on', { photo, productId: 'p1' }, u.auth)).status, 200);

    const blocked = await chat(u);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'ai_daily_limit');
    assert.match(blocked.body.error.message, /3 free AI creations/);
    assert.match(blocked.body.error.message, /coming soon/);
    assert.ok(!/upgrade/i.test(blocked.body.error.message), 'no upgrade button exists yet');
    assert.deepEqual([blocked.body.error.details.plan, blocked.body.error.details.limit, blocked.body.error.details.used], ['free', 3, 3]);

    const usage = (await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body;
    assert.deepEqual([usage.plan, usage.limit, usage.used, usage.remaining], ['free', 3, 3, 0]);
  });

  it("a design edit comes with a one-time pass, so the design and its graphic cost one creation", async () => {
    const u = await signUp('pass@example.com');
    const edit = await call('POST', '/v1/ai/design-agent', { message: 'edit: a sun tee' }, u.auth);
    assert.equal(edit.status, 200);
    assert.ok(edit.body.imagePass, 'an edit returns a pass');
    assert.equal((await chat(u)).body.imagePass, undefined, 'a plain reply does not');

    const image = await call('POST', '/v1/ai/design-image', { prompt: 'sun', pass: edit.body.imagePass }, u.auth);
    assert.equal(image.status, 200);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.used, 2, 'two messages, graphic free');

    // The pass works once, only for its owner.
    const again = await call('POST', '/v1/ai/design-image', { prompt: 'sun', pass: edit.body.imagePass }, u.auth);
    assert.equal(again.status, 200);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.used, 3, 'a reused pass is charged');
    const stranger = await signUp('stranger@example.com');
    await call('POST', '/v1/ai/design-image', { prompt: 'sun', pass: edit.body.imagePass }, stranger.auth);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, stranger.auth)).body.used, 1, "someone else's pass is charged");
  });

  it("another person's allowance is separate", async () => {
    const u = await signUp('other@example.com');
    assert.equal((await chat(u)).status, 200);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.remaining, 2);
  });

  it('a Google failure gives the creation back', async () => {
    const u = await signUp('refund@example.com');
    fail = true;
    assert.equal((await chat(u)).status, 502);
    assert.equal((await chat(u)).status, 502);
    fail = false;
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.used, 0);
  });

  it('a request that fails validation does not use a creation', async () => {
    const u = await signUp('invalid@example.com');
    assert.equal((await call('POST', '/v1/ai/design-agent', { message: '' }, u.auth)).status, 400);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.used, 0);
  });

  it('only the owner can set a plan; pro and ultra get more; an expired plan is free again', async () => {
    const u = await signUp('plan@example.com');
    const asUser = await call('PUT', `/v1/admin/users/${u.id}/plan`, { plan: 'pro' }, u.auth);
    assert.equal(asUser.status, 401);

    const admin = { authorization: `Bearer ${ADMIN}` };
    assert.equal((await call('PUT', `/v1/admin/users/${u.id}/plan`, { plan: 'gold' }, admin)).status, 400);
    assert.equal((await call('PUT', `/v1/admin/users/${u.id}/plan`, { plan: 'pro' }, admin)).status, 200);
    const usage = (await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body;
    assert.deepEqual([usage.plan, usage.limit], ['pro', 30]);
    assert.equal((await call('GET', '/v1/me', undefined, u.auth)).body.user.plan, 'pro');

    await call('PUT', `/v1/admin/users/${u.id}/plan`, { plan: 'ultra', until: '2020-01-01' }, admin);
    assert.equal((await call('GET', '/v1/me/ai-usage', undefined, u.auth)).body.plan, 'free');

    const audit = await store.list('audit', (a) => a.action === 'user.plan' && a.target === u.id);
    assert.equal(audit.length, 3 - 1, 'the two accepted changes are audited, the refused one is not');
  });
});

describe('quota days', () => {
  it('a day runs midnight to midnight India time, and the count starts again', async () => {
    // 2026-10-31 18:29 UTC is 23:59 IST; one minute later it is the next day.
    const before = Date.parse('2026-10-31T18:29:00Z');
    const after = Date.parse('2026-10-31T18:31:00Z');
    assert.equal(dayKey(before), '2026-10-31');
    assert.equal(dayKey(after), '2026-11-01');
    assert.equal(nextReset(before), '2026-10-31T18:30:00.000Z');

    let t = before;
    const q = createQuota({ store: await new Store(':memory:').load(), config: { aiDailyLimits: { free: 2, pro: 30, ultra: 100 } }, now: () => t });
    const user = { id: 'u1' };
    await q.take(user);
    await q.take(user);
    await assert.rejects(() => q.take(user), /ai_daily_limit|used your 2 free/);
    t = after;
    assert.equal((await q.usage(user)).remaining, 2);
    await q.take(user);
  });

  it('planOf treats unknown plans as free', () => {
    assert.equal(planOf({ plan: 'platinum' }, Date.now()), 'free');
    assert.equal(planOf({ plan: 'pro', planUntil: '2999-01-01' }, Date.now()), 'pro');
  });
});
