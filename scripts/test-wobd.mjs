// Tests for the .wobd archive, its ZIP layer, and lossless CSV migration.
// Run: node scripts/test-wobd.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, ZipError, canDeflate, crc32, readZip, writeZip } from '../js/zip.js';
import { analyzeCsv, nativeModel, rebuildCsv, splitRecords } from '../js/csv-lossless.js';
import { WobdError, deriveEvents, readWobd, wobdToCsvBytes, writeWobd } from '../js/wobd.js';
import { Recording } from '../js/recorder.js';
import { LIVE_PIDS } from '../js/obd.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { ignoreBOM: true });
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const REAL = [
  'reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv',
  'reports/vlinker-fs-usb/toyota/2010/highlander/wobd-2010-toyota-highlander-recording-2026-10-22-091314.csv',
];
const bytesOf = (path) => new Uint8Array(readFileSync(new URL(`../${path}`, import.meta.url)));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const HEAD = 'timestamp,elapsed_ms,pid,name,value,unit,protocol,baud,raw,mode,ecu';
const line = (dt, pid, name, value, unit = '', extra = '') => `${new Date(T0 + dt).toISOString()},${dt},${pid},${name},${value},${unit},CAN,500000,${extra},01,7E8`;

function nativeSample(n = 30) {
  const def = LIVE_PIDS.find((d) => d.key === 'rpm');
  const rec = new Recording(T0, { protocol: 'CAN', baudRate: 500000 });
  for (let i = 0; i < n; i++) rec.add(def, 800 + i, T0 + i * 100, null, '7E8');
  return rec;
}
const storedRows = (rec) => rec.rows.map(Recording.store);
const nativeInfo = { startedAt: T0, protocol: 'CAN', baud: 500000, version: null };

// A hand-built ZIP so hostile files can be shaped exactly.
function rawZip(files, tweak = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data ?? new Uint8Array(0);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, f.flags ?? 0, true);
    head.setUint16(8, f.method ?? 0, true);
    head.setUint32(14, f.crc ?? crc32(data), true);
    head.setUint32(18, f.size ?? data.length, true);
    head.setUint32(22, f.rawSize ?? data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, data);
    central.push({ f, name, data, offset });
    offset += 30 + name.length + data.length;
  }
  const start = offset;
  for (const { f, name, data, offset: at } of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(8, f.flags ?? 0, true);
    h.setUint16(10, f.method ?? 0, true);
    h.setUint32(16, f.crc ?? crc32(data), true);
    h.setUint32(20, f.size ?? data.length, true);
    h.setUint32(24, f.rawSize ?? data.length, true);
    h.setUint16(28, name.length, true);
    h.setUint32(42, tweak.localAt?.(at) ?? at, true);
    parts.push(new Uint8Array(h.buffer), name);
    offset += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, offset - start, true);
  end.setUint32(16, start, true);
  parts.push(new Uint8Array(end.buffer));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const rejects = async (promise, re) => {
  await assert.rejects(promise, (err) => { assert.ok(err instanceof ZipError || err instanceof WobdError, String(err)); if (re) assert.match(err.message, re); return true; });
};

