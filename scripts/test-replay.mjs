// Tests for reading recordings back on the replay page. Run: node scripts/test-replay.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CsvStreamParser, MAX_FILE_BYTES, parseCsv, parseRecording, parseRecordingStream, valueAt, indexAt, ReplayError } from '../js/replay-data.js';
import { Recording } from '../js/recorder.js';
import { LIVE_PIDS, BATTERY } from '../js/obd.js';

const SAMPLE = new URL('../reports/vlinker-fs-usb-pt-cruiser-2026-10-02/wobd-recording-2026-10-02-192055.csv', import.meta.url);
const def = (key) => LIVE_PIDS.find((d) => d.key === key);

// A stream of the given chunks, as file.stream() or response.body would deliver them.
const streamOf = (chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
});
const bytesIn = (bytes, sizes) => {
  const out = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length];
    out.push(bytes.subarray(at, at + size));
    at += size;
  }
  return out;
};
const rowsOf = (chunks) => {
  const rows = [];
  const parser = new CsvStreamParser((row) => rows.push(row));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return rows;
};

// Quotes, doubled quotes, CRLF/LF/CR, blank lines, a BOM, multi-byte text, an unknown PID,
// a status value with a comma, newline and quote, a bad row, and an out-of-order row.
const TRICKY = '\uFEFFtimestamp,elapsed_ms,pid,name,value,unit,protocol,baud\r\n'
  + '2026-10-02T21:30:05.250Z,250,0x0D,Speed,31,mph,"SAE ""J1850"" VPW",115200\r\n'
  + '\r\n'
  + '2026-10-02T21:30:05.500Z,500,0x03,Fuel system,"Closed loop, ""ok""\nsecond line é €",,,\n'
  + 'x,300,0x0D,Speed,29,mph,,\n'
  + 'x,abc,0x0D,Speed,30,mph,,\r'
  + 'x,700,0x55,Unknown,9,,,\r'
  + 'x,800,0x0D,Speed,,mph,,\n'
  + 'x,900,0x0D,Speed,32,mph,,';
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
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit\nx,1,0x0D,Speed,3,mph\nx,2,0x55,Unknown,90,\n');
    assert.equal(rec.readingCount, 1);
    assert.deepEqual(rec.unknownPids, ['0x55']);
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
  ['the size cap is 128 MiB', () => {
    assert.equal(MAX_FILE_BYTES, 128 * 1024 * 1024);
  }],
  ['stream parser: every two-chunk split of tricky CSV matches the one-piece parse', () => {
    const whole = rowsOf([TRICKY]);
    assert.deepEqual(whole, parseCsv(TRICKY));
    for (let i = 0; i <= TRICKY.length; i++) {
      assert.deepEqual(rowsOf([TRICKY.slice(0, i), TRICKY.slice(i)]), whole, `split at ${i}`);
    }
  }],
  ['stream parser: fixed chunk sizes of 1, 2, 3, 7 and 64 characters match', () => {
    const whole = rowsOf([TRICKY]);
    for (const size of [1, 2, 3, 7, 64]) {
      const chunks = [];
      for (let i = 0; i < TRICKY.length; i += size) chunks.push(TRICKY.slice(i, i + size));
      assert.deepEqual(rowsOf(chunks), whole, `size ${size}`);
    }
  }],
  ['stream parser: quote pairs and CRLF split across chunks, and quotes at end of input', () => {
    assert.deepEqual(rowsOf(['a,"b"', '"c",d\r', '\ne,f']), [['a', 'b"c', 'd'], ['e', 'f']]);
    assert.deepEqual(rowsOf(['"x"', '']), [['x']]);
    assert.deepEqual(rowsOf(['a,"unterminated']), parseCsv('a,"unterminated'));
    assert.deepEqual(rowsOf(['a\r', '\r', 'b']), parseCsv('a\r\rb'));
  }],
  ['parseRecordingStream: every two-chunk byte split of tricky CSV, even inside a UTF-8 character', async () => {
    const bytes = new TextEncoder().encode(TRICKY);
    const expected = parseRecording(TRICKY);
    assert.equal(expected.readingCount, 4);
    assert.deepEqual(expected.unknownPids, ['0x55']);
    assert.equal(find(expected, 'fuelsys').values[0], 'Closed loop, "ok"\nsecond line é €');
    assert.deepEqual(find(expected, 'speed').times, [250, 300, 900], 'sorted by time');
    for (let i = 0; i <= bytes.length; i++) {
      assert.deepEqual(await parseRecordingStream(streamOf([bytes.subarray(0, i), bytes.subarray(i)])), expected, `split at byte ${i}`);
    }
  }],
  ['parseRecordingStream: one-byte chunks and string chunks match parseRecording', async () => {
    const bytes = new TextEncoder().encode(TRICKY);
    const expected = parseRecording(TRICKY);
    assert.deepEqual(await parseRecordingStream(streamOf(bytesIn(bytes, [1]))), expected);
    assert.deepEqual(await parseRecordingStream(streamOf(bytesIn(bytes, [5, 11, 2]))), expected);
    assert.deepEqual(await parseRecordingStream(streamOf([TRICKY.slice(0, 40), TRICKY.slice(40)])), expected);
  }],
  ['parseRecordingStream: the PT Cruiser file streamed in odd chunks matches parseRecording', async () => {
    const bytes = readFileSync(SAMPLE);
    const expected = parseRecording(bytes.toString('utf8'));
    for (const sizes of [[4096], [1000], [997, 13, 1], [65536]]) {
      assert.deepEqual(await parseRecordingStream(streamOf(bytesIn(new Uint8Array(bytes), sizes))), expected, `chunks ${sizes}`);
    }
  }],
  ['parseRecordingStream: friendly errors, and a bad header cancels the stream', async () => {
    await assert.rejects(parseRecordingStream(streamOf([new TextEncoder().encode('name,email\nBob,b@x.com\n')])), ReplayError);
    await assert.rejects(parseRecordingStream(streamOf([])), ReplayError);
    await assert.rejects(parseRecordingStream(streamOf([new TextEncoder().encode('timestamp,elapsed_ms,pid,name,value,unit\n')])), /doesn't have any readings/);
    let cancelled = false;
    const endless = new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('a,b\n')); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(parseRecordingStream(endless), ReplayError);
    assert.equal(cancelled, true);
  }],
  ['out-of-order readings still sort, and ties keep file order', () => {
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit\nx,20,0x0D,Speed,2,mph\nx,10,0x0D,Speed,1,mph\nx,10,0x0D,Speed,9,mph\n');
    assert.deepEqual(find(rec, 'speed').times, [10, 10, 20]);
    assert.deepEqual(find(rec, 'speed').values, [1, 9, 2]);
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
