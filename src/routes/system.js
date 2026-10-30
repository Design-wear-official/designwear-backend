// Health, public feature flags, and client diagnostics.
import { redact } from '../logger.js';
import * as v from '../validate.js';

const CLIENT_LOG_MAX_BYTES = 64_000;

export function registerSystemRoutes(router, ctx) {
  const { config, catalog, ai, firebase, clientLogger } = ctx;

  // Cheap: is the process up? For frequent uptime pings.
  router.route('GET', '/v1/health/live', async () => ({
    status: 200,
    body: { ok: true },
  }));

  // Deeper: can the API reach its database and catalog? Reports which parts failed
  // (never why: the details go to the logs) with a 503 so an uptime monitor alerts.
  router.route('GET', '/v1/health', async ({ req, query }) => {
    if (query.get('deep') !== '1') return { status: 200, body: { ok: true } };
    ctx.limit(`health:${ctx.ipOf(req)}`, 30, 60_000);
    const checks = {};
    const run = async (name, fn) => {
      try {
        await fn();
        checks[name] = 'ok';
      } catch (error) {
        checks[name] = 'failed';
        ctx.logger.error(`Health check ${name} failed: ${error.message}`, error);
      }
    };
    // A read only: no record needed, an answer (even "none") proves the database is reachable.
    await run('store', () => ctx.store.get('health', 'probe'));
    if (catalog.configured) await run('catalog', () => catalog.product('health-probe'));
    checks.mail = ctx.config.smtp.host || ctx.config.mailWebhookUrl ? 'configured' : 'not_configured';
    const ok = Object.values(checks).every((v) => v !== 'failed');
    return { status: ok ? 200 : 503, body: { ok, checks } };
  });

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
      userId: (await ctx.optionalUser(req))?.id,
      app: {
        version: short(app.version),
        flavour: short(app.flavour),
        platform: short(app.platform),
      },
    });

    return { status: 202, body: { accepted: entries.length } };
  });
}
