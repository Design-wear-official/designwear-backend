import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { orderRecord } from '../src/order_sync.js';
import { printLink, printSignature, validSignature } from '../src/print.js';
import { Store } from '../src/store.js';

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const address = { label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001' };
const BASE = 'https://api.test';

let server, base, store, config, auth, order, jobId, link;
const synced = [];

before(async () => {
  config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://shop.test', PUBLIC_API_URL: BASE });
  config.rateLimitMultiplier = 1000;
  store = await new Store(':memory:').load();
  const orderSync = {
    enabled: true,
    push: async (o, c, linkFor) => synced.push(orderRecord(o, c, linkFor)),
    pull: async () => null,
  };
  server = createServer(createApp({ config, store, catalog: { configured: true, products: async () => [], product: async () => null }, ai: {}, mailer: { send: async () => {} }, orderSync }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const reg = (await call('POST', '/v1/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'password123' })).body;
  auth = { authorization: `Bearer ${reg.token}` };
  const design = (await call('POST', '/v1/designs', {
    name: '<b>Sunrise</b> tee', garment: 'T-Shirt', baseColor: 0xff8c00, front: [], back: [],
    designJson: { elements: [{ type: 'text', content: 'SUNRISE <VIBES>', color: '0xFFFFFFFF', properties: { fontFamily: 'Bebas Neue' } }] },
    previewImage: PNG,
  }, auth)).body.design;
  order = (await call('POST', '/v1/orders', { address, paymentMethod: 'cod', lines: [{ productId: design.id, designId: design.id, size: 'M', quantity: 2 }] }, auth)).body.order;
  jobId = order.lines[0].printJobId;
  link = printLink(BASE, jobId, config.jwtSecret);
});
after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
}
const local = (url) => url.replace(BASE, '');

describe('print sheets', () => {
  it('the order record carries a signed link per custom line', () => {
    assert.ok(jobId, 'the order has a print job');
    const record = synced.at(-1);
    assert.ok(record.printFiles.includes(link), 'the link is in printFiles');
    assert.match(record.printFiles, /x2:/);
  });

  it('the link opens a sheet with size, quantity, garment and what is on the shirt, escaped', async () => {
    const res = await call('GET', local(link));
    assert.equal(res.status, 200);
    const html = res.body.toString();
    assert.match(html, /Print sheet/);
    assert.match(html, /<td>M<\/td>/);
    assert.match(html, /<td>2<\/td>/);
    assert.match(html, /T-Shirt/);
    assert.match(html, /SUNRISE &lt;VIBES&gt;/);
    assert.match(html, /Bebas Neue/);
    assert.ok(!html.includes('<b>Sunrise</b>'), 'the design name is escaped');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  it('the front picture is served as a PNG, and there is no back picture to serve', async () => {
    const img = await call('GET', `/v1/print/${jobId}/front.png?sig=${printSignature(jobId, config.jwtSecret)}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.body.readUInt32BE(0), 0x89504e47);
    assert.equal((await call('GET', `/v1/print/${jobId}/back.png?sig=${printSignature(jobId, config.jwtSecret)}`)).status, 404);
  });

  it('a wrong, missing or borrowed signature gets the same 404 as a missing job', async () => {
    assert.equal((await call('GET', `/v1/print/${jobId}`)).status, 404);
    assert.equal((await call('GET', `/v1/print/${jobId}?sig=${'0'.repeat(32)}`)).status, 404);
    const other = printSignature('someone-elses-job', config.jwtSecret);
    assert.equal((await call('GET', `/v1/print/${jobId}?sig=${other}`)).status, 404);
    assert.equal((await call('GET', `/v1/print/nope?sig=${printSignature('nope', config.jwtSecret)}`)).status, 404);
    assert.equal(validSignature(jobId, printSignature(jobId, 'another-secret-another-secret-xx'), config.jwtSecret), false);
  });

  it('a cancelled order says do not print', async () => {
    await call('POST', `/v1/orders/${order.id}/cancel`, undefined, auth);
    const html = (await call('GET', local(link))).body.toString();
    assert.match(html, /CANCELLED\. Do not print/);
  });

  it('no public address means no links, and plain items still sync', () => {
    const record = orderRecord(order, { name: 'Ada' });
    assert.equal(record.printFiles, '');
    assert.ok(record.items.length > 0);
  });
});
