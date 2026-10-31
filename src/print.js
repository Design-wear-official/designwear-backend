// Print sheets: what the print team needs to make a custom order. Each custom line has a
// signed link (no sign-in, nothing to guess) to a page with the front and back artwork,
// garment colour, size, quantity and the text, fonts and colours used.
import { createHmac, timingSafeEqual } from 'node:crypto';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The signature that proves a link came from us. Tied to the job and nothing else. */
export const printSignature = (jobId, secret) =>
  createHmac('sha256', secret).update(`print:${jobId}`).digest('hex').slice(0, 32);

export function validSignature(jobId, signature, secret) {
  const given = Buffer.from(String(signature ?? ''));
  const wanted = Buffer.from(printSignature(jobId, secret));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Link to a job's print sheet, or '' when the public address is not configured. */
export function printLink(baseUrl, jobId, secret) {
  if (!baseUrl || !jobId) return '';
  return `${baseUrl.replace(/\/+$/, '')}/v1/print/${encodeURIComponent(jobId)}?sig=${printSignature(jobId, secret)}`;
}

// The image's type from its first bytes (PNG or JPEG), and its raw bytes.
export function decodeImage(base64) {
  if (!base64) return null;
  const body = Buffer.from(String(base64), 'base64');
  if (body[0] === 0x89 && body[1] === 0x50) return { type: 'image/png', body };
  if (body[0] === 0xff && body[1] === 0xd8) return { type: 'image/jpeg', body };
  return null;
}

// Plain-language list of what is on the shirt, from the saved design.
function elementLines(design) {
  const elements = design?.designJson?.elements ?? design?.elements ?? [];
  return elements
    .slice(0, 60)
    .map((e) => {
      const font = e.properties?.fontFamily ? `, ${e.properties.fontFamily}` : '';
      const colour = e.color ? `, colour ${String(e.color).replace(/^0xFF/i, '#')}` : '';
      return `${e.type ?? 'item'}: ${e.content ?? ''}${font}${colour}`;
    });
}

/** The HTML sheet for one print job. `imageUrl(side)` gives the link for each picture. */
export function printSheet(job, order, imageUrl) {
  const design = job.design ?? {};
  const base = String(design.baseColor ?? '').replace(/^0xFF/i, '#');
  const picture = (side, label) =>
    (side === 'front' ? design.previewImage : design.backPreviewImage)
      ? `<figure><img src="${escapeHtml(imageUrl(side))}" alt="${label}" style="max-width:100%;border:1px solid #ccc"><figcaption>${label}</figcaption></figure>`
      : '';
  const lines = elementLines(design).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const cancelled = job.status === 'cancelled' ? '<p style="color:#b00020"><b>CANCELLED. Do not print.</b></p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Print sheet ${escapeHtml(job.id)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111">
<h2>Print sheet ${escapeHtml(job.id)}</h2>${cancelled}
<table style="border-collapse:collapse"><tr><td style="padding:2px 12px 2px 0"><b>Order</b></td><td>${escapeHtml(job.orderId)}</td></tr>
<tr><td><b>Design</b></td><td>${escapeHtml(design.name ?? '')}</td></tr>
<tr><td><b>Garment</b></td><td>${escapeHtml(design.garment ?? '')}</td></tr>
<tr><td><b>Garment colour</b></td><td>${escapeHtml(base)}</td></tr>
<tr><td><b>Size</b></td><td>${escapeHtml(job.size)}</td></tr>
<tr><td><b>Quantity</b></td><td>${escapeHtml(job.quantity)}</td></tr>
${order?.team?.name ? `<tr><td><b>Team</b></td><td>${escapeHtml(order.team.name)}</td></tr>` : ''}</table>
<h3>Artwork</h3>${picture('front', 'Front')}${picture('back', 'Back')}
<h3>On the shirt</h3><ul>${lines || '<li>No details saved.</li>'}</ul>
<p style="color:#666;font-size:12px">This is the preview saved with the order. Ask the customer if you need a higher resolution file.</p>
</body></html>`;
}
