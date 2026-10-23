// Tests for the session report model and charts. Run: node scripts/test-session-report.mjs
// The DOM renderer is covered in the browser; everything checked here is pure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRecording } from '../js/replay-data.js';
import { detectEvents } from '../js/detectors.js';
import { buildSessionReport, chartSvg, clock, contextWindow, seriesStats, MAX_DETAIL_EVENTS } from '../js/session-report.js';
import { setUnits } from '../js/units.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

const PID = { rpm: ['0x0C', 'Engine RPM'], speed: ['0x0D', 'Speed'], fuelsys: ['0x03', 'Fuel system'], coolant: ['0x05', 'Coolant temp'] };
const base = Date.UTC(2026, 9, 2, 12);
function build(spec, { to = 60, step = 1, skip = () => false } = {}) {
  const lines = ['timestamp,elapsed_ms,pid,name,value,unit'];
  for (let s = 0; s <= to; s += step) {
    if (skip(s)) continue;
    for (const [key, fn] of Object.entries(spec)) {
      const ms = Math.round(s * 1000);
      lines.push(`${new Date(base + ms).toISOString()},${ms},${PID[key][0]},${PID[key][1]},${fn(s)},`);
    }
  }
  return parseRecording(`${lines.join('\n')}\n`);
}
const rec = build({ rpm: (s) => 800 + s * 10, speed: (s) => (s < 30 ? s : 60 - s) });

test('clock formats elapsed time', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65000), '1:05');
  assert.equal(clock(3725000), '1:02:05');
});

test('numeric stats find min, max, their times and the average of readings', () => {
  const s = seriesStats(rec.series.find((x) => x.def.key === 'rpm'));
  assert.equal(s.min, 800);
  assert.equal(s.tMin, 0);
  assert.equal(s.max, 1400);
  assert.equal(s.tMax, 60000);
  assert.equal(s.count, 61);
  assert.equal(Math.round(s.mean), 1100);
});

test('metric report stats and chart axes convert mph and Fahrenheit for display', () => {
  const r = build({ speed: () => 10, coolant: () => 212 });
  setUnits('metric');
  const speed = r.series.find((series) => series.def.key === 'speed');
  const temperature = r.series.find((series) => series.def.key === 'coolant');
  const speedStats = seriesStats(speed);
  const temperatureStats = seriesStats(temperature);
  assert.equal(speedStats.unit, 'km/h');
  assert.ok(Math.abs(speedStats.min - 16.09344) < 1e-9);
  assert.equal(temperatureStats.unit, '°C');
  assert.equal(temperatureStats.min, 100);
  const svg = chartSvg(speed, { t0: 0, t1: r.durationMs });
  assert.match(svg, />17<\/text>/);
  assert.doesNotMatch(svg, />11<\/text>/);
  setUnits('imperial');
});

test('categorical gauges get no stats and are listed as skipped', () => {
  const r = build({ rpm: () => 900, fuelsys: () => 'Closed loop' });
  const model = buildSessionReport(r);
  assert.deepEqual(model.stats.map((s) => s.key), ['rpm']);
  assert.equal(model.skipped.length, 1);
});

test('cover facts come from the recording, with gaps counted honestly', () => {
  const r = build({ rpm: () => 900 }, { to: 120, skip: (s) => s > 40 && s < 80 });
  const model = buildSessionReport(r, { vehicle: '  2010 Highlander\u0007 ' });
  assert.equal(model.vehicle, '2010 Highlander');
  assert.equal(model.gaps.length, 1);
  assert.equal(model.gapMs, model.gaps[0].to - model.gaps[0].from);
  assert.equal(model.connectedMs + model.gapMs, model.durationMs);
  assert.equal(model.readingCount, r.readingCount);
});

test('a gauge that goes quiet while others continue is reported', () => {
  const lines = ['timestamp,elapsed_ms,pid,name,value,unit'];
  for (let sec = 0; sec <= 100; sec++) {
    const ms = sec * 1000;
    const ts = new Date(base + ms).toISOString();
    lines.push(`${ts},${ms},0x0D,Speed,10,`);
    if (sec < 30 || sec > 70) lines.push(`${ts},${ms},0x0C,Engine RPM,900,`);
  }
  const model = buildSessionReport(parseRecording(`${lines.join('\n')}\n`));
  assert.deepEqual(model.quietGauges, ['Engine RPM']);
  assert.equal(model.gaps.length, 0);
});

