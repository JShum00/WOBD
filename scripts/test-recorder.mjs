// Tests for live data recording and the driving lock. Run: node scripts/test-recorder.mjs
// Replays drives with fake timestamps, so nothing here needs a car or a browser.
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import {
  DriveLock, Recording, DRIVING_SPEED_MPH, STOPPED_UNLOCK_MS, NO_DETECTION_UNLOCK_MS, LOST_AFTER_MS,
} from '../js/recorder.js';
import { LIVE_PIDS, BATTERY } from '../js/obd.js';

const def = (key) => LIVE_PIDS.find((d) => d.key === key);
const SPEED = def('speed');
const RPM = def('rpm');
const STEP = 250;  // ms between speed replies, about what a real adapter manages

// Feeds one reading per entry: [speed, rpm]. undefined skips that PID, null is a dropout.
function drive(lock, readings, start = 0) {
  let now = start;
  for (const [speed, rpm] of readings) {
    now += STEP;
    if (speed !== undefined) lock.update(SPEED, speed, now);
    if (rpm !== undefined) lock.update(RPM, rpm, now);
  }
  return now;
}

const repeat = (reading, ms) => Array.from({ length: Math.round(ms / STEP) }, () => reading);
const newLock = (opts = {}) => new DriveLock({ hasSpeed: true, hasRpm: true, ...opts }, 0);
const unlockedAt = (lock, now) => lock.status(now).unlocked;
const driven = () => repeat([30, 2000], 5000);

