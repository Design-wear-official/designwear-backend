// Everything the route modules share: configuration, services, and the small
// helpers that every endpoint needs (auth, rate limiting, body parsing).
import { randomBytes } from 'node:crypto';

import { createFirebaseVerifier } from './firebase_token.js';
import { createLogger } from './logger.js';
import { RateLimiter, signToken, verifyToken } from './security.js';
import { HttpError, bad } from './validate.js';

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export function newId(prefix = '') {
  return prefix + randomBytes(9).toString('base64url');
}

export function createContext(deps) {
  const {
    config,
    store,
    catalog,
    ai,
    mailer,
    logger = createLogger({ sink: () => {} }),
    clientLogger = logger,
    now = () => Date.now(),
    fetchImpl = fetch,
  } = deps;

  const firebase =
    deps.firebase ??
    createFirebaseVerifier({ projectId: config.firebaseProjectId, now });

  const limiter = new RateLimiter();

  // The address the request really came from (behind a proxy, the first
  // X-Forwarded-For entry; otherwise the socket).
  function ipOf(req) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '');
    const proxied = config.trustProxy ? forwarded.split(',')[0].trim() : '';
    return proxied || req.socket.remoteAddress || 'unknown';
  }

  // Throws 429 when `key` has made more than `max` calls inside `windowMs`.
  function limit(key, max, windowMs) {
    const scaledMax = max * (config.rateLimitMultiplier ?? 1);
    if (limiter.allow(key, scaledMax, windowMs, now())) return;
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.');
  }

  // The signed-in user for this request, or a 401.
  function authed(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, config.jwtSecret, now());
    const user = payload && store.get('users', payload.sub);
    if (!user || user.tokenVersion !== payload.v) {
      throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    }
    return user;
  }

  // Like authed(), but signed-out callers get null instead of an error.
  function optionalUser(req) {
    try {
      return authed(req);
    } catch {
      return null;
    }
  }

  // A fresh session for `user`: { token, user }.
  function issue(user) {
    const token = signToken(
      { sub: user.id, v: user.tokenVersion },
      config.jwtSecret,
      SESSION_TTL_SECONDS,
      now(),
    );
    return { token, user: publicUser(user) };
  }

  // Reads a JSON object body, refusing anything larger than `maxBytes`.
  async function readBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new HttpError(413, 'too_large', 'Request body too large.');
      }
      chunks.push(chunk);
    }
    if (size === 0) return {};
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw bad('invalid_json', 'Body must be a JSON object.');
    }
    const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
    if (!isObject) throw bad('invalid_json', 'Body must be a JSON object.');
    return body;
  }

  function findUserByEmail(email) {
    return store.list('users', (u) => u.email === email)[0];
  }

  return {
    config, store, catalog, ai, mailer, logger, clientLogger, now, fetchImpl, firebase,
    ipOf, limit, authed, optionalUser, issue, readBody, findUserByEmail,
  };
}

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? '',
  };
}
