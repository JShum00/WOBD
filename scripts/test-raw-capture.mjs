// Tests for raw capture of undecoded parameters. Run: node scripts/test-raw-capture.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { RawBudget, RawOptIn, SPEED_FRESH_MS, rawEvery } from '../js/raw-capture.js';
import { DriveLock, Recording, DRIVING_SPEED_MPH } from '../js/recorder.js';
import { readRawPid, readPidDetailed, MODE01_DECODERS } from '../js/obd.js';
import { parseRecording } from '../js/replay-data.js';

const elm = (reply) => ({ send: async () => reply });
const every = (speed, valid = true, prev = null) => rawEvery(speed, valid, prev);

const cases = [
  ['rawEvery: stationary 1, slow 3, driving 6', () => {
    assert.deepEqual(every(0), { band: 'stationary', every: 1 });
    assert.deepEqual(every(3), { band: 'slow', every: 3 });
    assert.deepEqual(every(DRIVING_SPEED_MPH + 5), { band: 'driving', every: 6 });
  }],
  ['rawEvery: missing or stale speed is conservative, never "parked"', () => {
    for (const args of [[0, false], [null, true], [undefined, true], [NaN, true], [0, false, 'stationary']]) {
      assert.deepEqual(rawEvery(...args), { band: 'unknown', every: 6 });
    }
  }],
  ['rawEvery: hysteresis stops flapping near boundaries', () => {
    assert.equal(every(1, true, 'stationary').band, 'stationary');
    assert.equal(every(2, true, 'stationary').band, 'slow');
    assert.equal(every(DRIVING_SPEED_MPH + 1, true, 'slow').band, 'slow');
    assert.equal(every(DRIVING_SPEED_MPH + 2, true, 'slow').band, 'driving');
    assert.equal(every(DRIVING_SPEED_MPH, true, 'driving').band, 'driving');
    assert.equal(every(DRIVING_SPEED_MPH - 2, true, 'driving').band, 'slow');
    let band = null;
    let changes = 0;
    for (const speed of [4, 6.5, 5.5, 6.5, 5.5, 6.2, 5.2, 6.6, 5.4]) {
      const next = every(speed, true, band).band;
      if (band && next !== band) changes++;
      band = next;
    }
    assert.ok(changes <= 1, `${changes} band changes`);
  }],
  ['DriveLock records when speed arrived, so staleness can be judged', () => {
    const lock = new DriveLock({ hasSpeed: true, hasRpm: true }, 0);
    assert.equal(lock.speedAt, null);
    lock.update({ pid: 0x0D }, 12, 1000);
    assert.deepEqual([lock.speed, lock.speedAt], [12, 1000]);
    assert.ok(SPEED_FRESH_MS > 0);
  }],
  ['budget: gauges keep priority, and parked cars may spend more', () => {
    const budget = new RawBudget();
    for (let i = 0; i < 20; i++) budget.note('gauge', 300);
    assert.equal(budget.allows('driving'), true);
    for (let i = 0; i < 20; i++) budget.note('raw', 150);
    assert.equal(budget.allows('driving'), false);
    assert.equal(budget.allows('unknown'), false);
    assert.equal(budget.allows('stationary'), true);
  }],
  ['opt-in: ticking asks for the dialog; confirm needs the acknowledgement', () => {
    const optIn = new RawOptIn();
    assert.equal(optIn.request(), true);
    assert.equal(optIn.canConfirm, false);
    assert.equal(optIn.confirm(), false);
    optIn.setAcknowledged(true);
    assert.equal(optIn.canConfirm, true);
    assert.equal(optIn.confirm(), true);
  }],
  ['opt-in: cancel, Escape, or close never enable it', () => {
    const optIn = new RawOptIn();
    optIn.request();
    optIn.setAcknowledged(true);
    optIn.cancel();
    assert.deepEqual([optIn.enabled, optIn.acknowledged], [false, false]);
    assert.equal(optIn.confirm(), false);
  }],
  ['opt-in: acknowledgement resets when disabled and re-enabled', () => {
    const optIn = new RawOptIn();
    optIn.request();
    optIn.setAcknowledged(true);
    optIn.confirm();
    optIn.disable();
    assert.equal(optIn.enabled, false);
    assert.equal(optIn.request(), true);
    assert.equal(optIn.canConfirm, false);
    assert.equal(optIn.confirm(), false);
  }],
  ['opt-in: locked while recording, so it cannot change mid-recording', () => {
    const optIn = new RawOptIn();
    optIn.request();
    optIn.setAcknowledged(true);
    optIn.confirm();
    optIn.lock();
    assert.equal(optIn.request(), false);
    optIn.disable();
    assert.equal(optIn.enabled, true);
    optIn.unlock();
    optIn.disable();
    assert.equal(optIn.enabled, false);
  }],
  ['readRawPid keeps each responding ECU separately with its PID bytes', async () => {
    const replies = await readRawPid(elm(['7E8 04 41 55 12 34', '7E9 04 41 55 AB CD']), 0x55);
    assert.deepEqual(replies, [{ raw: '1234', ecu: '7E8' }, { raw: 'ABCD', ecu: '7E9' }]);
    assert.deepEqual(await readRawPid(elm(['NO DATA']), 0x55), []);
  }],
  ['readPidDetailed reports the responding ECU', async () => {
    const result = await readPidDetailed(elm(['7E8 04 41 24 80 00 40 00'.replace('04', '06')]), MODE01_DECODERS.get(0x24));
    assert.equal(result.ecu, '7E8');
  }],
  ['CSV rows keep PID, mode and ECU for raw responses, and replay still reads them', () => {
    const rec = new Recording(0, { protocol: 'CAN 11-bit 500k', baudRate: 115200 });
    rec.add({ pid: 0x55, label: 'Unnamed parameter' }, null, 100, '1A2B', '7E8');
    rec.add({ pid: 0x55, label: 'Unnamed parameter' }, null, 100, 'FFFF', '7E9');
    const lines = rec.toCsv().split('\r\n');
    assert.equal(lines[0], 'timestamp,elapsed_ms,pid,name,value,unit,protocol,baud,raw,mode,ecu');
    assert.equal(lines[1], '1970-01-01T00:00:00.100Z,100,0x55,Unnamed parameter,,,CAN 11-bit 500k,115200,1A2B,01,7E8');
    assert.equal(lines[2].split(',').slice(-3).join(','), 'FFFF,01,7E9');
    rec.add({ pid: 0x0D, label: 'Speed', unit: 'mph' }, 3, 200);
    const parsed = parseRecording(rec.toCsv());
    assert.deepEqual(parsed.unknownPids, ['0x55']);
  }],
  ['old recordings without mode or ecu columns still replay', () => {
    const rec = parseRecording('timestamp,elapsed_ms,pid,name,value,unit,protocol,baud,raw\nx,1,0x0D,Speed,3,mph,p,115200,\n');
    assert.equal(rec.readingCount, 1);
  }],
];

let failed = 0;
const rows = [];
for (const [name, run] of cases) {
  try {
    await run();
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
