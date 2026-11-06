// Builds openapi.json from the routes the API actually registers, keeping any
// summaries and schemas already written by hand in the existing file.
//   node scripts/openapi.mjs          rewrite openapi.json
//   node scripts/openapi.mjs --check  exit 1 if openapi.json is missing a route or lists a removed one
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { AiProvider } from '../src/ai.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const FILE = new URL('../openapi.json', import.meta.url);

export async function registeredRoutes() {
  const config = loadConfig({ DESIGNWEAR_JWT_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://x.test' });
  const app = createApp({
    config,
    store: await new Store(':memory:').load(),
    catalog: { configured: false, products: async () => [], product: async () => null },
    ai: new AiProvider(config),
    mailer: { send: async () => {} },
  });
  return app.routes();
}

const toOpenApiPath = (pattern) => pattern.replace(/:(\w+)/g, '{$1}');

export function buildSpec(routes, previous = {}) {
  const paths = {};
  for (const { method, pattern } of routes) {
    const path = toOpenApiPath(pattern);
    const params = [...pattern.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name, in: 'path', required: true, schema: { type: 'string' },
    }));
    const old = previous.paths?.[path]?.[method.toLowerCase()] ?? {};
    (paths[path] ??= {})[method.toLowerCase()] = {
      tags: [pattern.split('/')[2] ?? 'root'],
      summary: '',
      ...(params.length ? { parameters: params } : {}),
      responses: { 200: { description: 'OK' } },
      ...old,
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'DesignWear API', version: '1.0.0' },
    paths,
  };
}

const sameShape = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const routes = await registeredRoutes();
  const previous = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  const spec = buildSpec(routes, previous);
  if (process.argv.includes('--check')) {
    const want = routes.map((r) => `${r.method} ${toOpenApiPath(r.pattern)}`).sort();
    const have = Object.entries(previous.paths ?? {})
      .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    const missing = want.filter((r) => !have.includes(r));
    const extra = have.filter((r) => !want.includes(r));
    if (missing.length || extra.length) {
      console.error('openapi.json is out of date. Run: node scripts/openapi.mjs');
      missing.forEach((r) => console.error('  missing', r));
      extra.forEach((r) => console.error('  removed', r));
      process.exit(1);
    }
    console.log(`openapi.json covers all ${want.length} routes`);
  } else {
    writeFileSync(FILE, JSON.stringify(spec, null, 2) + '\n');
    console.log(`wrote openapi.json (${routes.length} routes)`);
  }
}
