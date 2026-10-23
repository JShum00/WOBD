// Tests for the report graph generator. Run: node scripts/test-report-graph.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecording } from '../js/replay-data.js';
import { buildSvg, findGaps, niceTicks, planPanels, renderPng } from './make-report-graph.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csvRows = (rows) => `timestamp,elapsed_ms,pid,name,value,unit\n${rows.map(([ms, pid, name, v, unit]) =>
  `2026-10-22T13:00:00.000Z,${ms},${pid},${name},${v},${unit}`).join('\n')}\n`;
const SPEED = (ms, v) => [ms, '0x0D', 'Speed', v, 'mph'];
const RPM = (ms, v) => [ms, '0x0C', 'Engine RPM', v, 'rpm'];
const BATT = (ms, v) => [ms, 'ATRV', 'Battery', v, 'V'];

const cases = [
  ['niceTicks gives round values inside the range', () => {
    assert.deepEqual(niceTicks(0, 45, 5), [0, 10, 20, 30, 40]);
    assert.deepEqual(niceTicks(-10, 10, 4), [-10, -5, 0, 5, 10]);
    assert.ok(niceTicks(3, 3).length >= 2);
  }],
  ['a stretch with no engine readings is a gap, even if the battery keeps reporting', () => {
    const rec = parseRecording(csvRows([SPEED(0, 1), SPEED(1000, 2), BATT(30000, 12.4), BATT(60000, 12.3), SPEED(90000, 3), SPEED(91000, 4)]));
    assert.deepEqual(findGaps(rec.series), [[1000, 90000]]);
  }],
  ['no gap when readings are steady', () => {
    const rec = parseRecording(csvRows([SPEED(0, 1), SPEED(5000, 2), SPEED(10000, 3)]));
    assert.deepEqual(findGaps(rec.series), []);
  }],
  ['panels without any data are left out', () => {
    const rec = parseRecording(csvRows([SPEED(0, 1), RPM(0, 800)]));
    const panels = planPanels(rec);
    assert.deepEqual(panels.map((p) => p.panel.title), ['Speed & RPM']);
    assert.equal(panels[0].right[0].def.key, 'rpm');
  }],
  ['a recording with none of the graphed gauges is refused', () => {
    const rec = parseRecording(csvRows([[0, '0x2F', 'Fuel tank level', 50, '%']]));
    assert.throws(() => buildSvg(rec), /none of the gauges/);
  }],
  ['the SVG has the title, an Engine off label, and breaks lines at the gap', () => {
    const rec = parseRecording(csvRows([SPEED(0, 1), SPEED(1000, 2), SPEED(120000, 3), SPEED(121000, 4)]));
    const svg = buildSvg(rec, { title: 'A <Test> & car' });
    assert.ok(svg.includes('A &lt;Test&gt; &amp; car'));
    assert.ok(svg.includes('Engine off'));
    assert.equal((svg.match(/<path /g) ?? []).length, 2);
  }],
  ['output is deterministic', () => {
    const rec = parseRecording(csvRows([SPEED(0, 1), SPEED(1000, 2)]));
    assert.equal(buildSvg(rec, { title: 'x' }), buildSvg(rec, { title: 'x' }));
  }],
  ['real recordings render to a PNG with every panel they have data for', async () => {
    const text = await readFile(join(root, 'reports/vlinker-fs-usb/toyota/2010/highlander/wobd-2010-toyota-highlander-recording-2026-10-22-091314.csv'), 'utf8');
    const rec = parseRecording(text);
    assert.equal(planPanels(rec).length, 6);
    assert.equal(findGaps(rec.series).length, 1);
    const png = await renderPng(buildSvg(rec, { title: 'Highlander' }));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }],
];

let failed = 0;
const rows = [];
for (const [name, test] of cases) {
  try { await test(); rows.push({ case: name, result: 'pass' }); } catch (err) { failed++; rows.push({ case: name, result: `FAIL: ${err.message}` }); }
}
console.table(rows);
if (failed) { console.error(`${failed} of ${cases.length} failed`); process.exit(1); }
console.log(`All ${cases.length} passed`);
