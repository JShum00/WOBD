// Draws the standard graph image for a WOBD live data recording, so every report's
// graph looks the same and comes straight from the CSV.
//
//   node scripts/make-report-graph.mjs <recording.csv> [--title "2010 Toyota Highlander"] [--out graph.png]
//   node scripts/make-report-graph.mjs --all     # every test in data/tested-adapters.json that has a CSV
//
// The image is built as an SVG (buildSvg) and turned into a PNG with @resvg/resvg-js
// (npm install first). Panels or lines the recording has no data for are left out.
// Text uses DejaVu Sans when installed, so install it to get the same look on every machine.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecording } from '../js/replay-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const GAP_MS = 20_000;   // silence longer than this means the engine was shut off
const W = 1320;
const PLOT = { left: 78, right: 78, height: 230, gap: 84 };
const HEADER = 120;
const FOOTER = 52;
const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2'];

// Each panel lists series keys (from js/obd.js) for the left and the optional right axis.
export const PANELS = [
  { title: 'Speed & RPM', left: ['speed'], leftLabel: 'Speed (mph)', right: ['rpm'], rightLabel: 'RPM' },
  { title: 'Fuel trims (green band = ±10%)', left: ['ltft', 'stft'], leftLabel: '%', band: [-10, 10] },
  { title: 'O2 sensors', left: ['o2b1s1', 'o2b1s2'], leftLabel: 'Volts', mid: 0.45 },
  { title: 'Catalyst temperature', left: ['catalystb1s1', 'catalystb1s2', 'catalystb2s1', 'catalystb2s2'], leftLabel: '°F' },
  { title: 'Airflow, throttle & load', left: ['map', 'maf', 'throttle', 'load'], leftLabel: 'kPa, g/s or %' },
  { title: 'Temperatures & voltage', left: ['coolant', 'iat', 'ambienttemp', 'oiltemp'], leftLabel: '°F',
    right: ['battery', 'modulevoltage'], rightLabel: 'Volts' },
];

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => (Math.round(n * 10) / 10).toString();

// Round tick values spanning [min, max], about `count` of them.
export function niceTicks(min, max, count = 5) {
  if (!(max > min)) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

// Stretches of time with no engine readings: [[startMs, endMs], ...]. The battery reading
// is left out because the adapter keeps answering it with the engine off.
export function findGaps(series, gapMs = GAP_MS) {
  const times = series.filter((s) => s.def.key !== 'battery').flatMap((s) => s.times).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > gapMs) gaps.push([times[i - 1], times[i]]);
  return gaps;
}

// Which panels have data, and the series each one draws: [{ panel, left: [s], right: [s] }].
export function planPanels(recording) {
  const byKey = new Map(recording.series.map((s) => [s.def.key, s]));
  const pick = (keys = []) => keys.map((k) => byKey.get(k)).filter((s) => s && s.values.some(Number.isFinite));
  return PANELS
    .map((panel) => ({ panel, left: pick(panel.left), right: pick(panel.right) }))
    .filter((p) => p.left.length || p.right.length);
}

// One point per pixel column keeps the SVG small: the lowest and highest value in each column, in time order.
function thin(times, values, xOf, gaps) {
  const out = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const pts = bucket.lo.t < bucket.hi.t ? [bucket.lo, bucket.hi] : [bucket.hi, bucket.lo];
    if (bucket.first.t < pts[0].t) pts.unshift(bucket.first);
    out.push(...pts.filter((p, i) => i === 0 || p.t !== pts[i - 1].t));
    bucket = null;
  };
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const p = { t: times[i], v };
    const col = Math.round(xOf(p.t));
    if (!bucket || bucket.col !== col) { flush(); bucket = { col, first: p, lo: p, hi: p }; }
    if (p.v < bucket.lo.v) bucket.lo = p;
    if (p.v > bucket.hi.v) bucket.hi = p;
  }
  flush();
  // Start a new line wherever a gap falls between two points.
  const lines = [];
  let line = [];
  for (const p of out) {
    const prev = line.at(-1);
    if (prev && gaps.some(([a, b]) => prev.t <= a && p.t >= b)) { lines.push(line); line = []; }
    line.push(p);
  }
  if (line.length) lines.push(line);
  return lines;
}

