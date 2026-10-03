// Replay page: plays a WOBD live data recording back on the Live data gauges,
// with one small graph per reading that fills in up to the playhead.
// Files are read in the browser; nothing is uploaded.
import { renderGauges, updateGauge } from './ui.js';
import { baudLabel } from './conninfo.js';
import { MAX_FILE_BYTES, ReplayError, indexAt, parseRecording, valueAt } from './replay-data.js';

const SAMPLE = 'reports/vlinker-fs-usb-pt-cruiser-2026-10-02/wobd-recording-2026-10-02-192055.csv';
const STRIP_HEIGHT = 84;   // css px per graph
const AXIS_HEIGHT = 20;    // extra room under the last graph for the time labels
const PAD = { left: 44, right: 12, top: 8, bottom: 8 };

const $ = (id) => document.getElementById(id);

const state = {
  rec: null,
  t: 0,            // playhead, ms into the recording
  playing: false,
  lastFrame: 0,
  hoverT: null,
  strips: [],
};

// ---------- Formatting ----------

function clock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function spokenTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return m ? `${part(m, 'minute')} ${part(s, 'second')}` : part(s, 'second');
}

function formatValue(def, value) {
  if (value === null) return '—';
  if (typeof value !== 'number') return value;
  const text = value.toLocaleString(undefined, { minimumFractionDigits: def.digits, maximumFractionDigits: def.digits });
  return `${def.bipolar && value > 0 ? '+' : ''}${text}${def.unit ? ` ${def.unit}` : ''}`;
}

// ---------- Loading ----------

function showMessage(text, isError = false) {
  const message = $('replay-message');
  message.textContent = text;
  message.setAttribute('role', isError ? 'alert' : 'status');
  message.hidden = !text;
}

function load(text, sourceName) {
  try {
    show(parseRecording(text), sourceName);
    showMessage('');
  } catch (err) {
    if (!(err instanceof ReplayError)) console.error('[WOBD] Replay failed:', err);
    showMessage(err instanceof ReplayError ? err.message : "That file couldn't be read. Is it a CSV saved from WOBD?", true);
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    showMessage('That file is over 20 MB, which is bigger than any WOBD recording should be.', true);
    return;
  }
  showMessage(`Reading ${file.name}…`);
  load(await file.text(), file.name);
}

// Only recordings published in this site's reports folder can be opened by link.
async function loadUrl(path) {
  if (!/^reports\/[\w.-]+(\/[\w.-]+)*\.csv$/.test(path) || path.includes('..')) {
    showMessage("That link doesn't point to a recording on this site.", true);
    return;
  }
  showMessage('Loading the recording…');
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    load(await res.text(), path.split('/').pop());
  } catch (err) {
    console.error('[WOBD] Replay download failed:', err);
    showMessage("The recording couldn't be downloaded. Check your connection and try again.", true);
  }
}

// ---------- Showing a recording ----------

function show(rec, sourceName) {
  pause();
  state.rec = rec;
  state.t = 0;

  const started = rec.startedAt === null ? null : new Date(rec.startedAt).toLocaleString(undefined,
    { dateStyle: 'medium', timeStyle: 'short' });
  $('replay-summary').textContent = [
    sourceName,
    started && `Recorded ${started}`,
    `${clock(rec.durationMs)} long`,
    `${rec.readingCount.toLocaleString()} readings`,
    `${rec.protocol ?? 'Protocol unknown'} · ${baudLabel(rec.baudRate)}`,
  ].filter(Boolean).join(' · ');
  const unknown = $('replay-unknown');
  unknown.textContent = rec.unknownPids.length
    ? `Skipped readings WOBD doesn't have a gauge for: ${rec.unknownPids.join(', ')}.` : '';
  unknown.hidden = !rec.unknownPids.length;

  renderGauges(rec.series.map((s) => s.def));
  buildStrips(rec);

  const scrub = $('replay-scrub');
  scrub.max = String(rec.durationMs);
  $('replay-view').hidden = false;
  resizeStrips();
  render();
}