const cases = [
  ['starting at 0 mph never unlocks', () => {
    const lock = newLock();
    const now = drive(lock, repeat([0, 750], 60000));
    assert.equal(unlockedAt(lock, now), false);
  }],
  [`slow creeping (${DRIVING_SPEED_MPH} mph) is not driving`, () => {
    const lock = newLock();
    const now = drive(lock, [...repeat([DRIVING_SPEED_MPH, 900], 5000), ...repeat([0, 750], 30000)]);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['stopped just under the limit stays locked', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), ...repeat([0, 750], STOPPED_UNLOCK_MS)]);
    // The first 0 only starts the clock, so this many replies add up to one STEP short.
    assert.equal(lock.stoppedMs, STOPPED_UNLOCK_MS - STEP);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['stopped for the full time unlocks', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), ...repeat([0, 750], STOPPED_UNLOCK_MS + STEP)]);
    assert.equal(unlockedAt(lock, now), true);
  }],
  ['dropouts neither add stopped time nor reset it', () => {
    const lock = newLock();
    let now = drive(lock, [...driven(), ...repeat([0, 750], 5000 + STEP)]);
    assert.equal(lock.stoppedMs, 5000);
    now = drive(lock, repeat([null, null], 60000), now);
    assert.equal(lock.stoppedMs, 5000, 'a minute of dropouts adds nothing');
    assert.equal(unlockedAt(lock, now), false);
    now = drive(lock, repeat([0, 750], 5000 + STEP), now);
    assert.equal(lock.stoppedMs, 10000, 'the earlier stopped time was kept');
  }],
  ['a single dropout between zeros skips just that gap', () => {
    const lock = newLock();
    drive(lock, [...driven(), [0, 750], [0, 750], [null, 750], [0, 750], [0, 750]]);
    assert.equal(lock.stoppedMs, 2 * STEP);
  }],
  ['a valid nonzero speed resets the timer', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), ...repeat([0, 750], 10000), [1, 800], ...repeat([0, 750], 10000)]);
    assert.ok(lock.stoppedMs < STOPPED_UNLOCK_MS);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['rpm 0 after stopping unlocks at once', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), [0, 750], [0, 0]]);
    assert.equal(unlockedAt(lock, now), true);
  }],
  ['rpm 0 while moving (hybrid on battery) does not unlock', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), ...repeat([20, 0], 5000)]);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['rpm 0 before driving does not unlock', () => {
    const lock = newLock();
    const now = drive(lock, repeat([0, 0], 5000));
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['a missed rpm reply does not unlock', () => {
    const lock = newLock();
    const now = drive(lock, [...driven(), [0, null], [0, null]]);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['driving off again before pressing Unlock locks it again', () => {
    const lock = newLock();
    let now = drive(lock, [...driven(), [0, 0]]);
    assert.equal(unlockedAt(lock, now), true);
    now = drive(lock, [[25, 2200]], now);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['Keep Recording resets to "just started"', () => {
    const lock = newLock();
    let now = drive(lock, [...driven(), [0, 0]]);
    lock.reset(now);
    now = drive(lock, repeat([0, 750], 30000), now);
    assert.equal(unlockedAt(lock, now), false);
  }],
  ['no speed PID falls back to a plain unlock after a delay', () => {
    const lock = new DriveLock({ hasSpeed: false, hasRpm: false }, 0);
    assert.equal(lock.status(NO_DETECTION_UNLOCK_MS - 1).unlocked, false);
    assert.deepEqual(lock.status(NO_DETECTION_UNLOCK_MS), { unlocked: true, detectionUnavailable: true, lost: true });
  }],
  ['no speed PID, but rpm 0 unlocks early', () => {
    const lock = new DriveLock({ hasSpeed: false, hasRpm: true }, 0);
    const now = drive(lock, [[undefined, 0]]);
    assert.equal(unlockedAt(lock, now), true);
  }],
  ['no valid PID replies for a while means lost', () => {
    const lock = newLock();
    let now = drive(lock, driven());
    assert.equal(lock.status(now).lost, false);
    lock.update(BATTERY, 12.4, now + LOST_AFTER_MS);  // the adapter's own voltage doesn't count
    assert.equal(lock.status(now + LOST_AFTER_MS).lost, true);
    now = drive(lock, [[0, 750]], now + LOST_AFTER_MS);
    assert.equal(lock.status(now).lost, false, 'answers again: no longer lost');
  }],
  ['CSV has one row per valid reading, dropouts skipped', () => {
    const start = Date.UTC(2026, 9, 2, 21, 30, 5);
    const rec = new Recording(start, { protocol: 'SAE J1850 VPW', baudRate: 115200 });
    rec.add(SPEED, 31.0686, start + 250);
    rec.add(RPM, null, start + 300);
    rec.add(def('o2b1s1'), 0.4521, start + 400);
    rec.add(def('fuelsys'), 'Closed loop "normal"', start + 500);
    rec.add(BATTERY, 13.98, start + 600);
    rec.add(RPM, NaN, start + 700);
    assert.equal(rec.toCsv(), [
      'timestamp,elapsed_ms,pid,name,value,unit,protocol,baud',
      '2026-10-02T21:30:05.250Z,250,0x0D,Speed,31,mph,SAE J1850 VPW,115200',
      '2026-10-02T21:30:05.400Z,400,0x14,"O2 sensor, bank 1 sensor 1",0.45,V,SAE J1850 VPW,115200',
      '2026-10-02T21:30:05.500Z,500,0x03,Fuel system,"Closed loop ""normal""",,SAE J1850 VPW,115200',
      '2026-10-02T21:30:05.600Z,600,ATRV,Battery,14.0,V,SAE J1850 VPW,115200',
      '',
    ].join('\r\n'));
  }],
  ['unknown protocol and baud say "unknown", not blank', () => {
    const rec = new Recording(0);
    rec.add(SPEED, 0, 100);
    assert.equal(rec.toCsv().split('\r\n')[1], '1970-01-01T00:00:00.100Z,100,0x0D,Speed,0,mph,unknown,unknown');
  }],
  ['filename is wobd-recording-YYYY-MM-DD-HHMMSS.csv (local time)', () => {
    const rec = new Recording(new Date(2026, 9, 2, 7, 4, 9).getTime());
    assert.equal(rec.filename(), 'wobd-recording-2026-10-02-070409.csv');
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
