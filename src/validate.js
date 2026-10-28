export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const bad = (code, message) => new HttpError(400, code, message);

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const GARMENT_PRICES = { 'T-Shirt': 499, Hoodie: 999, Sweatshirt: 799, 'Tank Top': 399 };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function str(v, name, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw bad('invalid_field', `${name} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) {
    throw bad('invalid_field', `${name} must be ${min}-${max} characters`);
  }
  return s;
}

export function email(v) {
  const s = str(v, 'email', { max: 320 }).toLowerCase();
  if (!EMAIL.test(s)) throw bad('invalid_email', 'Enter a valid email.');
  return s;
}

export function password(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) {
    throw bad('weak_password', 'Password must be 8-200 characters.');
  }
  return v;
}

const clamp = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

export function elements(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 30) throw bad('too_many_elements', 'At most 30 elements per side.');
  return list.map((e, i) => {
    if (!e || typeof e !== 'object') throw bad('invalid_element');
    const type = e.type === 'sticker' ? 'sticker' : 'text';
    return {
      id: String(e.id ?? i).slice(0, 40),
      type,
      content: str(String(e.content ?? ''), 'content', { max: 40 }),
      x: clamp(Number(e.x), 0, 1, 0.5),
      y: clamp(Number(e.y), 0, 1, 0.5),
      size: clamp(Number(e.size), 8, 160, 32),
      color: Number.isInteger(e.color) ? e.color >>> 0 : 0xff000000,
    };
  });
}

export function address(a) {
  if (!a || typeof a !== 'object') throw bad('invalid_address');
  const pin = str(String(a.pin ?? ''), 'pin', { min: 6, max: 6 });
  if (!/^\d{6}$/.test(pin)) throw bad('invalid_address', 'PIN code must be 6 digits.');
  return {
    id: String(a.id ?? '').slice(0, 40) || undefined,
    label: str(String(a.label ?? ''), 'label', { max: 30 }),
    name: str(String(a.name ?? ''), 'name', { max: 80 }),
    phone: str(String(a.phone ?? ''), 'phone', { min: 6, max: 20 }),
    line1: str(String(a.line1 ?? ''), 'line1', { max: 200 }),
    city: str(String(a.city ?? ''), 'city', { max: 80 }),
    state: str(String(a.state ?? ''), 'state', { max: 80 }),
    pin,
  };
}

export function lines(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
    throw bad('invalid_lines', 'Between 1 and 50 items are required.');
  }
  return list.map((l) => {
    if (!l || typeof l !== 'object') throw bad('invalid_lines');
    const size = String(l.size ?? '');
    if (!SIZES.includes(size)) throw bad('invalid_size', `Size must be one of ${SIZES.join(', ')}.`);
    const quantity = Number(l.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw bad('invalid_quantity');
    return {
      productId: str(String(l.productId ?? ''), 'productId', { max: 100 }),
      designId: l.designId ? str(String(l.designId), 'designId', { max: 60 }) : null,
      size,
      quantity,
    };
  });
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function logEntries(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
    throw bad('invalid_logs', 'Send between 1 and 50 entries.');
  }
  return list.map((e) => ({
    level: ['debug', 'info', 'warning', 'error'].includes(e?.level) ? e.level : 'info',
    message: String(e?.message ?? '').slice(0, 1000),
    stack: e?.stack ? String(e.stack).slice(0, 4000) : undefined,
    at: typeof e?.at === 'string' ? e.at.slice(0, 30) : undefined,
    tag: e?.tag ? String(e.tag).slice(0, 40) : undefined,
  }));
}

const GARMENT_ALIASES = { tshirt: 'T-Shirt', hoodie: 'Hoodie', sweatshirt: 'Sweatshirt', tank: 'Tank Top' };
export const garmentName = (g) => GARMENT_ALIASES[String(g)] ?? String(g);

/** The Design Studio's own design JSON, stored as-is but size-limited and shape-checked. */
export function studioDesign(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_design', 'designJson must be an object.');
  const text = JSON.stringify(d);
  if (text.length > 400_000) throw bad('design_too_large', 'Design is too large (max 400 KB).');
  if (!Array.isArray(d.elements) || d.elements.length > 60) {
    throw bad('invalid_design', 'A design has at most 60 elements.');
  }
  return d;
}

/** Base64 PNG/JPEG preview, capped so the store stays small. */
export function preview(b64, name) {
  if (b64 === undefined || b64 === null || b64 === '') return null;
  const s = String(b64);
  if (s.length > 450_000 || !/^[A-Za-z0-9+/=]+$/.test(s)) {
    throw bad('invalid_preview', `${name} must be a base64 image under ~330 KB.`);
  }
  const head = Buffer.from(s.slice(0, 16), 'base64');
  const png = head[0] === 0x89 && head[1] === 0x50;
  const jpg = head[0] === 0xff && head[1] === 0xd8;
  if (!png && !jpg) throw bad('invalid_preview', `${name} must be a PNG or JPEG.`);
  return s;
}

export function challengeInput(b) {
  const startsAt = new Date(String(b.startsAt ?? ''));
  const endsAt = new Date(String(b.endsAt ?? ''));
  if (Number.isNaN(+startsAt) || Number.isNaN(+endsAt) || endsAt <= startsAt) {
    throw bad('invalid_dates', 'startsAt and endsAt must be dates, with endsAt after startsAt.');
  }
  return {
    title: str(b.title, 'title', { max: 80 }),
    description: str(b.description ?? '', 'description', { min: 0, max: 400 }),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}
