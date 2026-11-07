import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

let server, base;
before(async () => {
  const config = loadConfig({
    DESIGNWEAR_JWT_SECRET: 'x'.repeat(40),
    HUB_URL: 'https://hub.example.com/',
    SHOP_URL: 'http://not-https.example.com',
    RULES_URL: 'javascript:alert(1)',
  });
  const app = createApp({ config, store: await new Store(':memory:').load(), catalog: { configured: false, products: async () => [], product: async () => null }, ai: {}, mailer: { send: async () => {} } });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('GET / (the front door)', () => {
  it('shows a browser a page of links to every part of DesignWear', async () => {
    const res = await fetch(`${base}/`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await res.text();
    for (const url of ['designwear-tawny.vercel.app', 'designwear-scm.vercel.app', 'sethucms-admin.vercel.app', 'designwear-sdk-docs.vercel.app', 'designwear-data.vercel.app']) {
      assert.ok(html.includes(`href="https://${url}"`), url);
    }
    assert.ok(html.includes('href="https://hub.example.com"'), 'an https override is used, without its trailing slash');
    assert.ok(html.includes('href="/v1/health"'));
  });

  it('gives programs the same links as JSON', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'DesignWear API');
    assert.equal(body.health, '/v1/health');
    assert.equal(body.links.hub, 'https://hub.example.com');
    assert.equal(body.links.staff, 'https://designwear-scm.vercel.app');
  });

  it('ignores a link setting that is not https, so the page never carries a script link', async () => {
    const body = await (await fetch(`${base}/`)).json();
    assert.equal(body.links.shop, 'https://designwear-tawny.vercel.app');
    assert.equal(body.links.rules, 'https://designwear-rules.vercel.app');
    const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
    assert.ok(!html.includes('javascript:'));
  });

  it('other paths are still not found', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
  });
});
