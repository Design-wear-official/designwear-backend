import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';

import { createFirebaseVerifier, TokenError } from './firebase_token.js';
import { createLogger, redact } from './logger.js';
import { RateLimiter, hashCode, hashPassword, safeEqual, signToken, verifyPassword, verifyToken } from './security.js';
import * as v from './validate.js';
import { HttpError, bad } from './validate.js';

const TOKEN_TTL = 7 * 24 * 3600;
const RESET_TTL_MS = 15 * 60 * 1000;
const id = (prefix = '') => prefix + randomBytes(9).toString('base64url');

export function createApp({ config, store, catalog, ai, mailer, logger = createLogger({ sink: () => {} }), clientLogger = logger, now = () => Date.now(), fetchImpl = fetch, firebase = createFirebaseVerifier({ projectId: config.firebaseProjectId, now }) }) {
  const limiter = new RateLimiter();

  // ── helpers ────────────────────────────────────────────────────────────
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone ?? '' });
  const ipOf = (req) =>
    (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') ||
    req.socket.remoteAddress || 'unknown';

  function limit(key, max, windowMs) {
    if (!limiter.allow(key, max * (config.rateLimitMultiplier ?? 1), windowMs, now())) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.');
  }

  function authed(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, config.jwtSecret, now());
    const user = payload && store.get('users', payload.sub);
    if (!user || user.tokenVersion !== payload.v) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    return user;
  }

  const issue = (user) => ({
    token: signToken({ sub: user.id, v: user.tokenVersion }, config.jwtSecret, TOKEN_TTL, now()),
    user: publicUser(user),
  });

  async function readBody(req, maxBytes = 1_000_000) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large.');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw 0;
      return body;
    } catch {
      throw bad('invalid_json', 'Body must be a JSON object.');
    }
  }

  const handleOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'designer';

  // ── pricing: the server never trusts a price from the client ───────────
  async function priceLines(userId, inputLines) {
    const out = [];
    for (const l of v.lines(inputLines)) {
      if (l.designId) {
        const d = store.get('designs', l.designId);
        if (!d || (!d.published && d.ownerId !== userId)) throw bad('unknown_design', 'A design in your cart is no longer available.');
        out.push({ ...l, title: `${d.name} (${d.garment})`, unitPrice: v.GARMENT_PRICES[d.garment] ?? 499, imageUrl: null });
      } else {
        const p = await catalog.product(l.productId);
        if (!p || !Number.isFinite(p.price)) throw bad('unknown_product', `Product ${l.productId} is not available.`);
        if (p.stock <= 0) throw bad('out_of_stock', `${p.title} is out of stock.`);
        out.push({ ...l, title: p.title, unitPrice: p.price, imageUrl: p.imageUrl });
      }
    }
    const subtotal = v.round2(out.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
    const tax = v.round2(subtotal * 0.18);
    return { lines: out, subtotal, tax, total: v.round2(subtotal + tax) };
  }

  // ── routes ─────────────────────────────────────────────────────────────
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/v1/health', async () => ({ status: 200, body: { ok: true } }));

  route('GET', '/v1/config', async () => ({
    status: 200,
    body: {
      catalog: catalog.configured,
      designAgent: Boolean(ai.agentConfigured),
      tryOn: Boolean(ai.tryOnConfigured),
      googleSignIn: firebase.configured,
      onlinePayments: Boolean(config.razorpay.keyId && config.razorpay.keySecret),
      razorpayKeyId: config.razorpay.keyId || null,
    },
  }));

  // Client diagnostics: warnings and errors the app chooses to report. Open to
  // signed-out users (crashes happen before login), so it is rate limited and
  // capped. Messages are redacted again here; nothing is trusted from the app.
  route('POST', '/v1/logs', async ({ req }) => {
    limit(`logs:${ipOf(req)}`, 30, 60_000);
    const b = await readBody(req, 64_000);
    const entries = v.logEntries(b.entries).map((e) => ({
      ...e, message: redact(e.message), stack: e.stack ? redact(e.stack) : undefined,
    }));
    const user = optionalUser(req);
    const app = b.app && typeof b.app === 'object' ? b.app : {};
    clientLogger.client(entries, {
      userId: user?.id,
      app: { version: String(app.version ?? '').slice(0, 20), flavour: String(app.flavour ?? '').slice(0, 20), platform: String(app.platform ?? '').slice(0, 20) },
    });
    return { status: 202, body: { accepted: entries.length } };
  });

  // Auth
  route('POST', '/v1/auth/register', async ({ req }) => {
    limit(`reg:${ipOf(req)}`, 10, 3600_000);
    const b = await readBody(req);
    const mail = v.email(b.email);
    const name = v.str(b.name, 'name', { max: 80 });
    const pw = v.password(b.password);
    if (store.list('users', (u) => u.email === mail).length) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    const user = {
      id: id('u_'), email: mail, name, phone: '', pw: await hashPassword(pw),
      tokenVersion: 1, createdAt: new Date(now()).toISOString(),
    };
    await store.put('users', user.id, user);
    return { status: 201, body: issue(user) };
  });

  route('POST', '/v1/auth/login', async ({ req }) => {
    const b = await readBody(req);
    const mail = v.email(b.email);
    limit(`login:${ipOf(req)}:${mail}`, 10, 15 * 60_000);
    const user = store.list('users', (u) => u.email === mail)[0];
    // Same work and same message whether or not the account exists.
    const ok = user
      ? await verifyPassword(String(b.password ?? ''), user.pw)
      : (await verifyPassword('x', 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AA=='), false);
    if (!ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
    return { status: 200, body: issue(user) };
  });

  // Google sign-in: the app signs in with Firebase, then trades the Firebase ID
  // token here for this API's own session. Accounts are matched by Firebase uid,
  // then by verified email (which links an existing password account).
  route('POST', '/v1/auth/google', async ({ req }) => {
    if (!firebase.configured) throw new HttpError(404, 'google_unavailable', 'Google sign-in is not enabled.');
    limit(`google:${ipOf(req)}`, 20, 15 * 60_000);
    const { idToken } = await readBody(req);
    let who;
    try {
      who = await firebase.verify(idToken);
    } catch (e) {
      if (!(e instanceof TokenError)) throw new HttpError(502, 'google_unavailable', 'Could not verify the Google sign-in. Try again.');
      throw new HttpError(401, 'invalid_token', 'Google sign-in could not be verified.');
    }
    let user = store.list('users', (u) => u.firebaseUid === who.uid)[0]
      ?? store.list('users', (u) => u.email === who.email)[0];
    if (user) {
      if (user.firebaseUid && user.firebaseUid !== who.uid) throw new HttpError(409, 'account_conflict', 'This email is linked to a different Google account.');
      if (!user.firebaseUid) {
        user.firebaseUid = who.uid;
        await store.put('users', user.id, user);
      }
    } else {
      user = {
        id: id('u_'), email: who.email, name: who.name, phone: '',
        pw: null, // no password: they can set one later through password reset
        firebaseUid: who.uid, tokenVersion: 1, createdAt: new Date(now()).toISOString(),
      };
      await store.put('users', user.id, user);
    }
    return { status: 200, body: issue(user) };
  });

  route('POST', '/v1/auth/password-reset/request', async ({ req }) => {
    limit(`reset:${ipOf(req)}`, 5, 3600_000);
    const mail = v.email((await readBody(req)).email);
    const user = store.list('users', (u) => u.email === mail)[0];
    if (user) {
      const code = String(randomInt(100000, 1000000));
      await store.put('resets', user.id, {
        id: user.id, hash: hashCode(code, config.jwtSecret), expires: now() + RESET_TTL_MS, attempts: 0,
      });
      await mailer.send(user.email, 'Your DesignWear reset code', `Your reset code is ${code}. It expires in 15 minutes.`);
    }
    // Always the same answer, so this can't be used to find registered emails.
    return { status: 202, body: { ok: true } };
  });

  route('POST', '/v1/auth/password-reset/confirm', async ({ req }) => {
    limit(`resetc:${ipOf(req)}`, 10, 3600_000);
    const b = await readBody(req);
    const mail = v.email(b.email);
    const pw = v.password(b.password);
    const user = store.list('users', (u) => u.email === mail)[0];
    const reset = user && store.get('resets', user.id);
    const invalid = new HttpError(400, 'invalid_code', 'That code is invalid or has expired.');
    if (!reset || reset.expires < now() || reset.attempts >= 5) throw invalid;
    if (!safeEqual(reset.hash, hashCode(String(b.code ?? ''), config.jwtSecret))) {
      await store.put('resets', user.id, { ...reset, attempts: reset.attempts + 1 });
      throw invalid;
    }
    user.pw = await hashPassword(pw);
    user.tokenVersion += 1; // signs out every existing session
    await store.put('users', user.id, user);
    await store.del('resets', user.id);
    return { status: 200, body: { ok: true } };
  });

  route('GET', '/v1/me', async ({ req }) => ({ status: 200, body: { user: publicUser(authed(req)) } }));

  route('PATCH', '/v1/me', async ({ req }) => {
    const user = authed(req);
    const b = await readBody(req);
    if (b.name !== undefined) user.name = v.str(b.name, 'name', { max: 80 });
    if (b.phone !== undefined) user.phone = v.str(String(b.phone), 'phone', { min: 0, max: 20 });
    await store.put('users', user.id, user);
    return { status: 200, body: { user: publicUser(user) } };
  });

  route('POST', '/v1/me/password', async ({ req }) => {
    const user = authed(req);
    const b = await readBody(req);
    if (!(await verifyPassword(String(b.current ?? ''), user.pw))) throw new HttpError(403, 'invalid_credentials', 'Current password is incorrect.');
    user.pw = await hashPassword(v.password(b.password));
    user.tokenVersion += 1;
    await store.put('users', user.id, user);
    return { status: 200, body: issue(user) };
  });

  // Addresses
  route('GET', '/v1/me/addresses', async ({ req }) => {
    const user = authed(req);
    return { status: 200, body: { addresses: store.get('addresses', user.id)?.items ?? [] } };
  });
  route('PUT', '/v1/me/addresses', async ({ req }) => {
    const user = authed(req);
    const list = (await readBody(req)).addresses;
    if (!Array.isArray(list) || list.length > 20) throw bad('invalid_address', 'At most 20 addresses.');
    const items = list.map((a) => ({ ...v.address(a), id: v.address(a).id ?? id('a_') }));
    await store.put('addresses', user.id, { id: user.id, items });
    return { status: 200, body: { addresses: items } };
  });

  // Cart
  route('GET', '/v1/cart', async ({ req }) => {
    const user = authed(req);
    return { status: 200, body: { lines: store.get('carts', user.id)?.lines ?? [] } };
  });
  route('PUT', '/v1/cart', async ({ req }) => {
    const user = authed(req);
    const raw = (await readBody(req)).lines ?? [];
    const clean = raw.length ? v.lines(raw) : [];
    const enriched = [];
    for (const l of clean) {
      if (l.designId) {
        const d = store.get('designs', l.designId);
        if (!d || (!d.published && d.ownerId !== user.id)) continue; // dropped: no longer available
        enriched.push({ ...l, title: `${d.name} (${d.garment})`, unitPrice: v.GARMENT_PRICES[d.garment] ?? 499, imageUrl: null });
        continue;
      }
      const p = await catalog.product(l.productId).catch(() => null);
      enriched.push({ ...l, title: p?.title ?? l.productId, unitPrice: p?.price ?? 0, imageUrl: p?.imageUrl ?? null });
    }
    await store.put('carts', user.id, { id: user.id, lines: enriched });
    return { status: 200, body: { lines: enriched } };
  });

  // Orders
  route('POST', '/v1/orders', async ({ req }) => {
    const user = authed(req);
    limit(`order:${user.id}`, 20, 3600_000);
    const b = await readBody(req);
    const priced = await priceLines(user.id, b.lines);
    const method = b.paymentMethod === 'razorpay' ? 'razorpay' : 'cod';
    if (method === 'razorpay' && !(config.razorpay.keyId && config.razorpay.keySecret)) {
      throw bad('payments_unavailable', 'Online payments are not enabled.');
    }
    const order = {
      id: 'DW' + randomBytes(5).toString('hex').toUpperCase(),
      userId: user.id,
      createdAt: new Date(now()).toISOString(),
      ...priced,
      address: v.address(b.address),
      payment: { method, status: method === 'cod' ? 'pay_on_delivery' : 'pending' },
      status: method === 'cod' ? 'placed' : 'awaiting_payment',
    };
    await store.put('orders', order.id, order);
    if (method === 'cod') await store.put('carts', user.id, { id: user.id, lines: [] });
    return { status: 201, body: { order } };
  });

  route('GET', '/v1/orders', async ({ req }) => {
    const user = authed(req);
    const orders = store.list('orders', (o) => o.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { status: 200, body: { orders } };
  });

  route('POST', '/v1/orders/:orderId/cancel', async ({ req, params }) => {
    const user = authed(req);
    const order = store.get('orders', params.orderId);
    if (!order || order.userId !== user.id) throw new HttpError(404, 'not_found');
    if (!['placed', 'awaiting_payment'].includes(order.status)) throw new HttpError(409, 'not_cancellable', 'This order can no longer be cancelled.');
    order.status = 'cancelled';
    await store.put('orders', order.id, order);
    return { status: 200, body: { order } };
  });

  // Razorpay
  route('POST', '/v1/payments/razorpay/order', async ({ req }) => {
    const user = authed(req);
    const { keyId, keySecret } = config.razorpay;
    if (!keyId || !keySecret) throw bad('payments_unavailable', 'Online payments are not enabled.');
    const order = store.get('orders', String((await readBody(req)).orderId ?? ''));
    if (!order || order.userId !== user.id || order.status !== 'awaiting_payment') throw new HttpError(404, 'not_found');
    const res = await (config.fetch ?? fetch)('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({ amount: Math.round(order.total * 100), currency: 'INR', receipt: order.id }),
    });
    if (!res.ok) throw new HttpError(502, 'payment_provider_error', 'Could not start the payment.');
    const rz = await res.json();
    order.payment = { ...order.payment, razorpayOrderId: rz.id };
    await store.put('orders', order.id, order);
    return { status: 200, body: { razorpayOrderId: rz.id, amount: rz.amount, currency: rz.currency, keyId } };
  });

  route('POST', '/v1/payments/razorpay/verify', async ({ req }) => {
    const user = authed(req);
    const b = await readBody(req);
    const order = store.get('orders', String(b.orderId ?? ''));
    if (!order || order.userId !== user.id || !order.payment.razorpayOrderId) throw new HttpError(404, 'not_found');
    const expected = createHmac('sha256', config.razorpay.keySecret)
      .update(`${order.payment.razorpayOrderId}|${String(b.paymentId ?? '')}`).digest('hex');
    const given = String(b.signature ?? '');
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw bad('invalid_signature', 'Payment could not be verified.');
    }
    order.payment = { ...order.payment, status: 'paid', paymentId: String(b.paymentId) };
    order.status = 'placed';
    await store.put('orders', order.id, order);
    await store.put('carts', user.id, { id: user.id, lines: [] });
    return { status: 200, body: { order } };
  });

  // Community designs
  const publicDesign = (d, userId) => ({
    id: d.id, name: d.name, garment: d.garment, baseColor: d.baseColor, front: d.front, back: d.back,
    creatorName: d.ownerName, creatorHandle: d.handle, likeCount: d.likeCount, remixCount: d.remixCount,
    remixedFrom: d.remixedFrom ?? null, lineage: d.lineage ?? [], published: d.published,
    createdAt: d.createdAt, price: v.GARMENT_PRICES[d.garment] ?? 499,
    challengeId: d.challengeId ?? null,
    designJson: d.designJson ?? null, previewImage: d.previewImage ?? null, backPreviewImage: d.backPreviewImage ?? null,
    liked: userId ? Boolean(store.get('likes', `${d.id}:${userId}`)) : false, mine: d.ownerId === userId,
  });

  const optionalUser = (req) => { try { return authed(req); } catch { return null; } };

  route('POST', '/v1/designs', async ({ req }) => {
    const user = authed(req);
    limit(`design:${user.id}`, 60, 3600_000);
    const b = await readBody(req, 1_500_000);
    const garment = v.garmentName(b.garment ?? '');
    if (!(garment in v.GARMENT_PRICES)) throw bad('invalid_garment');
    const existing = b.id ? store.get('designs', String(b.id)) : null;
    if (existing && existing.ownerId !== user.id) throw new HttpError(403, 'forbidden');
    // A design enters a challenge when it is first published into one that is open.
    let challengeId = existing?.challengeId ?? null;
    if (!existing && b.challengeId) {
      const c = store.get('challenges', String(b.challengeId));
      if (!c || !isOpen(c)) throw bad('challenge_closed', 'That challenge is not open.');
      if (b.published !== true) throw bad('challenge_needs_publish', 'Challenge entries must be published.');
      challengeId = c.id;
    }
    let remixedFrom = existing?.remixedFrom ?? null;
    let lineage = existing?.lineage ?? [];
    if (!existing && b.remixOf) {
      const parent = store.get('designs', String(b.remixOf));
      if (!parent || !parent.published) throw bad('unknown_design', 'The design you are remixing is not available.');
      remixedFrom = { id: parent.id, name: parent.name, handle: parent.handle };
      lineage = [...(parent.lineage ?? []), { id: parent.id, handle: parent.handle, name: parent.name }].slice(-10);
      parent.remixCount += 1;
      await store.put('designs', parent.id, parent);
    }
    const design = {
      id: existing?.id ?? id('d_'),
      ownerId: user.id, ownerName: user.name, handle: handleOf(user.name),
      name: v.str(b.name, 'name', { max: 60 }),
      garment,
      baseColor: Number.isInteger(b.baseColor) ? b.baseColor >>> 0 : 0xffffffff,
      front: v.elements(b.front), back: v.elements(b.back),
      // The Design Studio's own format (richer than front/back elements) plus rendered previews.
      designJson: v.studioDesign(b.designJson) ?? existing?.designJson ?? null,
      previewImage: v.preview(b.previewImage, 'previewImage') ?? existing?.previewImage ?? null,
      backPreviewImage: v.preview(b.backPreviewImage, 'backPreviewImage') ?? existing?.backPreviewImage ?? null,
      published: b.published === true,
      likeCount: existing?.likeCount ?? 0, remixCount: existing?.remixCount ?? 0,
      remixedFrom, lineage, challengeId,
      createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
    };
    await store.put('designs', design.id, design);
    return { status: existing ? 200 : 201, body: { design: publicDesign(design, user.id) } };
  });

  route('GET', '/v1/designs', async ({ req, query }) => {
    const user = optionalUser(req);
    const mine = query.get('mine') === '1';
    if (mine && !user) throw new HttpError(401, 'unauthenticated');
    let list = store.list('designs', (d) => (mine ? d.ownerId === user.id : d.published));
    list.sort(query.get('sort') === 'popular'
      ? (a, b) => b.likeCount + b.remixCount - (a.likeCount + a.remixCount)
      : (a, b) => b.createdAt.localeCompare(a.createdAt));
    const limitN = Math.min(Number(query.get('limit')) || 30, 100);
    return { status: 200, body: { designs: list.slice(0, limitN).map((d) => publicDesign(d, user?.id)) } };
  });

  route('GET', '/v1/designs/:designId', async ({ req, params }) => {
    const user = optionalUser(req);
    const d = store.get('designs', params.designId);
    if (!d || (!d.published && d.ownerId !== user?.id)) throw new HttpError(404, 'not_found');
    return { status: 200, body: { design: publicDesign(d, user?.id) } };
  });

  route('DELETE', '/v1/designs/:designId', async ({ req, params }) => {
    const user = authed(req);
    const d = store.get('designs', params.designId);
    if (!d || d.ownerId !== user.id) throw new HttpError(404, 'not_found');
    await store.del('designs', d.id);
    return { status: 200, body: { ok: true } };
  });

  route('POST', '/v1/designs/:designId/like', async ({ req, params }) => {
    const user = authed(req);
    const d = store.get('designs', params.designId);
    if (!d || !d.published) throw new HttpError(404, 'not_found');
    const key = `${d.id}:${user.id}`;
    const liked = !store.get('likes', key);
    if (liked) await store.put('likes', key, { id: key }); else await store.del('likes', key);
    d.likeCount = Math.max(0, d.likeCount + (liked ? 1 : -1));
    await store.put('designs', d.id, d);
    return { status: 200, body: { liked, likeCount: d.likeCount } };
  });

  // Weekly challenges
  const isOpen = (c) => now() >= Date.parse(c.startsAt) && now() < Date.parse(c.endsAt);
  const entriesOf = (c) => store.list('designs', (d) => d.challengeId === c.id && d.published);
  const publicChallenge = (c) => ({
    id: c.id, title: c.title, description: c.description,
    startsAt: c.startsAt, endsAt: c.endsAt, open: isOpen(c), entries: entriesOf(c).length,
  });

  route('GET', '/v1/challenges/current', async () => {
    const open = store.list('challenges', isOpen).sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
    return { status: 200, body: { challenge: open ? publicChallenge(open) : null } };
  });

  route('GET', '/v1/challenges/:challengeId/entries', async ({ req, params }) => {
    const user = optionalUser(req);
    const c = store.get('challenges', params.challengeId);
    if (!c) throw new HttpError(404, 'not_found');
    const designs = entriesOf(c)
      .sort((a, b) => b.likeCount - a.likeCount || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
    return { status: 200, body: { challenge: publicChallenge(c), designs: designs.map((d) => publicDesign(d, user?.id)) } };
  });

  // Admin: only exists when DESIGNWEAR_ADMIN_TOKEN is set.
  route('PUT', '/v1/admin/challenges/:challengeId', async ({ req, params }) => {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!config.adminToken) throw new HttpError(404, 'not_found');
    limit(`admin:${ipOf(req)}`, 30, 60_000);
    if (!safeEqual(given, config.adminToken)) throw new HttpError(401, 'unauthenticated', 'Admin token required.');
    if (!/^[a-z0-9-]{2,40}$/.test(params.challengeId)) throw bad('invalid_id', 'Use lowercase letters, numbers and dashes.');
    const c = { id: params.challengeId, ...v.challengeInput(await readBody(req)) };
    await store.put('challenges', c.id, c);
    return { status: 200, body: { challenge: publicChallenge(c) } };
  });

  // Public catalog (originals that can be sold). The app loads products from here, so
  // browsers never call the CMS gateway directly and its token never ships in the app.
  route('GET', '/v1/products', async ({ query }) => {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 40, 1), 200);
    let items = await catalog.products();
    if (query.get('featured') === '1') items = items.filter((p) => p.raw?.featured === true);
    return { status: 200, body: { data: items.slice(0, limit).map((p) => p.raw ?? p) } };
  });

  route('GET', '/v1/products/:productId', async ({ params }) => {
    const p = await catalog.product(params.productId);
    if (!p) throw new HttpError(404, 'not_found');
    return { status: 200, body: { data: p.raw ?? p } };
  });

  // Product images for browsers. The image CDN only allows origins on its own list, so a
  // web app on another origin gets 403; the API fetches the image instead. Only paths of
  // the form /images/<project>/<dataset>/<hash>-<w>x<h>.<ext> on an allow-listed host.
  const imageCache = new Map(); // key -> { type, body, at }
  route('GET', '/v1/img/:host/:project/:dataset/:file', async ({ req, params, query }) => {
    limit(`img:${ipOf(req)}`, 600, 60_000);
    const { host, project, dataset, file } = params;
    if (!config.imageHosts.includes(host)
        || !/^[a-z0-9]{4,20}$/.test(project) || !/^[a-z0-9-]{2,30}$/.test(dataset)
        || !/^[a-f0-9]{40}-\d{1,5}x\d{1,5}\.(jpg|jpeg|png|webp|gif)$/.test(file)) {
      throw new HttpError(404, 'not_found');
    }
    // Only resizing options are passed on, each strictly validated.
    const qs = new URLSearchParams();
    const w = Number(query.get('w')); if (Number.isInteger(w) && w >= 16 && w <= 2000) qs.set('w', String(w));
    const q = Number(query.get('q')); if (Number.isInteger(q) && q >= 20 && q <= 100) qs.set('q', String(q));
    if (query.get('auto') === 'format') qs.set('auto', 'format');
    const key = `${host}/${project}/${dataset}/${file}?${qs}`;
    let hit = imageCache.get(key);
    if (!hit || now() - hit.at > 3600_000) {
      const res = await fetchImpl(`https://${host}/images/${project}/${dataset}/${file}?${qs}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'image_unavailable', 'Image unavailable.');
      const type = res.headers.get('content-type') ?? '';
      const body = Buffer.from(await res.arrayBuffer());
      if (!type.startsWith('image/') || body.length > 8_000_000) throw new HttpError(502, 'image_unavailable', 'Image unavailable.');
      hit = { type, body, at: now() };
      imageCache.set(key, hit);
      if (imageCache.size > 60) imageCache.delete(imageCache.keys().next().value);
    }
    return { status: 200, raw: { type: hit.type, body: hit.body } };
  });

  // Search
  route('GET', '/v1/search', async ({ query }) => {
    const q = (query.get('q') ?? '').trim().toLowerCase().slice(0, 100);
    const terms = q.split(/\s+/).filter(Boolean);
    const all = await catalog.products();
    const score = (p) => {
      let s = 0;
      const title = p.title.toLowerCase();
      for (const t of terms) {
        if (title === t) s += 10;
        else if (title.startsWith(t)) s += 6;
        else if (title.includes(t)) s += 4;
        if (p.tags.some((x) => x.toLowerCase().includes(t))) s += 2;
        if (p.productType.toLowerCase().includes(t)) s += 2;
        if (p.description.toLowerCase().includes(t)) s += 1;
      }
      return s;
    };
    let results = terms.length
      ? all.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p)
      : all;
    if (query.get('inStock') === '1') results = results.filter((p) => p.stock > 0);
    return { status: 200, body: { results: results.slice(0, 50) } };
  });

  // AI
  route('POST', '/v1/ai/try-on', async ({ req }) => {
    const user = authed(req);
    limit(`tryon:${user.id}`, 10, 3600_000);
    const b = await readBody(req, 12_000_000);
    const photo = Buffer.from(String(b.photo ?? ''), 'base64');
    if (photo.length < 100 || photo.length > 6_000_000) throw bad('invalid_photo', 'Photo must be under 6 MB.');
    // Either a catalog product (its own image is fetched server-side) or the
    // customer's own design as an image. A URL is never accepted from the client.
    let product = null;
    let garment = null;
    if (b.garment) {
      garment = Buffer.from(String(b.garment), 'base64');
      if (garment.length < 100 || garment.length > 3_000_000) throw bad('invalid_garment_image', 'Design image must be under 3 MB.');
    } else {
      product = await catalog.product(String(b.productId ?? ''));
      if (!product?.imageUrl) throw bad('unknown_product');
    }
    return { status: 200, body: { image: await ai.tryOn(photo, product ?? { title: String(b.title ?? 'custom design').slice(0, 80) }, garment) } };
  });

  // Design Studio assistant: the prompt and keys stay here. Returns the reply
  // text and, when the model produced one, a design to apply.
  route('POST', '/v1/ai/design-agent', async ({ req }) => {
    const user = authed(req);
    limit(`agent:${user.id}`, 60, 3600_000);
    const b = await readBody(req, 6_000_000);
    const message = v.str(String(b.message ?? ''), 'message', { max: 2000 });
    const history = Array.isArray(b.history) ? b.history.slice(-12).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(m?.content ?? '').slice(0, 4000),
    })) : [];
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 3).map((i) => String(i)).filter((i) => i.length < 2_500_000);
    const design = b.design && typeof b.design === 'object' ? JSON.stringify(b.design).slice(0, 60_000) : '{}';
    return { status: 200, body: await ai.designAgent({ message, history, images, design }) };
  });

  route('POST', '/v1/ai/design-image', async ({ req }) => {
    const user = authed(req);
    limit(`dimage:${user.id}`, 20, 3600_000);
    const prompt = v.str(String((await readBody(req)).prompt ?? ''), 'prompt', { max: 400 });
    return { status: 200, body: { image: await ai.designImage(prompt) } };
  });

  // ── dispatcher ─────────────────────────────────────────────────────────
  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    // In development any localhost port may call the API (flutter run -d web-server
    // picks one); production only ever allows the configured origins.
    const devLocal = !config.production && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');
    return origin && (config.allowedOrigins.includes(origin) || devLocal)
      ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const started = process.hrtime.bigint();
    const requestId = randomBytes(6).toString('hex');
    let userId;
    res.on('finish', () => {
      // Method, route, status, timing only: never bodies, queries or tokens.
      logger.request({
        id: requestId, method: req.method, path: url.pathname, status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), userId,
      });
    });
    const base = {
      'x-request-id': requestId,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...corsHeaders(req),
    };
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...base, ...extra });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') {
        return send(204, undefined, {
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-max-age': '600',
        });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const out = await r.handler({ req, params, query: url.searchParams });
        userId = optionalUser(req)?.id;
        if (out.raw) {
          // Binary answer (an image): cacheable by browsers, readable cross-origin.
          res.writeHead(out.status, {
            ...base,
            'content-type': out.raw.type,
            'cache-control': 'public, max-age=86400',
            'cross-origin-resource-policy': 'cross-origin',
          });
          return res.end(out.raw.body);
        }
        return send(out.status, out.body);
      }
      const pathKnown = routes.some((r) => r.re.test(url.pathname));
      return send(pathKnown ? 405 : 404, { error: { code: pathKnown ? 'method_not_allowed' : 'not_found' } });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: { code: e.code, message: e.message } });
      logger.error(`Unhandled error (request ${requestId}): ${e.message}`, e);
      return send(500, { error: { code: 'internal', message: 'Something went wrong.' } });
    }
  };
}
