// Tests for reading recordings back on the replay page. Run: node scripts/test-replay.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parseRecording, valueAt, indexAt, ReplayError } from '../js/replay-data.js';
import { Recording } from '../js/recorder.js';
import { LIVE_PIDS, BATTERY } from '../js/obd.js';

const SAMPLE = new URL('../reports/vlinker-fs-usb-pt-cruiser-2026-10-02/wobd-recording-2026-10-02-192055.csv', import.meta.url);
const def = (key) => LIVE_PIDS.find((d) => d.key === key);
const find = (rec, key) => rec.series.find((s) => s.def.key === key);

const cases = [
  ['parses quoted fields, doubled quotes, and \\r\\n', () => {
    assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,,3\r\n'), [['a', 'b, c', 'say "hi"'], ['1', '', '3']]);
  }],
  ['the PT Cruiser drive: every reading, 13 PIDs, protocol and baud', () => {
    const rec = parseRecording(readFileSync(SAMPLE, 'utf8'));
    assert.equal(rec.readingCount, 3035);
    assert.equal(rec.series.length, 13);
    assert.equal(rec.unknownPids.length, 0);
    assert.equal(rec.protocol, 'SAE J1850 VPW');
    assert.equal(rec.baudRate, 115200);
    assert.equal(rec.durationMs, 446856);
    assert.equal(new Date(rec.startedAt).toISOString(), '2026-10-02T23:20:55.330Z');
    assert.deepEqual(rec.series.slice(0, 2).map((s) => s.def.key), ['rpm', 'speed'], 'gauge order');
    assert.equal(Math.max(...find(rec, 'speed').values), 41);
  }],
  ['round trip: what the recorder writes, the replay reads', () => {
    const recording = new Recording(1000, { protocol: 'ISO 9141-2', baudRate: 38400 });
    recording.add(def('speed'), 12.4, 1200);
    recording.add(def('o2b1s1'), 0.45, 1300);
    recording.add(def('fuelsys'), 'Closed loop "normal"', 1400);
    recording.add(BATTERY, 13.6, 1500);
    const rec = parseRecording(recording.toCsv());
    assert.equal(rec.readingCount, 4);
    assert.deepEqual(find(rec, 'speed').values, [12]);
    assert.deepEqual(find(rec, 'o2b1s1').values, [0.45]);
    assert.deepEqual(find(rec, 'fuelsys').values, ['Closed loop "normal"']);
    assert.deepEqual(find(rec, 'battery').times, [500]);
    assert.equal(rec.protocol, 'ISO 9141-2');
    assert.equal(rec.baudRate, 38400);
  }],
  ['older 6-column files (no protocol/baud) still load', () => {
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit\n2026-10-02T21:30:05.250Z,250,0x0D,Speed,31,mph\n');
    assert.equal(rec.readingCount, 1);
    assert.equal(rec.protocol, null);
    assert.equal(rec.baudRate, null);
  }],
  ['"unknown" protocol and baud read as unknown', () => {
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit,protocol,baud\n2026-10-02T21:30:05.250Z,250,0x0D,Speed,31,mph,unknown,unknown\n');
    assert.equal(rec.protocol, null);
    assert.equal(rec.baudRate, null);
  }],
  ['unknown PIDs are skipped and reported', () => {
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit\nx,1,0x0D,Speed,3,mph\nx,2,0x5C,Oil temp,90,C\n');
    assert.equal(rec.readingCount, 1);
    assert.deepEqual(rec.unknownPids, ['0x5C']);
  }],
  ['valueAt: latest reading at or before t', () => {
    const series = { times: [100, 200, 300], values: [1, 2, 3] };
    assert.equal(valueAt(series, 99), null);
    assert.equal(valueAt(series, 100), 1);
    assert.equal(valueAt(series, 250), 2);
    assert.equal(valueAt(series, 300), 3);
    assert.equal(valueAt(series, 9e9), 3);
    assert.equal(indexAt({ times: [], values: [] }, 5), -1);
  }],
  ['not a WOBD file is a friendly error', () => {
    assert.throws(() => parseRecording('name,email\nBob,bob@example.com\n'), ReplayError);
    assert.throws(() => parseRecording(''), ReplayError);
  }],
  ['a header with no readings is a friendly error', () => {
    assert.throws(() => parseRecording('timestamp,elapsed_ms,pid,name,value,unit,protocol,baud\r\n'), /doesn't have any readings/);
  }],
];

let failed = 0;
const rows = cases.map(([name, test]) => {
  try {
    test();
    return { case: name, result: 'pass' };
  } catch (err) {
    failed++;
    return { case: name, result: `FAIL: ${err.message}` };
  }
});
console.table(rows);
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
