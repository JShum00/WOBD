// Tests for the recording event detectors. Run: node scripts/test-detectors.mjs
// Builds seeded recordings in memory, so nothing needs a car or a browser.
import assert from 'node:assert/strict';
import { parseRecording } from '../js/replay-data.js';
import { DETECTOR_VERSION, detectEvents } from '../js/detectors.js';

const PID = { rpm: ['0x0C', 'Engine RPM'], speed: ['0x0D', 'Speed'], throttle: ['0x11', 'Throttle'], coolant: ['0x05', 'Coolant temp'], fuelsys: ['0x03', 'Fuel system'] };
const base = Date.UTC(2026, 9, 2, 12);
// spec: { key: fn(seconds) => value }, sampled every `step` seconds from `from` to `to`, skipping `skip(s)`.
function build(spec, { from = 0, to = 120, step = 0.5, skip = () => false } = {}) {
  const lines = ['timestamp,elapsed_ms,pid,name,value,unit'];
  for (let s = from; s <= to; s += step) {
    if (skip(s)) continue;
    for (const [key, fn] of Object.entries(spec)) {
      const v = fn(s);
      if (v === undefined) continue;
      const ms = Math.round(s * 1000);
      lines.push(`${new Date(base + ms).toISOString()},${ms},${PID[key][0]},${PID[key][1]},${v},`);
    }
  }
  return parseRecording(`${lines.join('\n')}\n`);
}
const by = (events, detector) => events.filter((e) => e.detector === detector);
const steadyCruise = { speed: () => 40, throttle: () => 20, coolant: () => 190 };