// ---------- Graphs ----------

// Round, readable tick steps (1, 2, 2.5, 5 × 10^n), about three per graph.
function niceScale(min, max, count = 3) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, ticks, step };
}

function buildStrips(rec) {
  const numeric = rec.series.filter((s) => s.def.style !== 'status');
  state.strips = numeric.map((series, i) => {
    let min = Math.min(...series.values);
    let max = Math.max(...series.values);
    if (series.def.bipolar) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const canvas = document.createElement('canvas');
    canvas.className = 'replay-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const strip = { series, canvas, scale: niceScale(min, max), isLast: i === numeric.length - 1 };
    canvas.addEventListener('pointermove', (e) => hover(strip, e));
    canvas.addEventListener('pointerleave', () => hover(null));
    canvas.addEventListener('click', (e) => seek(timeAtX(strip, e)));
    const { label, unit } = series.def;
    const title = document.createElement('h3');
    title.className = 'replay-strip-title';
    title.textContent = unit ? `${label} · ${unit}` : label;
    const wrap = document.createElement('div');
    wrap.className = 'replay-strip';
    wrap.append(title, canvas);
    strip.wrap = wrap;
    return strip;
  });
  $('replay-strips').replaceChildren(...state.strips.map((s) => s.wrap));
  $('replay-chart-summary').textContent = numeric.map(({ def, values }) =>
    `${def.label}: ${formatValue(def, Math.min(...values))} to ${formatValue(def, Math.max(...values))}.`).join(' ');
}

function resizeStrips() {
  const dpr = window.devicePixelRatio || 1;
  for (const strip of state.strips) {
    const width = strip.canvas.parentElement.clientWidth;
    const height = STRIP_HEIGHT + (strip.isLast ? AXIS_HEIGHT : 0);
    strip.canvas.style.height = `${height}px`;
    strip.canvas.width = Math.round(width * dpr);
    strip.canvas.height = Math.round(height * dpr);
    strip.size = { width, height, dpr };
  }
}

function plotWidth(strip) {
  return strip.size.width - PAD.left - PAD.right;
}

function xAt(strip, t) {
  return PAD.left + (state.rec.durationMs ? t / state.rec.durationMs : 0) * plotWidth(strip);
}

function timeAtX(strip, e) {
  const x = e.clientX - strip.canvas.getBoundingClientRect().left;
  const fraction = Math.min(1, Math.max(0, (x - PAD.left) / plotWidth(strip)));
  return fraction * state.rec.durationMs;
}

function colors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return { line: get('--chart-line'), grid: get('--chart-grid'), text: get('--muted'), surface: get('--surface'), ink: get('--text') };
}

