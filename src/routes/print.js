// Print sheets for the print team: a signed link per custom line (see ../print.js).
import { decodeImage, printSheet, validSignature } from '../print.js';
import { HttpError } from '../validate.js';

const SHEET_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function registerPrintRoutes(router, ctx) {
  const { config, store } = ctx;

  // Same answer for a wrong signature and a missing job, so nothing can be probed.
  async function load(req, params, query) {
    ctx.limit(`print:${ctx.ipOf(req)}`, 120, 60_000);
    if (!validSignature(params.jobId, query.get('sig'), config.jwtSecret)) throw new HttpError(404, 'not_found');
    const job = await store.get('printjobs', params.jobId);
    if (!job) throw new HttpError(404, 'not_found');
    return job;
  }

  router.route('GET', '/v1/print/:jobId', async ({ req, params, query }) => {
    const job = await load(req, params, query);
    const order = await store.get('orders', job.orderId);
    const sig = query.get('sig');
    const html = printSheet(job, order, (side) => `/v1/print/${encodeURIComponent(job.id)}/${side}.png?sig=${sig}`);
    return {
      status: 200,
      raw: {
        type: 'text/html; charset=utf-8',
        body: html,
        headers: { 'cache-control': 'private, no-store', 'content-security-policy': SHEET_CSP, 'x-robots-tag': 'noindex' },
      },
    };
  });

  router.route('GET', '/v1/print/:jobId/:side', async ({ req, params, query }) => {
    const side = params.side.replace(/\.(png|jpg)$/, '');
    if (!['front', 'back'].includes(side)) throw new HttpError(404, 'not_found');
    const job = await load(req, params, query);
    const image = decodeImage(side === 'front' ? job.design?.previewImage : job.design?.backPreviewImage);
    if (!image) throw new HttpError(404, 'not_found');
    return {
      status: 200,
      raw: { type: image.type, body: image.body, headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } },
    };
  });
}
