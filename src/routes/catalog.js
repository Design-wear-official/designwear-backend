// The public catalog: products, product images, and search.
import { HttpError } from '../validate.js';

const IMAGE_CACHE_TTL_MS = 3600_000;
const IMAGE_CACHE_MAX_ENTRIES = 60;
const IMAGE_MAX_BYTES = 8_000_000;
const SEARCH_MAX_RESULTS = 50;

// Matches the path pieces of /images/<project>/<dataset>/<hash>-<w>x<h>.<ext>.
const PROJECT_PATTERN = /^[a-z0-9]{4,20}$/;
const DATASET_PATTERN = /^[a-z0-9-]{2,30}$/;
const FILE_PATTERN = /^[a-f0-9]{40}-\d{1,5}x\d{1,5}\.(jpg|jpeg|png|webp|gif)$/;

// An integer query value inside [min, max], or null.
function intInRange(query, name, min, max) {
  const value = Number(query.get(name));
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

// Higher is a better match; 0 means not a match at all.
function searchScore(product, terms) {
  const title = product.title.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (title === term) score += 10;
    else if (title.startsWith(term)) score += 6;
    else if (title.includes(term)) score += 4;

    if (product.tags.some((tag) => tag.toLowerCase().includes(term))) score += 2;
    if (product.productType.toLowerCase().includes(term)) score += 2;
    if (product.description.toLowerCase().includes(term)) score += 1;
  }
  return score;
}

export function registerCatalogRoutes(router, ctx) {
  const { config, catalog, now, fetchImpl } = ctx;

  // Product images for browsers. The image CDN only allows origins on its own
  // list, so a web app on another origin gets 403; the API fetches the image
  // instead. Only allow-listed hosts and well-formed paths are ever fetched.
  const imageCache = new Map(); // key -> { type, body, at }

  async function fetchImage(url) {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502;
      throw new HttpError(status, 'image_unavailable', 'Image unavailable.');
    }

    const type = response.headers.get('content-type') ?? '';
    const body = Buffer.from(await response.arrayBuffer());
    if (!type.startsWith('image/') || body.length > IMAGE_MAX_BYTES) {
      throw new HttpError(502, 'image_unavailable', 'Image unavailable.');
    }
    return { type, body, at: now() };
  }

  router.route('GET', '/v1/products', async ({ query }) => {
    const max = Math.min(Math.max(Number(query.get('limit')) || 40, 1), 200);

    let products = await catalog.products();
    if (query.get('featured') === '1') {
      products = products.filter((p) => p.raw?.featured === true);
    }
    return {
      status: 200,
      body: { data: products.slice(0, max).map((p) => p.raw ?? p) },
    };
  });

  router.route('GET', '/v1/products/:productId', async ({ params }) => {
    const product = await catalog.product(params.productId);
    if (!product) throw new HttpError(404, 'not_found');
    return { status: 200, body: { data: product.raw ?? product } };
  });

  router.route('GET', '/v1/img/:host/:project/:dataset/:file', async ({ req, params, query }) => {
    ctx.limit(`img:${ctx.ipOf(req)}`, 600, 60_000);
    const { host, project, dataset, file } = params;

    const allowed =
      config.imageHosts.includes(host) &&
      PROJECT_PATTERN.test(project) &&
      DATASET_PATTERN.test(dataset) &&
      FILE_PATTERN.test(file);
    if (!allowed) throw new HttpError(404, 'not_found');

    // Only resizing options are passed on, each strictly validated.
    const options = new URLSearchParams();
    const width = intInRange(query, 'w', 16, 2000);
    const quality = intInRange(query, 'q', 20, 100);
    if (width !== null) options.set('w', String(width));
    if (quality !== null) options.set('q', String(quality));
    if (query.get('auto') === 'format') options.set('auto', 'format');

    const key = `${host}/${project}/${dataset}/${file}?${options}`;
    let hit = imageCache.get(key);

    if (!hit || now() - hit.at > IMAGE_CACHE_TTL_MS) {
      hit = await fetchImage(`https://${host}/images/${project}/${dataset}/${file}?${options}`);
      imageCache.set(key, hit);
      if (imageCache.size > IMAGE_CACHE_MAX_ENTRIES) {
        imageCache.delete(imageCache.keys().next().value); // evict the oldest
      }
    }
    return { status: 200, raw: { type: hit.type, body: hit.body } };
  });

  router.route('GET', '/v1/search', async ({ query }) => {
    const text = (query.get('q') ?? '').trim().toLowerCase().slice(0, 100);
    const terms = text.split(/\s+/).filter(Boolean);
    const products = await catalog.products();

    let results = products;
    if (terms.length) {
      results = products
        .map((product) => ({ product, score: searchScore(product, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((match) => match.product);
    }
    if (query.get('inStock') === '1') {
      results = results.filter((p) => p.stock > 0);
    }
    return { status: 200, body: { results: results.slice(0, SEARCH_MAX_RESULTS) } };
  });
}