test('an empty vehicle stays empty and the VIN is never in the model', () => {
  const model = buildSessionReport(rec);
  assert.equal(model.vehicle, '');
  assert.ok(!JSON.stringify(model).toLowerCase().includes('vin'));
});

test('events are all kept, with reviews attached, including dismissed ones', () => {
  const events = [
    { id: 'a@1', detector: 'a', from: 1000, to: 1000, title: 'A' },
    { id: 'b@2', detector: 'b', from: 2000, to: 3000, title: 'B' },
  ];
  const model = buildSessionReport(rec, { events, reviews: { 'a@1': 'dismissed' } });
  assert.equal(model.events.length, 2);
  assert.equal(model.events[0].review, 'dismissed');
  assert.equal(model.events[1].review, null);
});

test('detail sections are capped but the index is not', () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ id: `x@${i}`, detector: 'x', from: i * 100, to: i * 100, title: 'X' }));
  const model = buildSessionReport(rec, { events });
  assert.equal(model.events.length, 100);
  assert.equal(model.detailEvents.length, MAX_DETAIL_EVENTS);
});

test('only ticked notes are included, in time order, and the rest are counted', () => {
  const notes = [
    { id: 'n2', t: 5000, type: 'stop-sign', label: '', comment: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'n1', t: 1000, type: 'refueling', label: '', comment: 'gas', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'n3', t: 9000, type: 'road', label: '', comment: '', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const model = buildSessionReport(rec, { notes, includeNotes: new Set(['n1', 'n2']) });
  assert.deepEqual(model.notes.map((n) => n.id), ['n1', 'n2']);
  assert.equal(model.notesLeftOut, 1);
  assert.equal(buildSessionReport(rec, { notes }).notes.length, 3);
});

test('empty recordings cannot be opened, and a state-only one has no stats', () => {
  assert.throws(() => parseRecording('timestamp,elapsed_ms,pid,name,value,unit\n'));
  const model = buildSessionReport(build({ fuelsys: () => 'Closed loop' }, { to: 5 }), { events: [] });
  assert.equal(model.stats.length, 0);
  assert.equal(model.events.length, 0);
});

test('context window is centred, at least 30 s, and clamped to the recording', () => {
  const mid = contextWindow({ from: 100000, to: 100000 }, 600000);
  assert.equal(mid.t1 - mid.t0, 30000);
  assert.equal(mid.t0, 85000);
  const start = contextWindow({ from: 2000, to: 2000 }, 600000);
  assert.equal(start.t0, 0);
  assert.equal(start.t1, 30000);
  const end = contextWindow({ from: 599000, to: 599000 }, 600000);
  assert.equal(end.t1, 600000);
  const long = contextWindow({ from: 100000, to: 160000 }, 600000);
  assert.ok(long.t0 < 100000 && long.t1 > 160000);
});

test('chart breaks the line at a recording gap and shades it', () => {
  const r = build({ rpm: () => 900 }, { to: 120, skip: (s) => s > 40 && s < 80 });
  const svg = chartSvg(r.series[0], { t0: 0, t1: r.durationMs, gaps: r.gaps });
  assert.equal((svg.match(/M[\d.]+ /g) ?? []).length, 2);
  assert.ok(svg.includes('fill="#bbb"'));
});

test('chart escapes marker labels and survives a flat or empty window', () => {
  const svg = chartSvg(rec.series[0], { t0: 0, t1: rec.durationMs, markers: [{ t: 5000, label: '<b>"x"&' }] });
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('&lt;b&gt;'));
  const flat = build({ rpm: () => 900 });
  assert.ok(chartSvg(flat.series[0], { t0: 0, t1: flat.durationMs }).includes('<path'));
  assert.ok(chartSvg(flat.series[0], { t0: 1e7, t1: 1e7 + 1000 }).startsWith('<svg'));
});

test('real recordings build a report without error', () => {
  for (const f of ['reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv']) {
    const r = parseRecording(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    const model = buildSessionReport(r, { events: detectEvents(r) });
    assert.ok(model.stats.length > 3);
    for (const s of r.series) if (s.values.every((v) => typeof v === 'number')) assert.ok(chartSvg(s, { t0: 0, t1: r.durationMs, gaps: r.gaps }).includes('<path'));
  }
});

console.log(`${passed} passed`);