function formatDate(startedAt) {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function buildSvg(recording, { title = 'WOBD recording' } = {}) {
  const panels = planPanels(recording);
  if (!panels.length) throw new Error('This recording has none of the gauges the graph shows.');
  const gaps = findGaps(recording.series);
  const totalMs = Math.max(recording.durationMs, 1);
  const plotW = W - PLOT.left - PLOT.right;
  const xOf = (t) => PLOT.left + (t / totalMs) * plotW;
  const height = HEADER + panels.length * (PLOT.height + PLOT.gap) - PLOT.gap + FOOTER;

  const subtitle = [
    formatDate(recording.startedAt) && `Recorded ${formatDate(recording.startedAt)}`,
    recording.protocol && recording.protocol !== 'unknown' && recording.protocol,
    recording.wobdVersion && `WOBD v${recording.wobdVersion}`,
  ].filter(Boolean).join('  ·  ');

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="DejaVu Sans, sans-serif">`);
  out.push(`<rect width="${W}" height="${height}" fill="#fff"/>`);
  out.push(`<text x="${W / 2}" y="30" text-anchor="middle" font-size="22" font-weight="bold" fill="#222">${esc(title)}</text>`);
  out.push(`<text x="${W / 2}" y="54" text-anchor="middle" font-size="13" fill="#666">${esc(subtitle)}</text>`);

  panels.forEach(({ panel, left, right }, index) => {
    const top = HEADER + index * (PLOT.height + PLOT.gap);
    const bottom = top + PLOT.height;
    const sides = [{ name: 'left', list: left, label: panel.leftLabel }, { name: 'right', list: right, label: panel.rightLabel }]
      .filter((s) => s.list.length);
    let colour = 0;

    out.push(`<text x="${W / 2}" y="${top - 36}" text-anchor="middle" font-size="16" fill="#222">${esc(panel.title)}</text>`);
    out.push(`<rect x="${PLOT.left}" y="${top}" width="${plotW}" height="${PLOT.height}" fill="#fff" stroke="#888"/>`);

    for (const [a, b] of gaps) {
      out.push(`<rect x="${xOf(a)}" y="${top}" width="${xOf(b) - xOf(a)}" height="${PLOT.height}" fill="#999" fill-opacity="0.16"/>`);
      if (index === 0 && xOf(b) - xOf(a) > 70) {
        out.push(`<text x="${(xOf(a) + xOf(b)) / 2}" y="${top + 22}" text-anchor="middle" font-size="13" fill="#555">Engine off</text>`);
      }
    }

    // X axis: minutes, grid lines shared by every panel.
    const minutes = niceTicks(0, totalMs / 60000, 8).filter((m) => m >= 0 && m <= totalMs / 60000);
    for (const m of minutes) {
      const x = xOf(m * 60000);
      out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="#ddd"/>`);
      out.push(`<line x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom + 4}" stroke="#555"/>`);
      out.push(`<text x="${x}" y="${bottom + 18}" text-anchor="middle" font-size="11" fill="#444">${fmt(m)}</text>`);
    }
    if (index === panels.length - 1) {
      out.push(`<text x="${PLOT.left + plotW / 2}" y="${bottom + 38}" text-anchor="middle" font-size="12" fill="#444">Minutes into recording</text>`);
    }

    const legend = [];
    for (const side of sides) {
      const values = side.list.flatMap((s) => s.values.filter(Number.isFinite));
      let lo = Math.min(...values);
      let hi = Math.max(...values);
      if (side.name === 'left' && panel.band) { lo = Math.min(lo, panel.band[0]); hi = Math.max(hi, panel.band[1]); }
      if (side.name === 'left' && panel.mid !== undefined) { lo = Math.min(lo, panel.mid); hi = Math.max(hi, panel.mid); }
      const pad = (hi - lo || 1) * 0.06;
      lo -= pad; hi += pad;
      const yOf = (v) => bottom - ((v - lo) / (hi - lo)) * PLOT.height;
      const anchorX = side.name === 'left' ? PLOT.left : PLOT.left + plotW;
      const dir = side.name === 'left' ? -1 : 1;

      if (side.name === 'left' && panel.band) {
        out.push(`<rect x="${PLOT.left}" y="${yOf(panel.band[1])}" width="${plotW}" height="${yOf(panel.band[0]) - yOf(panel.band[1])}" fill="#2ca02c" fill-opacity="0.09"/>`);
        out.push(`<line x1="${PLOT.left}" y1="${yOf(0)}" x2="${PLOT.left + plotW}" y2="${yOf(0)}" stroke="#222"/>`);
      }
      if (side.name === 'left' && panel.mid !== undefined) {
        out.push(`<line x1="${PLOT.left}" y1="${yOf(panel.mid)}" x2="${PLOT.left + plotW}" y2="${yOf(panel.mid)}" stroke="#222" stroke-dasharray="4 3" stroke-width="0.8"/>`);
      }
      for (const v of niceTicks(lo, hi, 5)) {
        if (side.name === 'left') out.push(`<line x1="${PLOT.left}" y1="${yOf(v)}" x2="${PLOT.left + plotW}" y2="${yOf(v)}" stroke="#e4e4e4"/>`);
        out.push(`<text x="${anchorX + dir * 8}" y="${yOf(v) + 4}" text-anchor="${side.name === 'left' ? 'end' : 'start'}" font-size="11" fill="#444">${fmt(v)}</text>`);
      }
      const labelX = anchorX + dir * 54;
      out.push(`<text transform="translate(${labelX} ${top + PLOT.height / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#444">${esc(side.label ?? '')}</text>`);

      for (const s of side.list) {
        const stroke = PALETTE[colour++ % PALETTE.length];
        const dashed = side.name === 'right' ? ' stroke-dasharray="6 3"' : '';
        for (const line of thin(s.times, s.values, xOf, gaps)) {
          if (line.length === 1) {
            out.push(`<circle cx="${xOf(line[0].t)}" cy="${yOf(line[0].v)}" r="1.6" fill="${stroke}"/>`);
            continue;
          }
          const d = line.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join('');
          out.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"${dashed}/>`);
        }
        legend.push({ stroke, dashed: side.name === 'right', text: `${s.def.label}${s.def.unit ? ` (${s.def.unit})` : ''}` });
      }
    }

    // Legend row between the panel title and the plot, centered.
    const widths = legend.map((item) => 34 + item.text.length * 6.6);
    let lx = (W - widths.reduce((a, b) => a + b + 14, -14)) / 2;
    legend.forEach((item, i) => {
      out.push(`<line x1="${lx}" y1="${top - 15}" x2="${lx + 24}" y2="${top - 15}" stroke="${item.stroke}" stroke-width="2.5"${item.dashed ? ' stroke-dasharray="6 3"' : ''}/>`);
      out.push(`<text x="${lx + 30}" y="${top - 11}" font-size="11" fill="#222">${esc(item.text)}</text>`);
      lx += widths[i] + 14;
    });
  });

  out.push('</svg>');
  return out.join('\n');
}

