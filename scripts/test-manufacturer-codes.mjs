// Checks imported make-specific DTC data and its offline cache entries.
// Run: node scripts/test-manufacturer-codes.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isDtcCode, isManufacturerCode, manufacturerMakeKey } from '../js/dtc.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(root, 'data/manufacturer');
const makes = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf8'));
assert.ok(Array.isArray(makes) && makes.length > 0);
assert.equal(new Set(makes).size, makes.length);
assert.equal(manufacturerMakeKey('Mercedes-Benz'), 'mercedes-benz');
assert.equal(manufacturerMakeKey('Land Rover'), 'land-rover');
assert.equal(isManufacturerCode('P1302'), true);
assert.equal(isManufacturerCode('P0300'), false);
assert.equal(isManufacturerCode('B1234'), true);

let total = 0;
const codes = new Set();
for (const make of makes) {
  const book = JSON.parse(await readFile(join(dataDir, `${make}.json`), 'utf8'));
  assert.ok(book && typeof book === 'object' && !Array.isArray(book), `${make} is not an object`);
  for (const [code, description] of Object.entries(book)) {
    assert.ok(isDtcCode(code) && isManufacturerCode(code), `${make}: unexpected code ${code}`);
    assert.ok(typeof description === 'string' && description.trim(), `${make}: empty description for ${code}`);
    codes.add(code);
    total++;
  }
}

const license = await readFile(join(dataDir, 'LICENSE'), 'utf8');
assert.ok(license.includes('MIT License'));
const sw = await readFile(join(root, 'sw.js'), 'utf8');
for (const path of ['data/manufacturer/index.json', 'data/manufacturer/LICENSE',
  ...makes.map((make) => `data/manufacturer/${make}.json`)]) {
  assert.ok(sw.includes(`'${path}'`), `service worker does not cache ${path}`);
}
assert.ok(sw.includes("'js/dtc.js'"));

console.log(`${total} manufacturer-specific entries across ${makes.length} makes (${codes.size} distinct code numbers).`);

const { buildCounts } = await import('./build-code-counts.mjs');
const counts = await buildCounts();
assert.deepEqual(JSON.parse(await readFile(join(root, 'data/code-counts.json'), 'utf8')), counts,
  'data/code-counts.json is stale; run node scripts/build-code-counts.mjs');
assert.equal(counts.manufacturer, total);
