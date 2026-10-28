import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { FirestoreStore, createStore } from '../src/store.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const credentials = {
  project_id: 'demo',
  client_email: 'svc@demo.iam.gserviceaccount.com',
  private_key: privateKey,
};

// A small stand-in for the Google token endpoint and Firestore's REST API.
function fakeGoogle() {
  const docs = new Map(); // "collection/id" -> json string
  const seen = { tokens: 0, auth: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (u.host === 'oauth2.googleapis.com') {
      seen.tokens += 1;
      const assertion = new URLSearchParams(String(init.body)).get('assertion');
      assert.equal(assertion.split('.').length, 3);
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }

    seen.auth.push(init.headers.authorization);
    const path = decodeURIComponent(u.pathname.split('/documents/')[1]);
    const method = init.method ?? 'GET';

    if (method === 'PATCH') {
      docs.set(path, JSON.parse(init.body).fields.d.stringValue);
      return json(200, {});
    }
    if (method === 'DELETE') {
      docs.delete(path);
      return json(200, {});
    }
    if (docs.has(path)) return json(200, { fields: { d: { stringValue: docs.get(path) } } });
    if (!path.includes('/')) {
      const documents = [...docs]
        .filter(([key]) => key.startsWith(`${path}/`))
        .map(([, value]) => ({ fields: { d: { stringValue: value } } }));
      return json(200, { documents });
    }
    return json(404, {});
  };
  return { fetchImpl, seen };
}

describe('FirestoreStore', () => {
  it('stores, lists and deletes documents, even with awkward ids', async () => {
    const { fetchImpl, seen } = fakeGoogle();
    const store = new FirestoreStore({ credentials, fetchImpl });

    await store.put('users', 'u_1', { id: 'u_1', n: 1 });
    await store.put('users', 'u_2', { id: 'u_2', n: 2 });
    await store.put('emails', 'ada@example.com', { id: 'ada@example.com', userId: 'u_1' });
    await store.put('likes', 'd_1:u_1', { id: 'd_1:u_1' });

    assert.deepEqual(await store.get('users', 'u_1'), { id: 'u_1', n: 1 });
    assert.equal(await store.get('users', 'nobody'), null);
    assert.deepEqual((await store.get('emails', 'ada@example.com')).userId, 'u_1');
    assert.ok(await store.get('likes', 'd_1:u_1'));
    assert.deepEqual((await store.list('users', (u) => u.n > 1)).map((u) => u.id), ['u_2']);

    await store.del('users', 'u_1');
    assert.equal(await store.get('users', 'u_1'), null);
    assert.equal(seen.tokens, 1, 'the access token is reused');
    assert.ok(seen.auth.every((h) => h === 'Bearer tok'));
  });

  it('reports a failed login or write instead of pretending it worked', async () => {
    const store = new FirestoreStore({
      credentials,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await assert.rejects(() => store.put('users', 'a', {}), /firestore_auth_error:403/);
  });

  it('config accepts the key as JSON or base64 and prefers Firestore', async () => {
    const asJson = loadConfig({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(credentials) });
    const asBase64 = loadConfig({
      FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(credentials)).toString('base64'),
      KV_REST_API_URL: 'https://r.test',
      KV_REST_API_TOKEN: 't',
    });
    assert.ok((await createStore(asJson)) instanceof FirestoreStore);
    assert.ok((await createStore(asBase64)) instanceof FirestoreStore);
    assert.equal(loadConfig({ FIREBASE_SERVICE_ACCOUNT: 'not a key' }).firestore.credentials, null);
  });
});
