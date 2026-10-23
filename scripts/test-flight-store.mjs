// Tests for the browser backup of a recording. Run: node scripts/test-flight-store.mjs
// Uses an in-memory backend with failure injection; no browser needed.
import assert from 'node:assert/strict';
import {
  BackupWriter, BATCH_ROWS, MAX_WAITING_ROWS, RETENTION_DAYS, checksum, listSessions, loadSession, makeChunk,
  memoryBackend, projectedHours, purgeExpired, quotaLevel, readChunk, storageStatus, validateSession,
} from '../js/flight-store.js';
import { Recording } from '../js/recorder.js';
import { LIVE_PIDS } from '../js/obd.js';

const T0 = 1_700_000_000_000;
const DAY = 86400000;
const row = (i) => [T0 + i * 100, '0x0C', 'Engine RPM', String(800 + i), 'rpm', '', '01', '7E8'];
const writer = (be, over = {}) => new BackupWriter(be, { startedAt: T0, protocol: 'ISO 15765-4 (CAN)', baud: 500000, version: '1.8', ...over });
const rowsOf = (n, from = 0) => Array.from({ length: n }, (_, i) => row(from + i));

const cases = [
  ['a chunk reads back the same rows, and a changed byte is caught', () => {
    const chunk = makeChunk('s', 0, rowsOf(3));
    assert.deepEqual(readChunk(chunk), rowsOf(3));
    assert.equal(readChunk({ ...chunk, body: chunk.body.replace('800', '801') }), null);
    assert.equal(readChunk({ ...chunk, count: 4 }), null);
    assert.equal(readChunk({ ...chunk, body: chunk.body.slice(0, -5) }), null);
  }],
  ['malformed rows are rejected even with a matching checksum', () => {
    const body = JSON.stringify([[1, 2]]);
    assert.equal(readChunk({ body, sum: checksum(body), count: 1 }), null);
  }],
  ['rows are flushed in batches and stored with the session record', async () => {
    const be = memoryBackend();
    const w = writer(be);
    for (let i = 0; i < BATCH_ROWS + 10; i++) w.add(row(i), T0 + i);
    await w.flush(T0 + 1000);
    const s = await loadSession(be, w.meta.id);
    assert.equal(s.rows.length, BATCH_ROWS + 10);
    assert.equal(s.meta.status, 'open');
    assert.ok(s.complete);
  }],
  ['a time-based flush writes a small batch', async () => {
    const be = memoryBackend();
    const w = writer(be);
    w.add(row(0), T0 + 100);
    assert.equal(be.store.size, 0);
    w.add(row(1), T0 + 6000);
    await w.inFlight;
    assert.equal(be.store.size, 1);
  }],
  ['recovered rows rebuild exactly the CSV the live recording would have produced', async () => {
    const def = LIVE_PIDS.find((d) => d.key === 'rpm');
    const rec = new Recording(T0, { protocol: 'ISO 15765-4 (CAN)', baudRate: 500000 });
    const be = memoryBackend();
    const w = writer(be);
    for (let i = 0; i < 40; i++) {
      rec.add(def, 800 + i, T0 + i * 100, null, '7E8');
      w.add(Recording.store(rec.rows.at(-1)), T0 + i * 100);
    }
    await w.finish(T0 + 5000);
    const s = await loadSession(be, w.meta.id);
    const stored = Recording.csvFromStored({ ...s.meta, version: null }, s.rows);
    assert.equal(stored, rec.toCsv());
  }],
  ['finishing marks the session saved and keeps all rows', async () => {
    const be = memoryBackend();
    const w = writer(be);
    w.add(row(0), T0);
    await w.finish(T0 + 10);
    const [meta] = await listSessions(be);
    assert.equal(meta.status, 'saved');
    assert.equal(meta.rows, 1);
  }],
  ['a torn tail (missing, corrupt, or out-of-order chunk) keeps only the good start', () => {
    const meta = { chunks: 4 };
    const c = (seq) => makeChunk('s', seq, rowsOf(2, seq * 2));
    const bad = { ...c(2), body: '[[1' };
    const a = validateSession(meta, [c(0), c(1), bad, c(3)]);
    assert.equal(a.rows.length, 4);
    assert.equal(a.droppedChunks, 2);
    assert.ok(!a.complete);
    const gap = validateSession(meta, [c(0), c(2), c(3)]);
    assert.equal(gap.goodChunks, 1);
    assert.ok(gap.problems.length);
  }],
  ['a missing final chunk is reported even when nothing is corrupt', () => {
    const r = validateSession({ chunks: 3 }, [makeChunk('s', 0, rowsOf(1)), makeChunk('s', 1, rowsOf(1))]);
    assert.equal(r.rows.length, 2);
    assert.match(r.problems[0], /missing/);
  }],
  ['a crash before the commit leaves only complete earlier chunks', async () => {
    const be = memoryBackend();
    const w = writer(be);
    for (let i = 0; i < BATCH_ROWS; i++) w.add(row(i), T0);
    await w.inFlight;
    be.failNext = new Error('crash');
    for (let i = 0; i < BATCH_ROWS; i++) w.add(row(1000 + i), T0);
    await w.inFlight;
    const s = await loadSession(be, w.meta.id);
    assert.equal(s.rows.length, BATCH_ROWS);
    assert.ok(s.complete);
    assert.ok(w.failure);
  }],
  ['a write failure stops the backup, keeps stored data, and never throws', async () => {
    const be = memoryBackend();
    const w = writer(be);
    for (let i = 0; i < BATCH_ROWS; i++) w.add(row(i), T0);
    await w.inFlight;
    const err = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    be.failNext = err;
    for (let i = 0; i < BATCH_ROWS; i++) w.add(row(i), T0);
    await w.inFlight;
    assert.equal(w.failure.name, 'QuotaExceededError');
    w.add(row(1), T0);
    assert.equal(w.waiting.length, 0);
    await w.finish(T0 + 1);
    assert.equal((await loadSession(be, w.meta.id)).rows.length, BATCH_ROWS);
  }],
  ['the waiting buffer is bounded when writes stall', () => {
    const w = writer(memoryBackend());
    w.flush = () => {};
    for (let i = 0; i < MAX_WAITING_ROWS + 5; i++) w.add(row(i), T0);
    assert.ok(w.stopped);
    assert.equal(w.waiting.length, 0);
  }],
  ['expired saved sessions are purged, but interrupted ones never are', async () => {
    const be = memoryBackend();
    const old = T0 - (RETENTION_DAYS + 1) * DAY;
    be.sessions.set('a', { id: 'a', status: 'saved', updatedAt: old, startedAt: old });
    be.sessions.set('b', { id: 'b', status: 'open', updatedAt: old, startedAt: old });
    be.sessions.set('c', { id: 'c', status: 'saved', updatedAt: T0 - DAY, startedAt: T0 - DAY });
    assert.deepEqual(await purgeExpired(be, T0), ['a']);
    assert.deepEqual((await listSessions(be)).map((m) => m.id).sort(), ['b', 'c']);
  }],
  ['deleting a session removes its chunks too', async () => {
    const be = memoryBackend();
    const w = writer(be);
    for (let i = 0; i < BATCH_ROWS; i++) w.add(row(i), T0);
    await w.inFlight;
    await be.remove(w.meta.id);
    assert.equal(be.store.size, 0);
    assert.equal(await loadSession(be, w.meta.id), null);
  }],
  ['quota levels warn at 70% and go critical at 90%, and low free space counts too', () => {
    const GB = 1e9;
    assert.equal(quotaLevel(0.5 * GB, 10 * GB), 'ok');
    assert.equal(quotaLevel(7.5 * GB, 10 * GB), 'warn');
    assert.equal(quotaLevel(9.5 * GB, 10 * GB), 'critical');
    assert.equal(quotaLevel(20e6, 60e6), 'warn');
    assert.equal(quotaLevel(undefined, 10 * GB), 'unknown');
  }],
  ['a misleading estimate (zero or missing quota) is "unknown", never "ok"', () => {
    assert.equal(quotaLevel(0, 0), 'unknown');
    assert.equal(quotaLevel(5, NaN), 'unknown');
  }],
  ['storageStatus reports unavailable APIs and failing estimates without throwing', async () => {
    assert.equal((await storageStatus({})).level, 'unknown');
    const bad = { storage: { estimate: async () => { throw new Error('no'); } } };
    assert.equal((await storageStatus(bad)).level, 'unknown');
    const ok = { storage: { estimate: async () => ({ usage: 1e9, quota: 1e9 }), persisted: async () => false } };
    const s = await storageStatus(ok);
    assert.equal(s.level, 'critical');
    assert.equal(s.persisted, false);
  }],
  ['projected hours come from the stored rate, and are withheld when it is too early to tell', () => {
    assert.equal(projectedHours(1e9, { startedAt: 0, updatedAt: 10000, bytes: 1000 }), null);
    const h = projectedHours(3600 * 100 * 2, { startedAt: 0, updatedAt: 60000, bytes: 6000 });
    assert.equal(h, 2);
  }],
];

let failed = 0;
const results = [];
for (const [name, test] of cases) {
  try { await test(); results.push({ case: name, result: 'pass' }); } catch (err) { failed++; results.push({ case: name, result: `FAIL: ${err.message}` }); }
}
console.table(results);
if (failed) { console.error(`${failed} of ${cases.length} failed.`); process.exit(1); }
console.log(`All ${cases.length} passed`);
