// Health, public feature flags, and client diagnostics.
import { redact } from '../logger.js';
import * as v from '../validate.js';

const CLIENT_LOG_MAX_BYTES = 64_000;

export function registerSystemRoutes(router, ctx) {
  const { config, catalog, ai, firebase, clientLogger } = ctx;

  router.route('GET', '/v1/health', async () => ({
    status: 200,
    body: { ok: true },
  }));

  router.route('GET', '/v1/config', async () => {
    const { keyId, keySecret } = config.razorpay;
    return {
      status: 200,
      body: {
        catalog: catalog.configured,
        designAgent: Boolean(ai.agentConfigured),
        tryOn: Boolean(ai.tryOnConfigured),
        googleSignIn: firebase.configured,
        onlinePayments: Boolean(keyId && keySecret),
        razorpayKeyId: keyId || null,
      },
    };
  });

  // Client diagnostics: warnings and errors the app chooses to report. Open to
  // signed-out users (crashes happen before login), so it is rate limited and
  // capped. Messages are redacted again here; nothing is trusted from the app.
  router.route('POST', '/v1/logs', async ({ req }) => {
    ctx.limit(`logs:${ctx.ipOf(req)}`, 30, 60_000);
    const body = await ctx.readBody(req, CLIENT_LOG_MAX_BYTES);

    const entries = v.logEntries(body.entries).map((entry) => ({
      ...entry,
      message: redact(entry.message),
      stack: entry.stack ? redact(entry.stack) : undefined,
    }));

    const app = body.app && typeof body.app === 'object' ? body.app : {};
    const short = (value) => String(value ?? '').slice(0, 20);

    clientLogger.client(entries, {
      userId: ctx.optionalUser(req)?.id,
      app: {
        version: short(app.version),
        flavour: short(app.flavour),
        platform: short(app.platform),
      },
    });

    return { status: 202, body: { accepted: entries.length } };
  });
}
