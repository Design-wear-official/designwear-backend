// The API's front door: GET / answers a browser with a page of links to every part of DesignWear,
// and anything else (curl, a program) with the same links as JSON.
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function homeLinks(config) {
  const { links } = config;
  return [
    { key: 'shop', title: 'Shop and Design Studio', text: 'For customers: browse, design, order, return.', url: links.shop },
    { key: 'staff', title: 'Staff app', text: 'Vendors, order desk, delivery partners and the owner.', url: links.staff },
    { key: 'cmsAdmin', title: 'SethuCMS admin', text: 'Products, teams, stock and orders.', url: links.cmsAdmin },
    { key: 'hub', title: 'Platform hub', text: 'Live status of every part.', url: links.hub },
    { key: 'sdk', title: 'SDK reference', text: 'Every route as a typed TypeScript call.', url: links.sdk },
    { key: 'rules', title: 'Order rules', text: 'The order lifecycle and who may move an order.', url: links.rules },
    { key: 'data', title: 'Data', text: 'SethuCMS collections and tokens.', url: links.data },
  ];
}

function page(items) {
  const cards = items
    .map((i) => `<a class="card" href="${esc(i.url)}" rel="noopener"><b>${esc(i.title)}</b><span>${esc(i.text)}</span><i>${esc(i.url.replace(/^https:\/\//, ''))}</i></a>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DesignWear API</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark light;--bg:#0b0d12;--card:#141821;--line:#232a38;--ink:#eef1f7;--soft:#9aa4b8;--accent:#ff6b3d}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fa;--card:#fff;--line:#e1e5ee;--ink:#14171f;--soft:#5b6475;--accent:#d9481a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:900px;margin:0 auto;padding:48px 16px}h1{margin:0 0 4px;font-size:clamp(1.8rem,5vw,2.6rem);letter-spacing:-.02em}
p{color:var(--soft);margin:4px 0 24px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{display:flex;flex-direction:column;gap:4px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:inherit;text-decoration:none}
.card:hover,.card:focus-visible{border-color:var(--accent)}.card b{color:var(--accent)}.card span{color:var(--soft);font-size:.92rem}.card i{margin-top:auto;padding-top:8px;font-style:normal;font-size:.8rem;color:var(--soft)}
h2{margin:32px 0 8px;font-size:1.05rem}code{font-family:ui-monospace,Menlo,monospace}a{color:var(--accent)}
</style></head><body><main>
<h1>DesignWear API</h1><p>One API behind the shop, the Staff app and the SDK. This is the server; the places people use are below.</p>
<div class="grid">${cards}</div>
<h2>For programs</h2>
<p><a href="/v1/health"><code>/v1/health</code></a> (add <code>?deep=1</code> for the database and catalog) &middot; <a href="/v1/config"><code>/v1/config</code></a> &middot; <a href="/v1/products?limit=3"><code>/v1/products</code></a>. Everything is under <code>/v1</code>.</p>
</main></body></html>`;
}

export function registerHomeRoutes(router, ctx) {
  router.route('GET', '/', async ({ req }) => {
    const items = homeLinks(ctx.config);
    if (String(req.headers.accept ?? '').includes('text/html')) {
      return {
        status: 200,
        raw: {
          type: 'text/html; charset=utf-8',
          body: page(items),
          headers: { 'content-security-policy': PAGE_CSP, 'cache-control': 'public, max-age=300' },
        },
      };
    }
    return {
      status: 200,
      body: {
        name: 'DesignWear API',
        health: '/v1/health',
        links: Object.fromEntries(items.map((i) => [i.key, i.url])),
      },
    };
  });
}
