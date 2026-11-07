const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The service-account key as JSON text or base64 of it; null when unset or unreadable.
function parseServiceAccount(raw) {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const key = JSON.parse(text);
    return key.client_email && key.private_key && key.project_id ? key : null;
  } catch {
    return null;
  }
}

const httpsOr = (value, fallback) => (/^https:\/\/[^\s]+$/.test(String(value ?? '').trim()) ? String(value).trim().replace(/\/+$/, '') : fallback);

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  // The SethuCMS SDK refuses plain http except to localhost. Set SETHUCMS_ALLOW_HTTP=1 for a gateway on a
  // private network (for example http://cms:3000 in docker-compose).
  const allowHttp = env.SETHUCMS_ALLOW_HTTP === '1';
  const config = {
    production,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    jwtSecret: env.DESIGNWEAR_JWT_SECRET ?? '',
    dataFile: env.DESIGNWEAR_DATA_FILE ?? './.data/store.json',
    clientLogFile: env.DESIGNWEAR_CLIENT_LOG_FILE ?? './.data/client-logs.ndjson',
    // Serverless database (Upstash Redis REST). Vercel's Redis integration
    // sets the KV_REST_API_* names; either pair works.
    redis: {
      url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL ?? '',
      token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN ?? '',
    },
    // Firebase service account (the downloaded JSON key, as text or base64) for
    // Firestore. Takes priority over Redis.
    firestore: { credentials: parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT) },
    // On Vercel there is no writable disk or long-lived process.
    serverless: Boolean(env.VERCEL),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    trustProxy: env.TRUST_PROXY === '1',
    cms: {
      url: (env.SETHUCMS_URL ?? '').replace(/\/+$/, ''),
      connectionId: env.SETHUCMS_CONNECTION_ID ?? '',
      token: env.SETHUCMS_TOKEN ?? '',
      allowHttp,
    },
    // SethuCMS as the shop's own database (users, carts, orders, designs...).
    // Its token needs read-write access to one collection only.
    sethuStore: {
      url: (env.SETHUCMS_URL ?? '').replace(/\/+$/, ''),
      connectionId: env.SETHUCMS_STORE_CONNECTION_ID ?? env.SETHUCMS_CONNECTION_ID ?? '',
      token: env.SETHUCMS_STORE_TOKEN ?? '',
      collection: env.SETHUCMS_STORE_COLLECTION ?? 'dw_store',
      allowHttp,
    },
    // Phone notifications (Firebase Cloud Messaging). A service-account key for the
    // Firebase project, as JSON text or base64. Separate from FIREBASE_SERVICE_ACCOUNT,
    // which would also switch the database to Firestore.
    fcm: { credentials: parseServiceAccount(env.FCM_SERVICE_ACCOUNT) },
    // Shared secret (whsec_...) SethuCMS signs its webhooks with. Unset = no webhook route.
    webhookSecret: env.SETHUCMS_WEBHOOK_SECRET ?? '',
    // Where orders are mirrored in SethuCMS. Needs its own token that can write
    // only the orders collection; the catalog token stays read-only.
    ordersSync: {
      url: (env.SETHUCMS_URL ?? '').replace(/\/+$/, ''),
      connectionId: env.SETHUCMS_ORDERS_CONNECTION_ID ?? env.SETHUCMS_CONNECTION_ID ?? '',
      token: env.SETHUCMS_ORDERS_TOKEN ?? '',
      collection: env.SETHUCMS_ORDERS_COLLECTION ?? 'orders',
      allowHttp,
    },
    razorpay: { keyId: env.RAZORPAY_KEY_ID ?? '', keySecret: env.RAZORPAY_KEY_SECRET ?? '' },
    gemini: {
      apiKey: env.GEMINI_API_KEY ?? '',
      // Chat uses Gemini 3.8 Flash. Confirm the ID in Google AI Studio's model list.
      model: env.GEMINI_MODEL ?? 'gemini-3.8-flash',
      // Try-on must return an image, so it has its own model setting.
      imageModel: env.GEMINI_IMAGE_MODEL ?? 'gemini-nano-banana-2.1',
      // How long the chat model may think: low, medium or high ("minimal" is refused by
      // 3.8 Flash). Empty leaves it to the model. Lower is faster and cheaper.
      thinkingLevel: env.GEMINI_THINKING_LEVEL ?? 'low',
      // Give up on Google before the host's own 60 s limit, so the app gets a clear error.
      timeoutMs: Number(env.GEMINI_TIMEOUT_MS ?? 50_000),
      // Titles (films, shows, brands) the owner has written permission to print. Only these
      // may use their names, characters and logos; everything else protected stays declined.
      licensedTitles: list(env.AI_LICENSED_TITLES),
    },
    mailWebhookUrl: env.MAIL_WEBHOOK_URL ?? '',
    // SMTP (preferred over the webhook when SMTP_HOST is set). MAIL_FROM is "Name <a@b.c>".
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: Number(env.SMTP_PORT ?? 587),
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
      from: env.MAIL_FROM ?? '',
    },
    supportEmail: env.SUPPORT_EMAIL ?? '',
    // This API's public address, used in print-sheet links sent to the print team.
    publicApiUrl: env.PUBLIC_API_URL ?? '',
    // Generative AI uses (assistant message, design image or try-on) per person per day.
    aiDailyLimits: {
      free: Number(env.AI_DAILY_FREE ?? 3),
      pro: Number(env.AI_DAILY_PRO ?? 30),
      ultra: Number(env.AI_DAILY_ULTRA ?? 100),
    },
    // debug | info | warning | error: request lines below this level are dropped.
    logLevel: env.LOG_LEVEL ?? 'info',
    // Enables /v1/admin/* (create weekly challenges). Unset = those routes don't exist.
    // Firebase project whose ID tokens are accepted for Google sign-in. Unset = Google sign-in off.
    firebaseProjectId: env.FIREBASE_PROJECT_ID ?? '',
    // Image CDN the API may fetch on a browser's behalf (browsers are blocked by the
    // CDN's own CORS list). Comma-separated hosts; only /images/<project>/... paths.
    imageHosts: list(env.IMAGE_HOSTS ?? 'cdn.sanity.io'),
    adminToken: env.DESIGNWEAR_ADMIN_TOKEN ?? '',
    // Public addresses shown on the API's home page (GET /). Not secrets; https only; override with env.
    links: {
      hub: httpsOr(env.HUB_URL, 'https://designwear-hub.vercel.app'),
      shop: httpsOr(env.SHOP_URL, 'https://designwear-tawny.vercel.app'),
      staff: httpsOr(env.STAFF_APP_URL, 'https://designwear-scm.vercel.app'),
      cmsAdmin: httpsOr(env.CMS_ADMIN_URL, 'https://sethucms-admin.vercel.app'),
      sdk: httpsOr(env.SDK_URL, 'https://designwear-sdk-docs.vercel.app'),
      rules: httpsOr(env.RULES_URL, 'https://designwear-rules.vercel.app'),
      data: httpsOr(env.DATA_URL, 'https://designwear-data.vercel.app'),
    },
    // Where staff sign in with SethuCMS: the gateway that issues their session (it may include
    // a /w/<workspace> prefix). Unset = the SethuCMS sign-in route does not exist.
    // Defaults to SETHUCMS_URL (the gateway the catalog comes from), so staff sign-in works without a second setting.
    staffSigninUrl: (env.SETHUCMS_SIGNIN_URL || env.SETHUCMS_URL || '').replace(/\/+$/, ''),
    // Returns: days after delivery a customer may ask for one.
    returnWindowDays: Number(env.RETURN_WINDOW_DAYS ?? 7),
    // Vendor payouts: DesignWear keeps this percentage of each delivered order's subtotal.
    commissionPct: Number(env.VENDOR_COMMISSION_PCT ?? 15),
    // Team stock below this many units is reported as low.
    lowStockAt: Number(env.LOW_STOCK_AT ?? 5),
    // Write access to SethuCMS `team_stock`, so vendors can update their own stock. Unset = read only.
    stockToken: env.SETHUCMS_STOCK_TOKEN ?? '',
  };

  // DesignWear's own apps (shop, Staff app, hub) may always call the API from the browser, so adding an
  // app never needs a second edit to ALLOWED_ORIGINS. ALLOWED_ORIGINS adds any other site.
  const explicitOrigins = config.allowedOrigins.slice();
  config.allowedOrigins = [
    ...new Set([...explicitOrigins, ...['shop', 'staff', 'hub'].map((key) => new URL(config.links[key]).origin)]),
  ];

  if (production) {
    const problems = [];
    if (config.jwtSecret.length < 32) problems.push('DESIGNWEAR_JWT_SECRET must be at least 32 characters');
    const hasDatabase =
      config.firestore.credentials ||
      (config.redis.url && config.redis.token) ||
      config.sethuStore.token;
    if (config.serverless && !hasDatabase) {
      problems.push('SETHUCMS_STORE_TOKEN (or FIREBASE_SERVICE_ACCOUNT, or UPSTASH_REDIS_REST_URL and _TOKEN) must be set (no disk on Vercel)');
    }
    if (explicitOrigins.length === 0) problems.push('ALLOWED_ORIGINS must be set');
    if (config.adminToken && config.adminToken.length < 24) {
      problems.push('DESIGNWEAR_ADMIN_TOKEN must be at least 24 characters');
    }
    if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}`);
  } else if (!config.jwtSecret) {
    // Development only: an ephemeral secret, so tokens die with the process.
    config.jwtSecret = `dev-${Math.random().toString(36).slice(2)}${Date.now()}-ephemeral-secret`;
  }
  return config;
}
