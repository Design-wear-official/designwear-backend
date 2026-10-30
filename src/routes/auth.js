// Sign up, sign in (password and Google), and password reset.
import { createHash, randomInt } from 'node:crypto';

import { TokenError } from '../firebase_token.js';
import { newId } from '../context.js';
import { hashCode, hashPassword, safeEqual, verifyPassword } from '../security.js';
import * as v from '../validate.js';
import { HttpError } from '../validate.js';

const HOUR_MS = 3600_000;
const RESET_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
// Wrong passwords for one account: after this many inside the window, sign-in for
// that account pauses. It counts per account, not per address, so a spread-out
// attack is held too, and it applies to unknown emails alike (no way to tell them apart).
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

// Checked against when the account doesn't exist, so a login takes the same
// time and gives the same answer either way.
const DUMMY_PASSWORD_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AA==';

export function registerAuthRoutes(router, ctx) {
  const { config, store, mailer, firebase, now } = ctx;

  function createdAt() {
    return new Date(now()).toISOString();
  }

  router.route('POST', '/v1/auth/register', async ({ req }) => {
    ctx.limit(`reg:${ctx.ipOf(req)}`, 10, HOUR_MS);
    const body = await ctx.readBody(req);

    const email = v.email(body.email);
    const name = v.str(body.name, 'name', { max: 80 });
    const password = v.password(body.password);

    if (await ctx.findUserByEmail(email)) {
      throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    }

    const user = {
      id: newId('u_'),
      email,
      name,
      phone: '',
      pw: await hashPassword(password),
      tokenVersion: 1,
      createdAt: createdAt(),
    };
    await store.put('users', user.id, user);
    await ctx.indexUser(user);

    return { status: 201, body: ctx.issue(user) };
  });

  router.route('POST', '/v1/auth/login', async ({ req }) => {
    const body = await ctx.readBody(req);
    const email = v.email(body.email);
    ctx.limit(`login:${ctx.ipOf(req)}:${email}`, 10, 15 * 60_000);

    const lockId = createHash('sha256').update(email).digest('hex').slice(0, 32);
    const lock = (await store.get('lockouts', lockId)) ?? { id: lockId, count: 0, since: 0, until: 0 };
    if (lock.until > now()) {
      throw new HttpError(429, 'locked', 'Too many wrong passwords. Try again in a few minutes, or reset your password.');
    }

    const user = await ctx.findUserByEmail(email);
    const supplied = String(body.password ?? '');

    let passwordOk = false;
    if (user) {
      passwordOk = await verifyPassword(supplied, user.pw);
    } else {
      await verifyPassword('x', DUMMY_PASSWORD_HASH);
    }

    if (!passwordOk) {
      const fresh = now() - lock.since > LOGIN_WINDOW_MS;
      const count = (fresh ? 0 : lock.count) + 1;
      const locked = count >= LOGIN_MAX_FAILURES;
      await store.put('lockouts', lockId, {
        id: lockId,
        count,
        since: fresh ? now() : lock.since,
        until: locked ? now() + LOGIN_WINDOW_MS : 0,
      });
      await ctx.audit(`email:${lockId}`, locked ? 'auth.locked' : 'auth.login_failed', user?.id ?? 'unknown', { count });
      throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
    }
    if (lock.count > 0) await store.put('lockouts', lockId, { id: lockId, count: 0, since: 0, until: 0 });
    return { status: 200, body: ctx.issue(user) };
  });

  // Google sign-in: the app signs in with Firebase, then trades the Firebase ID
  // token here for this API's own session. Accounts are matched by Firebase uid,
  // then by verified email (which links an existing password account).
  router.route('POST', '/v1/auth/google', async ({ req }) => {
    if (!firebase.configured) {
      throw new HttpError(404, 'google_unavailable', 'Google sign-in is not enabled.');
    }
    ctx.limit(`google:${ctx.ipOf(req)}`, 20, 15 * 60_000);
    const { idToken } = await ctx.readBody(req);

    let google;
    try {
      google = await firebase.verify(idToken);
    } catch (error) {
      if (error instanceof TokenError) {
        throw new HttpError(401, 'invalid_token', 'Google sign-in could not be verified.');
      }
      throw new HttpError(502, 'google_unavailable', 'Could not verify the Google sign-in. Try again.');
    }

    const byUid = await ctx.findUserByFirebaseUid(google.uid);
    let user = byUid ?? (await ctx.findUserByEmail(google.email));

    if (!user) {
      user = {
        id: newId('u_'),
        email: google.email,
        name: google.name,
        phone: '',
        pw: null, // no password: they can set one later through password reset
        firebaseUid: google.uid,
        tokenVersion: 1,
        createdAt: createdAt(),
      };
      await store.put('users', user.id, user);
      await ctx.indexUser(user);
      return { status: 200, body: ctx.issue(user) };
    }

    if (user.firebaseUid && user.firebaseUid !== google.uid) {
      throw new HttpError(409, 'account_conflict', 'This email is linked to a different Google account.');
    }
    if (!user.firebaseUid) {
      user.firebaseUid = google.uid;
      await store.put('users', user.id, user);
      await ctx.indexUser(user);
    }
    return { status: 200, body: ctx.issue(user) };
  });

  router.route('POST', '/v1/auth/password-reset/request', async ({ req }) => {
    ctx.limit(`reset:${ctx.ipOf(req)}`, 5, HOUR_MS);
    const email = v.email((await ctx.readBody(req)).email);
    const user = await ctx.findUserByEmail(email);

    if (user) {
      const code = String(randomInt(100000, 1000000));
      await store.put('resets', user.id, {
        id: user.id,
        hash: hashCode(code, config.jwtSecret),
        expires: now() + RESET_TTL_MS,
        attempts: 0,
      });
      await mailer.send(
        user.email,
        'Your DesignWear reset code',
        `Your reset code is ${code}. It expires in 15 minutes.`,
      );
    }

    // Always the same answer, so this can't be used to find registered emails.
    return { status: 202, body: { ok: true } };
  });

  router.route('POST', '/v1/auth/password-reset/confirm', async ({ req }) => {
    ctx.limit(`resetc:${ctx.ipOf(req)}`, 10, HOUR_MS);
    const body = await ctx.readBody(req);

    const email = v.email(body.email);
    const newPassword = v.password(body.password);
    const user = await ctx.findUserByEmail(email);
    const reset = user && (await store.get('resets', user.id));
    const invalidCode = new HttpError(400, 'invalid_code', 'That code is invalid or has expired.');

    const unusable = !reset || reset.expires < now() || reset.attempts >= RESET_MAX_ATTEMPTS;
    if (unusable) throw invalidCode;

    const givenHash = hashCode(String(body.code ?? ''), config.jwtSecret);
    if (!safeEqual(reset.hash, givenHash)) {
      await store.put('resets', user.id, { ...reset, attempts: reset.attempts + 1 });
      throw invalidCode;
    }

    user.pw = await hashPassword(newPassword);
    user.tokenVersion += 1; // signs out every existing session
    await store.put('users', user.id, user);
    await store.del('resets', user.id);

    return { status: 200, body: { ok: true } };
  });
}
