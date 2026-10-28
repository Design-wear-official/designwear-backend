import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, secret, ttlSeconds, now = Date.now()) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64u(sig)}`;
}

export function verifyToken(token, secret, now = Date.now()) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  let head;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString());
  } catch {
    return null;
  }
  if (head.alg !== 'HS256') return null; // never trust the token's own alg
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

const scryptAsync = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
  );

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashCode(code, secret) {
  return createHmac('sha256', secret).update(String(code)).digest('base64');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Fixed-window-per-key limiter. Per process, like the rest of the state. */
export class RateLimiter {
  constructor() {
    this.hits = new Map();
  }
  /** Returns true when the call is allowed. */
  allow(key, limit, windowMs, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
