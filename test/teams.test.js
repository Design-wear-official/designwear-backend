import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { CmsCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { asGateway } from './gateway_fake.js';

const collections = {
  products: [{ id: 'p1', title: 'Graphic Tee', price: 500, stockCount: 99 }],
  teams: [
    { id: 't_pune', name: 'Pune Team', phone: '9000000001', pins: '411001, 411002' },
    { id: 't_pune2', name: 'Pune Backup', phone: '9000000002', pins: ['411001'] },
    { id: 't_off', name: 'Closed Team', pins: '560001', active: false },
  ],
  team_stock: [
    { teamId: 't_pune', productId: 'p1', quantity: 1 },
    { teamId: 't_pune2', productId: 'p1', quantity: 10 },
  ],
};

// A stand-in for the SethuCMS gateway that serves the collections above.
function fakeGateway(without = []) {
  return async (url) => {
    const name = new URL(url).pathname.split('/collections/')[1].split('/')[0];
    if (without.includes(name) || !collections[name]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: collections[name], nextCursor: null }) };
  };
}

const address = (pin) => ({ label: 'Home', name: 'Ada', phone: '9999999999', line1: '1 Road', city: 'Pune', state: 'MH', pin });
let servers = [];

async function start(gatewayFetch) {
  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40) });
  config.rateLimitMultiplier = 1000;
  const catalog = new CmsCatalog({ url: 'https://cms.test', connectionId: 'c', token: 't' }, asGateway(gatewayFetch), 0);
  const app = createApp({ config, store: await new Store(':memory:').load(), catalog, ai: {}, mailer: { send: async () => {} } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const signup = await call('POST', '/v1/auth/register', { body: { name: 'Ada', email: 'a@example.com', password: 'password123' } });
  return { call, token: signup.body.token };
}
after(() => servers.forEach((s) => s.close()));

describe('local teams', () => {
  let shop;
  before(async () => { shop = await start(fakeGateway()); });
  const order = (pin, quantity) => shop.call('POST', '/v1/orders', {
    token: shop.token,
    body: { address: address(pin), lines: [{ productId: 'p1', size: 'M', quantity }] },
  });

  it('says whether anyone delivers to a PIN code', async () => {
    assert.deepEqual((await shop.call('GET', '/v1/serviceability?pin=411001')).body, { serviceable: true, teams: 2 });
    assert.equal((await shop.call('GET', '/v1/serviceability?pin=411002')).body.teams, 1);
    assert.equal((await shop.call('GET', '/v1/serviceability?pin=560001')).body.serviceable, false, 'inactive teams do not count');
    assert.equal((await shop.call('GET', '/v1/serviceability?pin=abc')).status, 400);
  });

  it('assigns the order to a team serving the PIN that has the stock', async () => {
    const one = await order('411001', 1);
    assert.equal(one.status, 201);
    assert.equal(one.body.order.team.id, 't_pune', 'first team that can fill it');

    const five = await order('411001', 5);
    assert.equal(five.status, 201);
    assert.equal(five.body.order.team.id, 't_pune2', 'falls through to the team with enough stock');
  });

  it('refuses PIN codes nobody serves, and quantities no serving team has', async () => {
    const nobody = await order('999999', 1);
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.error.code, 'not_serviceable');

    const tooMany = await order('411002', 3); // only t_pune serves it, with 1 unit
    assert.equal(tooMany.body.error.code, 'insufficient_stock');
    assert.match(tooMany.body.error.message, /Only 1 of Graphic Tee/);
  });

  it('a shop without teams set up still uses the catalog stock and serves everywhere', async () => {
    const plain = await start(fakeGateway(['teams', 'team_stock']));
    assert.deepEqual((await plain.call('GET', '/v1/serviceability?pin=999999')).body, { serviceable: true, teams: 0 });
    const placed = await plain.call('POST', '/v1/orders', {
      token: plain.token,
      body: { address: address('999999'), lines: [{ productId: 'p1', size: 'M', quantity: 2 }] },
    });
    assert.equal(placed.status, 201);
    assert.equal(placed.body.order.team, null);
  });
});