export async function renderPng(svg) {
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } });
  return resvg.render().asPng();
}

function titleFor(result) {
  const { year, make, model } = result.vehicle;
  return `${year} ${make} ${model} — WOBD recording`;
}

async function graphFromCsv(csvPath, title, outPath) {
  const recording = parseRecording(await readFile(resolve(root, csvPath), 'utf8'));
  await writeFile(resolve(root, outPath), await renderPng(buildSvg(recording, { title })));
  console.log(`${outPath}  (${recording.series.length} gauges, ${(recording.durationMs / 60000).toFixed(1)} min)`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

  if (args.includes('--all')) {
    const results = JSON.parse(await readFile(join(root, 'data/tested-adapters.json'), 'utf8'));
    for (const result of results) {
      const { csv, graph } = result.reports ?? {};
      if (csv && graph) await graphFromCsv(csv, titleFor(result), graph);
    }
    return;
  }

  const csv = args.find((a, i) => !a.startsWith('--') && !['--title', '--out'].includes(args[i - 1]));
  if (!csv) {
    console.error('Usage: node scripts/make-report-graph.mjs <recording.csv> [--title "…"] [--out graph.png]\n       node scripts/make-report-graph.mjs --all');
    process.exit(1);
  }
  const out = flag('--out') ?? join(dirname(csv), `${basename(csv, '.csv')}-graphs.png`);
  await graphFromCsv(csv, flag('--title') ?? 'WOBD recording', out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
