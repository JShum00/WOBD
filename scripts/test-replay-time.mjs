// Tests for the replay timeline: timestamp anchors, data-quality flags and connection gaps.
// Run: node scripts/test-replay-time.mjs
import assert from 'node:assert/strict';
import { parseRecording, CLOCK_JUMP_MS } from '../js/replay-data.js';

const HEAD = 'timestamp,elapsed_ms,pid,name,value,unit\n';
const row = (ts, ms, pid = '0x0D', name = 'Speed', value = 10, unit = 'mph') => `${ts},${ms},${pid},${name},${value},${unit}\n`;
const iso = (ms) => new Date(Date.UTC(2026, 9, 2, 12, 0, 0) + ms).toISOString();
const sec = (s, ...rest) => row(iso(s * 1000), s * 1000, ...rest);
const parse = (...rows) => parseRecording(HEAD + rows.join(''));

const cases = [
  ['absolute timestamps anchor the start and say the zone is explicit', () => {
    const rec = parse(sec(1), sec(2));
    assert.equal(rec.startedAt, Date.UTC(2026, 9, 2, 12, 0, 0));
    assert.deepEqual(rec.timeInfo, { source: 'recorded', zone: 'explicit' });
  }],
  ['a timestamp with no zone is labeled as assumed local, never as UTC', () => {
    const rec = parse(row('2026-10-02 12:00:01', 1000), row('2026-10-02 12:00:02', 2000));
    assert.equal(rec.timeInfo.zone, 'assumed-local');
    assert.equal(rec.startedAt, new Date('2026-10-02 12:00:00').getTime());
  }],
  ['elapsed-only files get no invented wall clock', () => {
    const rec = parse(row('', 1000), row('', 2000));
    assert.equal(rec.startedAt, null);
    assert.deepEqual(rec.timeInfo, { source: 'elapsed', zone: null });
    assert.equal(rec.quality.missingTimestamps, 2);
    assert.equal(rec.durationMs, 2000);
  }],
  ['malformed timestamps are counted, the rows are kept, and the first one is located', () => {
    const rec = parse(sec(1), row('not a time', 2000), sec(3));
    assert.equal(rec.quality.malformedTimestamps, 1);
    assert.equal(rec.quality.firstProblem.malformedTimestamps, 2);
    assert.equal(rec.readingCount, 3);
    assert.deepEqual(rec.series[0].times, [1000, 2000, 3000]);
  }],
  ['a blank timestamp between good ones is counted without moving the anchor', () => {
    const rec = parse(sec(1), row('', 2000), sec(3));
    assert.equal(rec.quality.missingTimestamps, 1);
    assert.equal(rec.startedAt, Date.UTC(2026, 9, 2, 12, 0, 0));
  }],
  ['duplicate readings are kept and flagged', () => {
    const rec = parse(sec(1), sec(1), sec(2));
    assert.equal(rec.quality.duplicateRows, 1);
    assert.deepEqual(rec.series[0].times, [1000, 1000, 2000]);
  }],
  ['out-of-order rows are flagged and the series still plays in time order', () => {
    const rec = parse(sec(1), sec(3), sec(2), sec(4));
    assert.equal(rec.quality.outOfOrderRows, 1);
    assert.equal(rec.quality.firstProblem.outOfOrderRows, 3);
    assert.deepEqual(rec.series[0].times, [1000, 2000, 3000, 4000]);
  }],
  ['a wall clock that steps back is reported as a clock change, not negative elapsed time', () => {
    const back = row(iso(60000 - 3600 * 1000), 61000);
    const rec = parse(sec(1), sec(60), back, sec(62));
    assert.ok(rec.quality.clockJumps >= 1);
    assert.ok(rec.series[0].times.every((t) => t >= 0));
  }],
  ['small timestamp jitter is not a clock change', () => {
    const rec = parse(row(iso(1000 + CLOCK_JUMP_MS - 1000), 1000), sec(2), sec(3));
    assert.equal(rec.quality.clockJumps, 0);
  }],
  ['clean files report no problems', () => {
    const rec = parse(sec(1), sec(2), sec(3));
    assert.deepEqual(rec.quality, {
      missingTimestamps: 0, malformedTimestamps: 0, duplicateRows: 0, outOfOrderRows: 0, clockJumps: 0, firstProblem: {},
    });
  }],
  ['a connection gap is a stretch where no PID answered; another PID filling it means no gap', () => {
    const gappy = parse(sec(1), sec(2), sec(60), sec(61));
    assert.deepEqual(gappy.gaps, [{ from: 2000, to: 60000 }]);
    const covered = parse(sec(1), sec(2), sec(30, '0x0C', 'RPM', 800, 'rpm'), sec(60), sec(61));
    assert.equal(covered.gaps.length, 0);
  }],
  ['a ~4.5 minute interruption stays a gap and never becomes a stall signal', () => {
    const rec = parse(...Array.from({ length: 20 }, (_, i) => sec(i + 1)), ...Array.from({ length: 20 }, (_, i) => sec(300 + i)));
    assert.equal(rec.gaps.length, 1);
    assert.ok(rec.gaps[0].to - rec.gaps[0].from > 270000);
  }],
  ['gaps scale with a slow sampling interval', () => {
    const rec = parse(...Array.from({ length: 10 }, (_, i) => sec(i * 8)));
    assert.equal(rec.gaps.length, 0);
  }],
];

let failed = 0;
const rows = cases.map(([name, test]) => {
  try { test(); return { case: name, result: 'pass' }; } catch (err) { failed++; return { case: name, result: `FAIL: ${err.message}` }; }
});
console.table(rows);
if (failed) { console.error(`${failed} of ${cases.length} failed.`); process.exit(1); }
console.log(`All ${cases.length} passed`);