function drawStrip(strip, c) {
  const { canvas, series, scale, size } = strip;
  if (!size) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  const plotBottom = STRIP_HEIGHT - PAD.bottom;
  const yAt = (v) => plotBottom - ((v - scale.lo) / (scale.hi - scale.lo)) * (plotBottom - PAD.top);
  const right = size.width - PAD.right;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;

  // Recessive hairline grid: value ticks across, a line each minute down.
  ctx.strokeStyle = c.grid;
  ctx.fillStyle = c.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const tickDigits = scale.step < 1 ? Math.min(2, Math.ceil(-Math.log10(scale.step))) : 0;
  for (const v of scale.ticks) {
    const y = Math.round(yAt(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillText(v.toLocaleString(undefined, { maximumFractionDigits: tickDigits, minimumFractionDigits: tickDigits }), PAD.left - 6, y);
  }
  const minuteStep = state.rec.durationMs > 20 * 60000 ? 5 * 60000 : 60000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= state.rec.durationMs; t += minuteStep) {
    const x = Math.round(xAt(strip, t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, plotBottom); ctx.stroke();
    if (strip.isLast) ctx.fillText(clock(t), x, plotBottom + 6);
  }

  // The reading so far: a 2px line up to the playhead, ending in a ringed dot.
  const last = indexAt(series, state.t);
  if (last >= 0) {
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= last; i++) {
      const x = xAt(strip, series.times[i]);
      const y = yAt(series.values[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const x = xAt(strip, series.times[last]);
    const y = yAt(series.values[last]);
    ctx.fillStyle = c.surface;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.line;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }

  // Hover crosshair, shared by every graph so they can be read together.
  if (state.hoverT !== null) {
    const x = Math.round(xAt(strip, state.hoverT)) + 0.5;
    ctx.strokeStyle = c.ink;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, plotBottom); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawStrips() {
  const c = colors();
  for (const strip of state.strips) drawStrip(strip, c);
}

function hover(strip, e) {
  const tooltip = $('replay-tooltip');
  if (!strip) {
    state.hoverT = null;
    tooltip.hidden = true;
    drawStrips();
    return;
  }
  state.hoverT = timeAtX(strip, e);
  const { def } = strip.series;
  tooltip.textContent = state.hoverT > state.t
    ? `${clock(state.hoverT)} · click to jump here`
    : `${clock(state.hoverT)} · ${def.label} ${formatValue(def, valueAt(strip.series, state.hoverT))}`;
  tooltip.hidden = false;
  // Keep the tooltip on screen: flip to the left of the pointer near the right edge.
  const flip = e.clientX > window.innerWidth - tooltip.offsetWidth - 24;
  tooltip.style.left = `${flip ? e.clientX - tooltip.offsetWidth - 12 : e.clientX + 12}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
  drawStrips();
}

// ---------- Playback ----------

function render() {
  const { rec, t } = state;
  for (const series of rec.series) updateGauge(series.def, valueAt(series, t));
  const scrub = $('replay-scrub');
  scrub.value = String(Math.round(t));
  scrub.setAttribute('aria-valuetext', spokenTime(t));
  $('replay-time').textContent = `${clock(t)} / ${clock(rec.durationMs)}`;
  drawStrips();
}

function seek(t) {
  if (!state.rec) return;
  state.t = Math.min(state.rec.durationMs, Math.max(0, t));
  render();
}

function frame(now) {
  if (!state.playing) return;
  state.t += (now - state.lastFrame) * Number($('replay-speed').value);
  state.lastFrame = now;
  if (state.t >= state.rec.durationMs) {
    state.t = state.rec.durationMs;
    pause();
  }
  render();
  if (state.playing) requestAnimationFrame(frame);
}

function play() {
  if (!state.rec || state.playing) return;
  if (state.t >= state.rec.durationMs) state.t = 0;  // at the end, Play starts over
  state.playing = true;
  state.lastFrame = performance.now();
  setPlayButton();
  requestAnimationFrame(frame);
}

function pause() {
  state.playing = false;
  setPlayButton();
}

function setPlayButton() {
  const button = $('replay-play');
  button.dataset.playing = state.playing;
  button.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
}

// ---------- Wiring ----------

$('replay-file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('replay-sample').addEventListener('click', () => loadUrl(SAMPLE));
$('replay-play').addEventListener('click', () => (state.playing ? pause() : play()));
$('replay-scrub').addEventListener('input', (e) => seek(Number(e.target.value)));

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

// Space plays and pauses, unless a control that uses Space has focus.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || !state.rec || e.target.closest('input, select, textarea, button, a')) return;
  e.preventDefault();
  if (state.playing) pause(); else play();
});

new ResizeObserver(() => {
  if (!state.rec) return;
  resizeStrips();
  drawStrips();
}).observe($('replay-strips'));
new MutationObserver(() => state.rec && drawStrips())
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

const linked = new URLSearchParams(location.search).get('csv');
if (linked) loadUrl(linked);
