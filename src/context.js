// Everything the route modules share: configuration, services, and the small
// helpers that every endpoint needs (auth, rate limiting, body parsing).
import { randomBytes } from 'node:crypto';

import { createFirebaseVerifier } from './firebase_token.js';
import { createLogger } from './logger.js';
import { NullOrderSync } from './order_sync.js';
import { RateLimiter, safeEqual, signToken, verifyToken } from './security.js';
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
    orderSync = new NullOrderSync(),
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
  async function authed(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, config.jwtSecret, now());
    const user = payload && (await store.get('users', payload.sub));
    if (!user || user.tokenVersion !== payload.v) {
      throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    }
    return user;
  }

  // Like authed(), but signed-out callers get null instead of an error.
  async function optionalUser(req) {
    try {
      return await authed(req);
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

  // Copies the order to SethuCMS. The customer never waits on it failing: a
  // problem is logged and the order is still saved here.
  async function syncOrder(order) {
    if (!orderSync.enabled) return;
    try {
      const customer = await store.get('users', order.userId);
      await orderSync.push(order, customer);
    } catch (error) {
      logger.error(`Order sync failed for ${order.id}: ${error.message}`, error);
    }
  }

  // Applies what the business set in SethuCMS (status, tracking) to the order.
  async function refreshOrder(order) {
    if (!orderSync.enabled) return order;
    try {
      const remote = await orderSync.pull(order);
      if (!remote || (remote.status === order.status && !remote.tracking)) return order;
      if (remote.status !== order.status) {
        order.status = remote.status;
        order.history = [...(order.history ?? []), { status: remote.status, at: new Date(now()).toISOString() }];
      }
      if (remote.tracking) order.tracking = remote.tracking;
      await store.put('orders', order.id, order);
    } catch (error) {
      logger.error(`Order refresh failed for ${order.id}: ${error.message}`, error);
    }
    return order;
  }

  // Business-owner access: a long secret token, and the routes do not exist at
  // all (404) until one is configured.
  function requireAdmin(req) {
    if (!config.adminToken) throw new HttpError(404, 'not_found');
    limit(`admin:${ipOf(req)}`, 120, 60_000);
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!safeEqual(given, config.adminToken)) {
      throw new HttpError(401, 'unauthenticated', 'Admin token required.');
    }
  }

  // Accounts are found through small index collections (email -> user id,
  // Firebase uid -> user id) so a lookup never scans every user.
  async function findUserByEmail(email) {
    return findUserVia('emails', email);
  }

  async function findUserByFirebaseUid(uid) {
    return findUserVia('uids', uid);
  }

  async function findUserVia(index, key) {
    const entry = await store.get(index, key);
    return entry ? store.get('users', entry.userId) : null;
  }

  async function indexUser(user) {
    await store.put('emails', user.email, { id: user.email, userId: user.id });
    if (user.firebaseUid) {
      await store.put('uids', user.firebaseUid, { id: user.firebaseUid, userId: user.id });
    }
  }

  return {
    config, store, catalog, ai, mailer, logger, clientLogger, now, fetchImpl, firebase,
    ipOf, limit, authed, optionalUser, issue, readBody, requireAdmin,
    syncOrder, refreshOrder,
    findUserByEmail, findUserByFirebaseUid, indexUser,
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