const cases = [
  // ---- ZIP ----
  ['CRC-32 matches the standard check value', () => assert.equal(crc32(enc.encode('123456789')), 0xcbf43926)],
  ['a written archive reads back, stored and deflated', async () => {
    const big = enc.encode('abc'.repeat(5000));
    for (const compress of [true, false]) {
      const zip = await writeZip([{ name: 'a.txt', data: big }, { name: 'b.txt', data: enc.encode('hi') }], { compress });
      const { entries } = await readZip(zip);
      assert.ok(sameBytes(entries.get('a.txt'), big));
      assert.equal(dec.decode(entries.get('b.txt')), 'hi');
      if (compress && canDeflate()) assert.ok(zip.length < big.length);
    }
  }],
  ['archives are byte-for-byte reproducible', async () => {
    const files = [{ name: 'a', data: enc.encode('x'.repeat(500)) }];
    assert.ok(sameBytes(await writeZip(files), await writeZip(files)));
  }],
  ['unzip and Python zipfile accept what we write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wobd-'));
    try {
      const zip = await writeZip([{ name: 'mimetype', data: enc.encode('x'), store: true }, { name: 'd/e.txt', data: enc.encode('hello '.repeat(200)) }]);
      writeFileSync(join(dir, 'a.zip'), zip);
      const py = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.namelist())==2', join(dir, 'a.zip')]);
      assert.equal(py.status, 0, String(py.stderr));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }],
  ['a flipped byte is caught by the checksum', async () => {
    const zip = await writeZip([{ name: 'a', data: enc.encode('hello world') }], { compress: false });
    zip[30 + 1 + 3] ^= 1;
    await rejects(readZip(zip), /checksum/);
  }],
  ['a truncated or garbage file is refused', async () => {
    const zip = await writeZip([{ name: 'a', data: enc.encode('hello world') }]);
    await rejects(readZip(zip.subarray(0, zip.length - 10)));
    await rejects(readZip(enc.encode('this is not a zip file at all, not even close')));
  }],
  ['path tricks and unknown names are refused', async () => {
    for (const name of ['../x', '/abs', 'a\\b', 'other.txt']) {
      const zip = rawZip([{ name, data: enc.encode('x') }]);
      await rejects(readZip(zip, { allowed: (n) => /^[a-z]\.txt$/.test(n) }));
    }
  }],
  ['duplicate names are refused', async () => {
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1') }, { name: 'a', data: enc.encode('2') }])), /twice/);
  }],
  ['encrypted, data-descriptor, and odd-method entries are refused', async () => {
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1'), flags: 1 }])), /Encrypted/);
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1'), flags: 8 }])), /Encrypted|streamed/);
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1'), method: 12 }])), /method/);
  }],
  ['a local header that disagrees with the directory is refused', async () => {
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1') }], { localAt: () => 5 })), /header/);
  }],
  ['declared sizes over the limits are refused without unpacking', async () => {
    await rejects(readZip(rawZip([{ name: 'a', data: enc.encode('1'), rawSize: LIMITS.maxEntryBytes + 1 }])), /larger/);
    const tiny = { ...LIMITS, maxEntries: 2 };
    await rejects(readZip(rawZip(['a', 'b', 'c'].map((name) => ({ name, data: enc.encode('1') }))), { limits: tiny }), /too many/);
  }],
  ['a zip bomb that lies about its size is stopped', async (t) => {
    if (!canDeflate()) return;
    const bomb = await writeZip([{ name: 'a', data: new Uint8Array(2 * 1024 * 1024) }]);
    const view = new DataView(bomb.buffer);
    view.setUint32(22, 1000, true);
    const dirAt = bomb.length - 22 - 46 - 1;
    view.setUint32(dirAt + 24, 1000, true);
    await rejects(readZip(bomb), /larger|damaged|checksum/);
  }],
  ['a highly repetitive but honest archive only warns', async () => {
    if (!canDeflate()) return;
    const zip = await writeZip([{ name: 'a', data: new Uint8Array(3 * 1024 * 1024) }]);
    const { warnings } = await readZip(zip);
    assert.equal(warnings.length, 1);
  }],

  // ---- lossless CSV ----
  ['both real recordings rebuild to identical bytes', () => {
    for (const path of REAL) {
      const bytes = bytesOf(path);
      const { exact, report } = analyzeCsv(bytes);
      assert.ok(exact, path);
      assert.equal(report.telemetry, report.records);
      assert.equal(report.kept, 0);
    }
  }],
  ['quoted fields, CRLF inside quotes, and escaped quotes survive', () => {
    const { records } = splitRecords('a,"b,c","d ""q""\r\nx"\r\n');
    assert.deepEqual(records, [['a', 'b,c', 'd "q"\r\nx']]);
  }],
  ['odd files are kept exactly: unknown PIDs, extra columns, bad values, 0.50, 1e3, BOM, LF, no final newline', () => {
    const csv = [
      '\ufeff# WOBD v1.6', `${HEAD},note`,
      `${line(0, '0x0C', 'Engine RPM', '800.50', 'rpm')},`,
      `${line(100, '0xFF', 'Mystery', '7', '')},keep me`,
      `${line(200, '0x0D', 'Speed', '', 'mph')},`,
      `${line(300, '0x0D', 'Speed', 'n/a', 'mph')},`,
      `${line(400, '0x0C', 'Engine RPM', '1e3', 'rpm')},`,
      'garbage row', '',
      `${new Date(T0 + 500).toISOString()},0500,0x0C,Engine RPM,900,rpm,CAN,500000,,01,7E8,`,
      `${line(100, '0x0C', 'Engine RPM', '801', 'rpm')},`,
    ].join('\n');
    const bytes = enc.encode(csv);
    const { model, report, exact } = analyzeCsv(bytes);
    assert.ok(exact);
    assert.equal(dec.decode(enc.encode(rebuildCsv(model))), csv);
    assert.ok(report.malformed >= 2);
    assert.ok(report.normalized >= 1);
    assert.equal(report.outOfOrder, 1);
    assert.deepEqual(report.unknownPids, ['0xFF Mystery']);
    assert.ok(model.rows.some((r) => r[2] === '800.50'));
  }],
  ['a file that cannot be rebuilt exactly is detected, so the original must be kept', () => {
    const csv = `${HEAD}\r\n${line(0, '0x0C', 'Engine RPM', '800', 'rpm')}\n${line(100, '0x0C', 'Engine RPM', '801', 'rpm')}\r\n`;
    assert.equal(analyzeCsv(enc.encode(csv)).exact, false);
    const invalid = new Uint8Array([...enc.encode(`${HEAD}\r\n`), 0xff, 0xfe, 0x0d, 0x0a]);
    assert.equal(analyzeCsv(invalid).exact, false);
  }],
  ['a file with no recording columns is refused', () => {
    assert.throws(() => analyzeCsv(enc.encode('a,b,c\r\n1,2,3\r\n')), /doesn't look like/);
    assert.throws(() => analyzeCsv(new Uint8Array(0)), /empty/);
  }],

  // ---- archive ----
  ['converting with the original embedded gives back byte-identical CSV', async () => {
    for (const path of REAL) {
      const bytes = bytesOf(path);
      const { model } = analyzeCsv(bytes);
      const out = await readWobd(await writeWobd(model, { source: bytes }));
      assert.ok(sameBytes(wobdToCsvBytes(out), bytes));
    }
  }],
  ['converting without the original gives back the same bytes when the file is exact', async () => {
    for (const path of REAL) {
      const bytes = bytesOf(path);
      const { model } = analyzeCsv(bytes);
      const out = await readWobd(await writeWobd(model, {}));
      assert.equal(out.source, null);
      assert.ok(sameBytes(wobdToCsvBytes(out), bytes));
    }
  }],
  ['odd files round-trip through an archive without the original', async () => {
    const csv = `${HEAD},note\r\n${line(0, '0xFF', 'Mystery', '7.0')},extra\r\nbad row\r\n${line(50, '0x0C', 'Engine RPM', '1e3', 'rpm')},\r\n`;
    const bytes = enc.encode(csv);
    const { model, exact } = analyzeCsv(bytes);
    assert.ok(exact);
    const out = await readWobd(await writeWobd(model, {}));
    assert.equal(dec.decode(wobdToCsvBytes(out)), csv);
  }],
  ['a live recording archives and rebuilds the same CSV the recorder writes', async () => {
    const rec = nativeSample();
    const model = nativeModel(nativeInfo, storedRows(rec));
    const out = await readWobd(await writeWobd(model, { version: '1.8', status: 'complete' }));
    assert.equal(dec.decode(wobdToCsvBytes(out)), rec.toCsv());
    assert.equal(out.session.rows, 30);
    assert.equal(out.session.source, 'live-recording');
  }],
  ['long recordings split into bounded chunks with contiguous sequence numbers', async () => {
    const def = LIVE_PIDS.find((d) => d.key === 'rpm');
    const rec = new Recording(T0, { protocol: 'CAN', baudRate: 500000 });
    for (let i = 0; i < 4500; i++) rec.add(def, 800 + (i % 50), T0 + i * 100, null, '7E8');
    const out = await readWobd(await writeWobd(nativeModel(nativeInfo, storedRows(rec)), {}));
    assert.equal(out.model.rows.length, 4500);
    assert.deepEqual(out.problems, []);
    assert.equal(out.manifest.entries.filter((e) => e.name.startsWith('telemetry/')).length, 3);
    assert.ok(out.manifest.entries.every((e) => e.size <= LIMITS.maxEntryBytes));
  }],
  ['gaps and clock regressions become events, never readings, and rows are not reordered', async () => {
    const def = LIVE_PIDS.find((d) => d.key === 'rpm');
    const rec = new Recording(T0, { protocol: 'CAN', baudRate: 500000 });
    for (const t of [0, 100, 30000, 29000]) rec.add(def, 800, T0 + t, null, null);
    const model = nativeModel(nativeInfo, storedRows(rec));
    const types = deriveEvents(model, 'complete').map((e) => e.type);
    assert.deepEqual(types, ['unknown_gap', 'clock_regression']);
    const out = await readWobd(await writeWobd(model, {}));
    assert.deepEqual(out.model.rows.map((r) => r[0]), [0, 100, 30000, 29000]);
    assert.ok(!types.includes('suspected_stall'));
  }],
  ['an interrupted session is marked partial with an inferred crash', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(5)));
    const out = await readWobd(await writeWobd(model, { status: 'partial' }));
    assert.ok(out.partial);
    assert.ok(out.events.some((e) => e.type === 'crash_inferred' && e.class === 'inferred'));
  }],
  ['notes travel inside the archive', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    const out = await readWobd(await writeWobd(model, { annotations: '{"format":"wobd-annotations"}' }));
    assert.equal(out.annotations, '{"format":"wobd-annotations"}');
  }],
  ['the archive holds only the stated files and no personal fields', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    const zip = await writeWobd(model, {});
    const { entries } = await readZip(zip);
    assert.deepEqual([...entries.keys()].map((n) => n.replace(/\d{4,6}/g, 'N')).sort(), [
      'dictionary.json', 'manifest.json', 'mimetype', 'segments.json', 'session.json', 'telemetry/seg-N/chunk-N.jsonl',
    ]);
    const all = dec.decode(entries.get('session.json')) + dec.decode(entries.get('manifest.json'));
    assert.ok(!/vin|latitude|longitude/i.test(all));
  }],
  ['a tampered entry, a missing manifest, and an unlisted entry are refused', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    const good = await writeWobd(model, { compress: false });
    const { entries } = await readZip(good);
    const files = (mutate) => [...entries].map(([name, data]) => ({ name, data: mutate(name, data) }));
    await rejects(readWobd(rawZip(files((n, d) => (n === 'session.json' ? enc.encode(dec.decode(d).replace('"complete"', '"partial"')) : d)))), /checksum|damaged/);
    await rejects(readWobd(rawZip(files((n, d) => d).filter((f) => f.name !== 'manifest.json'))), /manifest/);
    await rejects(readWobd(rawZip([...files((n, d) => d), { name: 'events/events-000009.jsonl', data: enc.encode('{}\n') }])), /does not list/);
    await rejects(readWobd(enc.encode('not a wobd file, just text, long enough to pass the size check')));
  }],
  ['a newer major version is refused with a clear message', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    const { entries } = await readZip(await writeWobd(model, { compress: false }));
    const manifest = JSON.parse(dec.decode(entries.get('manifest.json')));
    manifest.format.major = 2;
    const files = [...entries].map(([name, data]) => ({ name, data: name === 'manifest.json' ? enc.encode(JSON.stringify(manifest)) : data }));
    await rejects(readWobd(rawZip(files)), /newer WOBD/);
  }],
  ['unknown minor-version fields are ignored', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    const { entries } = await readZip(await writeWobd(model, { compress: false }));
    const manifest = JSON.parse(dec.decode(entries.get('manifest.json')));
    manifest.format.minor = 7;
    manifest.future = { anything: true, __proto__: { x: 1 } };
    const files = [...entries].map(([name, data]) => ({ name, data: name === 'manifest.json' ? enc.encode(JSON.stringify(manifest)) : data }));
    assert.equal((await readWobd(rawZip(files))).model.rows.length, 3);
  }],
  ['malformed readings inside a valid archive are refused', async () => {
    const model = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    model.rows[1] = [Infinity, 0, 'x', '', ''];
    await rejects(readWobd(await writeWobd(model, {})), /not valid|damaged/);
    const bad = nativeModel(nativeInfo, storedRows(nativeSample(3)));
    bad.rows[0][1] = 99;
    await rejects(readWobd(await writeWobd(bad, {})), /not valid/);
  }],
  ['a missing block of readings is reported, not hidden', async () => {
    const def = LIVE_PIDS.find((d) => d.key === 'rpm');
    const rec = new Recording(T0, { protocol: 'CAN', baudRate: 500000 });
    for (let i = 0; i < 4100; i++) rec.add(def, 800, T0 + i * 100, null, null);
    const { entries } = await readZip(await writeWobd(nativeModel(nativeInfo, storedRows(rec)), { compress: false }));
    const manifest = JSON.parse(dec.decode(entries.get('manifest.json')));
    manifest.entries = manifest.entries.filter((e) => !e.name.endsWith('chunk-000002.jsonl'));
    const files = [...entries].filter(([n]) => !n.endsWith('chunk-000002.jsonl')).map(([name, data]) => ({ name, data: name === 'manifest.json' ? enc.encode(JSON.stringify(manifest)) : data }));
    const out = await readWobd(rawZip(files));
    assert.ok(out.problems.length);
  }],
  ['a stored-only archive (older browsers) reads back identically', async () => {
    const bytes = bytesOf(REAL[1]);
    const { model } = analyzeCsv(bytes);
    const out = await readWobd(await writeWobd(model, { compress: false }));
    assert.ok(sameBytes(wobdToCsvBytes(out), bytes));
  }],
  ['archives are smaller than the CSV they came from', async () => {
    if (!canDeflate()) return;
    const bytes = bytesOf(REAL[1]);
    const zip = await writeWobd(analyzeCsv(bytes).model, {});
    assert.ok(zip.length < bytes.length / 3, `${zip.length} vs ${bytes.length}`);
  }],
];

let failed = 0;
const results = [];
for (const [name, test] of cases) {
  try { await test(); results.push({ case: name, result: 'pass' }); } catch (err) { failed++; results.push({ case: name, result: `FAIL: ${err.message}`.slice(0, 160) }); }
}
console.table(results);
if (failed) { console.error(`${failed} of ${cases.length} failed.`); process.exit(1); }
console.log(`All ${cases.length} passed`);
