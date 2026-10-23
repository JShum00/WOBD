// Tests that every export and report page gets its WOBD version from one place.
// Run: node scripts/test-versions.mjs
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersionLine, versionComment, versionLine, wobdVersion } from '../js/version-info.js';
import { versionInfo } from '../js/adapter-data.js';
import { extractVersions } from './update-report-versions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const withVersion = (v, fn) => {
  globalThis.WOBD_VERSION = v;
  try { return fn(); } finally { delete globalThis.WOBD_VERSION; }
};

const cases = [
  ['helpers follow js/version.js through window.WOBD_VERSION', () => {
    assert.equal(wobdVersion(), null);
    assert.equal(versionLine(), 'WOBD');
    assert.equal(versionComment(), null);
    withVersion('1.71', () => {
      assert.equal(versionLine(), 'WOBD v1.71');
      assert.equal(versionComment(), '# WOBD v1.71');
    });
  }],
  ['version lines parse, with or without the # and with extra spaces', () => {
    assert.equal(parseVersionLine('WOBD v1.51'), '1.51');
    assert.equal(parseVersionLine('# WOBD v1.71 '), '1.71');
    assert.equal(parseVersionLine('WOBD v2'), '2');
    assert.equal(parseVersionLine('Browser: Mozilla'), null);
    assert.equal(parseVersionLine('timestamp,elapsed_ms'), null);
    assert.equal(parseVersionLine(undefined), null);
  }],
  ['js/version.js is the only place a WOBD version number is written', async () => {
    const source = await readFile(join(root, 'js/version.js'), 'utf8');
    assert.match(source, /const WOBD_VERSION = '\d+(\.\d+)*';/);
    assert.match(source, /window\.WOBD_VERSION = WOBD_VERSION/);
    for (const file of await readdir(join(root, 'js'))) {
      if (!file.endsWith('.js') || file === 'version.js') continue;
      const text = await readFile(join(root, 'js', file), 'utf8');
      assert.ok(!/WOBD v\d/.test(text.replace(/\/\/.*$/gm, '')), `${file} hard-codes a version`);
      assert.ok(!/site-version/.test(text), `${file} scrapes the footer for the version`);
    }
  }],
  ['a hand-set wobdVersion wins over versions read from the files', () => {
    const base = { reports: { versions: { csv: '1.71', traffic: '1.71' } } };
    assert.deepEqual(versionInfo({ ...base, wobdVersion: '1.0' }), { version: '1.0', manual: true, files: base.reports.versions });
    assert.equal(versionInfo(base).version, '1.71');
    assert.equal(versionInfo(base).manual, false);
    assert.equal(versionInfo({ reports: { versions: { csv: '1.7', traffic: '1.71' } } }).version, '1.7, 1.71');
    assert.equal(versionInfo({ reports: {} }), null);
    assert.equal(versionInfo({ wobdVersion: null }), null);
  }],
  ['the script reads versions from real report files and skips files without one', async () => {
    const versions = await extractVersions({
      csv: 'reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv',
      traffic: 'reports/vlinker-fs-usb/toyota/2010/highlander/wobd-2010-toyota-highlander-traffic-2026-10-22.txt',
    });
    assert.deepEqual(versions, { traffic: '1.51' });
    assert.deepEqual(await extractVersions({ csv: 'reports/missing.csv', traffic: null }), {});
  }],
  ['tested-adapters.json is consistent with the files and has overrides for old entries', async () => {
    const results = JSON.parse(await readFile(join(root, 'data/tested-adapters.json'), 'utf8'));
    for (const result of results) {
      const found = await extractVersions(result.reports ?? {});
      assert.deepEqual(result.reports?.versions ?? {}, found, `${result.id}: run node scripts/update-report-versions.mjs`);
      assert.ok(versionInfo(result), `${result.id} has no version`);
    }
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId['vlinker-fs-usb-pt-cruiser-2026-10-02'].wobdVersion, '1.0');
    assert.equal(byId['vlinker-fs-usb-toyota-highlander-2026-10-22'].wobdVersion, '1.51');
  }],
];

let failed = 0;
const rows = [];
for (const [name, test] of cases) {
  try {
    await test();
    rows.push({ case: name, result: 'pass' });
  } catch (err) {
    failed++;
    rows.push({ case: name, result: `FAIL: ${err.message}` });
  }
}
console.table(rows);
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
