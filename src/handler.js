// The HTTP entry point: CORS, request logging, routing, and error mapping.
import { randomBytes } from 'node:crypto';

import { HttpError } from './validate.js';

const DEV_LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createHandler({ ctx, router }) {
  const { config, logger, optionalUser } = ctx;

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    // In development any localhost port may call the API (flutter run -d
    // web-server picks one); production only allows the configured origins.
    const devLocal = !config.production && DEV_LOCALHOST.test(origin);
    const allowed = config.allowedOrigins.includes(origin) || devLocal;
    return allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const started = process.hrtime.bigint();
    const requestId = randomBytes(6).toString('hex');
    let userId;

    res.on('finish', () => {
      // Method, route, status, timing only: never bodies, queries or tokens.
      const elapsedNs = Number(process.hrtime.bigint() - started);
      logger.request({
        id: requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Math.round(elapsedNs / 1e6),
        userId,
      });
    });

    const baseHeaders = {
      'x-request-id': requestId,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...corsHeaders(req),
    };

    function sendJson(status, body, extraHeaders = {}) {
      res.writeHead(status, { ...baseHeaders, ...extraHeaders });
      res.end(body === undefined ? '' : JSON.stringify(body));
    }

    // A binary answer (an image): cacheable by browsers, readable cross-origin.
    function sendRaw(status, raw) {
      res.writeHead(status, {
        ...baseHeaders,
        'content-type': raw.type,
        'cache-control': 'public, max-age=86400',
        'cross-origin-resource-policy': 'cross-origin',
        ...raw.headers,
      });
      res.end(raw.body);
    }

    try {
      if (req.method === 'OPTIONS') {
        return sendJson(204, undefined, {
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-max-age': '600',
        });
      }

      const found = router.match(req.method, url.pathname);

      if (!found) {
        const methodNotAllowed = router.pathExists(url.pathname);
        return sendJson(methodNotAllowed ? 405 : 404, {
          error: { code: methodNotAllowed ? 'method_not_allowed' : 'not_found' },
        });
      }

      const result = await found.handler({
        req,
        params: found.params,
        query: url.searchParams,
      });
      userId = (await optionalUser(req))?.id;

      if (result.raw) return sendRaw(result.status, result.raw);
      return sendJson(result.status, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(error.status, {
          error: { code: error.code, message: error.message },
        });
      }
      logger.error(`Unhandled error (request ${requestId}): ${error.message}`, error);
      return sendJson(500, {
        error: { code: 'internal', message: 'Something went wrong.' },
      });
    }
  };
}