const cases = [
  ['a steady drive produces no events', () => {
    assert.deepEqual(detectEvents(build({ ...steadyCruise, rpm: (s) => 2000 + Math.sin(s) * 50 })), []);
  }],
  ['2,000 to 4,000 rpm at a steady 30 mph is flagged once, with evidence and cautious words', () => {
    const rec = build({ speed: () => 30, throttle: () => 20, rpm: (s) => (s >= 50 && s < 60 ? 4000 : 2000) });
    const ev = by(detectEvents(rec), 'rpm-swing');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].version, DETECTOR_VERSION);
    assert.ok(ev[0].from >= 45000 && ev[0].to <= 66000);
    assert.match(ev[0].explanation, /may be a gear shift/i);
    assert.doesNotMatch(ev[0].explanation, /failing|broken|bad transmission/i);
    assert.ok(ev[0].evidence.some((e) => e.key === 'speed') && ev[0].threshold.rpmChange === 1500);
  }],
  ['the same rpm change while accelerating is not flagged', () => {
    const rec = build({ speed: (s) => 20 + s, throttle: () => 40, rpm: (s) => 1500 + s * 40 });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['revving at 0 mph (parked) is not flagged', () => {
    const rec = build({ speed: () => 0, throttle: () => 20, rpm: (s) => (s >= 50 && s < 60 ? 4000 : 800) });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['driver throttle explains an rpm rise', () => {
    const rec = build({ speed: () => 40, throttle: (s) => (s >= 50 ? 60 : 20), rpm: (s) => (s >= 50 ? 4000 : 2000) });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['stale speed readings block an rpm-swing flag', () => {
    const rec = build({ speed: (s) => (s < 40 ? 40 : undefined), throttle: () => 20, rpm: (s) => (s >= 50 && s < 60 ? 4000 : 2000) });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['irregular, slow sampling does not create rpm flags from skew', () => {
    const rec = build({ ...steadyCruise, rpm: (s) => (Math.floor(s / 6) % 2 ? 4000 : 2000) }, { step: 6 });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['a single wild rpm sample (a spike) is not flagged', () => {
    const rec = build({ ...steadyCruise, rpm: (s) => (s === 50 ? 6000 : 2000) });
    assert.equal(by(detectEvents(rec), 'rpm-swing').length, 0);
  }],
  ['a recording gap is reported as lost readings and never as a stall', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000 }, { to: 400, skip: (s) => s > 60 && s < 300 });
    const ev = detectEvents(rec);
    assert.equal(by(ev, 'comm-loss').length, 1);
    assert.equal(by(ev, 'suspected-stall').length, 0);
    assert.match(by(ev, 'comm-loss')[0].explanation, /not a stall/);
  }],
  ['fresh rpm falling to zero while other gauges answer is a suspected stall', () => {
    const rec = build({ speed: () => 0, coolant: () => 190, throttle: () => 0, rpm: (s) => (s >= 60 ? 0 : 800) });
    const ev = by(detectEvents(rec), 'suspected-stall');
    assert.equal(ev.length, 1);
    assert.match(ev[0].explanation, /deliberate shut-off/);
    assert.ok(ev[0].evidence.some((e) => e.key === 'rpm' && e.value === 0));
  }],
  ['engine-off with everything going silent (a gas station stop) is not a stall', () => {
    const rec = build({ speed: () => 0, coolant: () => 190, throttle: () => 0, rpm: () => 800 }, { to: 200, skip: (s) => s > 60 && s < 150 });
    assert.equal(by(detectEvents(rec), 'suspected-stall').length, 0);
  }],
  ['rpm at 0 from the start (key on, engine off) is not a stall', () => {
    const rec = build({ speed: () => 0, coolant: () => 190, throttle: () => 0, rpm: () => 0 });
    assert.equal(by(detectEvents(rec), 'suspected-stall').length, 0);
  }],
  ['a lone rpm 0 reading is a dropout, not a stall', () => {
    const rec = build({ speed: () => 0, coolant: () => 190, throttle: () => 0, rpm: (s) => (s === 60 ? 0 : 800) });
    assert.equal(by(detectEvents(rec), 'suspected-stall').length, 0);
  }],
  ['rpm 0 with other gauges silent is not a stall', () => {
    const rec = build({ rpm: (s) => (s >= 60 ? 0 : 800) });
    assert.equal(by(detectEvents(rec), 'suspected-stall').length, 0);
  }],
  ['zero rpm at road speed notes that some hybrids do this normally', () => {
    const rec = build({ speed: () => 35, coolant: () => 190, throttle: () => 10, rpm: (s) => (s >= 60 ? 0 : 1800) });
    const ev = by(detectEvents(rec), 'suspected-stall');
    assert.equal(ev.length, 1);
    assert.match(ev[0].explanation, /hybrids/);
  }],
  ['open loop while warming up then closed loop is routine info, not a notice', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000, fuelsys: (s) => (s < 40 ? 'Open loop · engine warming up' : 'Closed loop') });
    const ev = by(detectEvents(rec), 'loop-change');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].severity, 'info');
  }],
  ['open-loop deceleration (coasting) is routine info', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000, fuelsys: (s) => (s >= 50 && s < 60 ? 'Open loop · load or coasting' : 'Closed loop') });
    const ev = detectEvents(rec).filter((e) => e.detector.startsWith('loop'));
    assert.ok(ev.length > 0 && ev.every((e) => e.severity === 'info'));
  }],
  ['one stray status reading does not count as a change', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000, fuelsys: (s) => (s === 50 ? 'Open loop · load or coasting' : 'Closed loop') });
    assert.equal(by(detectEvents(rec), 'loop-change').length, 0);
  }],
  ['a fault state is a notice with the car’s own wording', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000, fuelsys: () => 'Open loop · system fault' });
    const ev = by(detectEvents(rec), 'loop-fault');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].severity, 'notice');
    assert.match(ev[0].explanation, /system fault/);
  }],
  ['rapid back-and-forth mode changes are noted once as a notice', () => {
    const rec = build({ ...steadyCruise, rpm: () => 2000, fuelsys: (s) => (Math.floor(s / 5) % 2 ? 'Open loop · load or coasting' : 'Closed loop') }, { to: 60 });
    assert.equal(by(detectEvents(rec), 'loop-flapping').length, 1);
  }],
  ['detection is deterministic and leaves the recording untouched', () => {
    const rec = build({ speed: () => 30, throttle: () => 20, rpm: (s) => (s >= 50 && s < 60 ? 4000 : 2000) });
    const before = JSON.stringify(rec.series.map((s) => [s.times, s.values]));
    const a = detectEvents(rec);
    assert.deepEqual(detectEvents(rec), a);
    assert.equal(JSON.stringify(rec.series.map((s) => [s.times, s.values])), before);
    assert.ok(new Set(a.map((e) => e.id)).size === a.length);
  }],
  ['recordings without the needed gauges just return no events', () => {
    assert.deepEqual(detectEvents(build({ coolant: () => 190 })), []);
  }],
];

let failed = 0;
const rows = cases.map(([name, test]) => {
  try { test(); return { case: name, result: 'pass' }; } catch (err) { failed++; return { case: name, result: `FAIL: ${err.message}` }; }
});
console.table(rows);
if (failed) { console.error(`${failed} of ${cases.length} failed.`); process.exit(1); }
console.log(`All ${cases.length} passed`);
