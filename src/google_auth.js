// Service-account login for Google APIs: sign a short JWT, trade it for an access
// token, and reuse that token until shortly before it expires. No SDK needed.
import { createSign } from 'node:crypto';

export function createAccessTokenSource({
  credentials,
  scope,
  fetchImpl = fetch,
  now = () => Date.now(),
  errorPrefix = 'google_auth_error',
}) {
  let accessToken = null;
  let expiresAt = 0;

  return async function accessTokenNow() {
    if (accessToken && now() < expiresAt - 60_000) return accessToken;

    const issued = Math.floor(now() / 1000);
    const part = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: credentials.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: issued,
      exp: issued + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(credentials.private_key)
      .toString('base64url');

    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new Error(`${errorPrefix}:${response.status}`);
    }
    accessToken = body.access_token;
    expiresAt = now() + (body.expires_in ?? 3600) * 1000;
    return accessToken;
  };
}
