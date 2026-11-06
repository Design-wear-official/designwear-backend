import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { registeredRoutes } from '../scripts/openapi.mjs';

// Fails when a route is added or removed without updating openapi.json
// (fix: node scripts/openapi.mjs). The SDK is generated from this file.
it('openapi.json lists exactly the routes the API registers', async () => {
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const have = Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
  const want = (await registeredRoutes())
    .map((r) => `${r.method} ${r.pattern.replace(/:(\w+)/g, '{$1}')}`).sort();
  assert.deepEqual(have, want);
});
