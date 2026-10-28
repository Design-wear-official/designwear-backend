import { createPublicKey, verify } from 'node:crypto';

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export class TokenError extends Error {}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verifies a Firebase Auth ID token the way Google documents it: RS256 signature
 * against Google's published certificates, then issuer, audience, expiry and
 * subject. Only Google sign-ins with a verified email are accepted.
 */
export function createFirebaseVerifier({ projectId, fetchImpl = fetch, now = () => Date.now() }) {
  let certs = null; // { at, ttl, keys: Map<kid, KeyObject> }

  async function keys() {
    if (certs && now() - certs.at < certs.ttl) return certs.keys;
    const res = await fetchImpl(CERTS_URL, { redirect: 'error' });
    if (!res.ok) throw new TokenError('Could not load signing keys.');
    const body = await res.json();
    const maxAge = /max-age=(\d+)/.exec(res.headers?.get?.('cache-control') ?? '')?.[1];
    certs = {
      at: now(),
      ttl: Math.min(Number(maxAge ?? 3600), 6 * 3600) * 1000,
      keys: new Map(Object.entries(body).map(([kid, pem]) => [kid, createPublicKey(String(pem))])),
    };
    return certs.keys;
  }

  return {
    get configured() {
      return Boolean(projectId);
    },

    async verify(idToken) {
      const parts = String(idToken ?? '').split('.');
      if (parts.length !== 3) throw new TokenError('Malformed token.');
      let header;
      let claims;
      try {
        header = b64json(parts[0]);
        claims = b64json(parts[1]);
      } catch {
        throw new TokenError('Malformed token.');
      }
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
        throw new TokenError('Unsupported token.');
      }

      const key = (await keys()).get(header.kid);
      if (!key) {
        certs = null; // keys rotate: refetch next time
        throw new TokenError('Unknown signing key.');
      }
      const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
      const signature = Buffer.from(parts[2], 'base64url');
      const ok = verify('RSA-SHA256', signedData, key, signature);
      if (!ok) throw new TokenError('Bad signature.');

      const nowS = Math.floor(now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= nowS) throw new TokenError('Token expired.');
      if (typeof claims.iat !== 'number' || claims.iat > nowS + 300) {
        throw new TokenError('Token issued in the future.');
      }
      if (claims.aud !== projectId) throw new TokenError('Token is for a different project.');
      if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new TokenError('Wrong issuer.');
      if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) {
        throw new TokenError('Missing subject.');
      }
      if (claims.firebase?.sign_in_provider !== 'google.com') {
        throw new TokenError('Only Google sign-in is accepted.');
      }
      if (typeof claims.email !== 'string' || claims.email_verified !== true) {
        throw new TokenError('Email is not verified.');
      }

      const displayName = typeof claims.name === 'string' ? claims.name.trim() : '';
      return {
        uid: claims.sub,
        email: claims.email.toLowerCase(),
        name: displayName.slice(0, 80) || claims.email.split('@')[0],
      };
    },
  };
}
