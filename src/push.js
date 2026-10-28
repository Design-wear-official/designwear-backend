// Phone notifications through Firebase Cloud Messaging (HTTP v1), sent with a
// service account so the server needs no SDK.
import { createAccessTokenSource } from './google_auth.js';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 8000;

export class NullPush {
  get enabled() {
    return false;
  }
  async send() {
    return { invalid: [] };
  }
}

export class FcmPush {
  constructor({ credentials }, fetchImpl = fetch, now = () => Date.now()) {
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.token = createAccessTokenSource({
      credentials,
      scope: FCM_SCOPE,
      fetchImpl,
      now,
      errorPrefix: 'fcm_auth_error',
    });
  }

  get enabled() {
    return Boolean(this.credentials);
  }

  // Sends to every device token. Returns the tokens Firebase says are gone, so the
  // caller can forget them.
  async send(tokens, { title, body, data = {} }) {
    const invalid = [];
    if (!this.enabled || tokens.length === 0) return { invalid };

    const url = `https://fcm.googleapis.com/v1/projects/${this.credentials.project_id}/messages:send`;
    const accessToken = await this.token();

    await Promise.all(
      tokens.map(async (token) => {
        const response = await this.fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              // FCM data values must all be strings.
              data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
              android: { priority: 'HIGH', notification: { channel_id: 'orders' } },
            },
          }),
        });
        if (response.ok) return;
        // 404 UNREGISTERED / 400 INVALID_ARGUMENT: the app was removed or the token is stale.
        if (response.status === 404 || response.status === 400) invalid.push(token);
      }),
    );
    return { invalid };
  }
}
