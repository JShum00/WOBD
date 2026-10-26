// Tests Bob's code lookup for manufacturer-specific codes and the simulator's custom code list.
// Run: node scripts/test-bob-lookup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setBundles } from '../js/i18n.js';
import { cleanManufacturerDescription } from '../js/dtc.js';
import { lookup, loadCodeBook, loadGenericCodes, loadManufacturerCodes } from '../js/bob.js';
import { MAX_CUSTOM_CODES, parseCodeList, vehicleProfile } from '../js/vehicles.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const english = JSON.parse(read('data/i18n/en.json'));
setBundles({ code: 'en', main: english, base: english });

globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('..')) return { ok: false, status: 400 };
  try {
    const body = read(path);
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404 };
  }
};

await loadCodeBook();

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('a curated code keeps its own notes even when a make is given', async () => {
  await loadManufacturerCodes('Ford');
  const entry = lookup('P0420', 'Ford');
  assert.equal(entry.known, true);
  assert.notEqual(entry.brandSpecific, true);
});

test('a manufacturer code without a make falls back to the generic message', async () => {
  const entry = lookup('P1300', '');
  assert.equal(entry.brandSpecific, undefined);
  assert.equal(entry.manufacturer, true);
});

test('a manufacturer code with a make shows its title with unknown urgency, difficulty, and one cause', async () => {
  await loadManufacturerCodes('Jeep');
  const entry = lookup('P1300', 'Jeep');
  assert.equal(entry.brandSpecific, true);
  assert.equal(entry.urgency, 'unknown');
  assert.equal(entry.difficulty, 'unknown');
  assert.equal(entry.plain, 'Ignition timing adjustment circuit failure');
  assert.deepEqual(entry.causes, [english['bob.lookup.limitedInfo']]);
  assert.match(entry.tellMechanic, /^P1300 is listed for Jeep: Ignition timing adjustment circuit failure\./);
});

test('manufacturer data for one make is not used for another', async () => {
  await loadManufacturerCodes('Ford');
  assert.equal(lookup('B108E', 'Jeep').brandSpecific, undefined);
  assert.equal(lookup('B108E', 'Ford').brandSpecific, true);
});

test('Ford descriptions loaded by Bob have no leftover markers or non-breaking spaces', async () => {
  await loadManufacturerCodes('Ford');
  for (const code of ['B108A', 'B108E', 'B1087', 'B10D9', 'C1034', 'U2013']) {
    const { plain } = lookup(code, 'Ford');
    assert.doesNotMatch(plain, /\u00a0/, code);
    assert.doesNotMatch(plain, /^[0-9A-F]{2}: /, code);
    assert.doesNotMatch(plain, /\b[A-Z]{1,2}: (?!$)/, code);
  }
  assert.equal(lookup('B10D9', 'Ford').plain, 'PATS Transponder: Missing Message (Passive Anti-Theft System (PATS))');
});

test('an unlisted make or an unsafe make name loads nothing and never throws', async () => {
  assert.deepEqual(await loadManufacturerCodes('Nonexistent Make'), {});
  assert.deepEqual(await loadManufacturerCodes('../../etc/passwd'), {});
  assert.deepEqual(await loadManufacturerCodes(''), {});
});

test('generic OBDex codes load for generic families only', async () => {
  await loadGenericCodes(['P0100', 'P1300', 'ZZ999']);
  const entry = lookup('P0100', '');
  assert.equal(entry.generic, true);
});

test('code book loading keeps prototype keys out of lookups', async () => {
  for (const code of ['__proto__', 'constructor', 'toString']) {
    const entry = lookup(code, 'Ford');
    assert.notEqual(entry.known, true, code);
  }
});

test('cleanManufacturerDescription leaves plain and empty descriptions alone', () => {
  assert.equal(cleanManufacturerDescription('Shift Solenoid B Performance'), 'Shift Solenoid B Performance');
  assert.equal(cleanManufacturerDescription(''), '');
  assert.equal(cleanManufacturerDescription('12: Door Lock: Circuit Open'), 'Door Lock: Circuit Open');
});

test('parseCodeList accepts mixed separators, uppercases, and removes repeats', () => {
  assert.deepEqual(parseCodeList('p1300, P0420;u0100\nB1234  p1300').codes, ['P1300', 'P0420', 'U0100', 'B1234']);
});

test('parseCodeList reports invalid codes instead of sending them', () => {
  const result = parseCodeList('P1300 <script> P4000 XYZ P03001 P0G00');
  assert.deepEqual(result.codes, ['P1300']);
  assert.deepEqual(result.invalid, ['<SCRIPT>', 'P4000', 'XYZ', 'P03001', 'P0G00']);
});

test('parseCodeList caps the list and flags it', () => {
  const many = Array.from({ length: MAX_CUSTOM_CODES + 4 }, (_, i) => `P01${i.toString(16).toUpperCase().padStart(2, '0')}`).join(' ');
  const result = parseCodeList(many);
  assert.equal(result.codes.length, MAX_CUSTOM_CODES);
  assert.equal(result.truncated, true);
  assert.deepEqual(parseCodeList(null).codes, []);
});

test('vehicleProfile uses the custom list only for the custom code set', () => {
  assert.deepEqual(vehicleProfile({ year: '2019', make: 'Ford', codeSet: 'custom', customCodes: 'B108E, nope' }).codes, ['B108E']);
  assert.deepEqual(vehicleProfile({ year: '2019', make: 'Ford', codeSet: 'none', customCodes: 'B108E' }).codes, []);
  assert.deepEqual(vehicleProfile({ year: '2019', make: 'Ford', codeSet: 'custom' }).codes, []);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}\n${err.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
