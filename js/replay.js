import './i18n-boot.js';
// Replay page: plays a WOBD live data recording back on the Live data gauges,
// with one small graph per reading that fills in up to the playhead.
// Files are read in the browser; nothing is uploaded.
import { renderGauges, updateGauge } from './ui.js';
import { baudLabel } from './conninfo.js';
import { MAX_FILE_BYTES, ReplayError, indexAt, parseRecordingStream, valueAt } from './replay-data.js';
import {
  AnnotationError, MAX_NOTES, NOTE_TYPES, REVIEW_STATUSES, exportNotes, loadNotes, loadReviews, makeNote, mergeNotes, noteTitle,
  parseImport, reviewLabel, saveNotes, sortNotes,
} from './annotations.js';
import { detectEvents } from './detectors.js';
import { buildSessionReport, renderSessionReport } from './session-report.js';
import { analyzeCsv, CsvError } from './csv-lossless.js';
import { WobdError, readWobd, wobdToCsvBytes, writeWobd } from './wobd.js';
import { wobdVersion } from './version-info.js';
import { createDownsampleCache, extent, playedParts, prepareSeries } from './replay-downsample.js';
import { formatDate, formatNumber, formatTime, onLanguageChange, pidLabel, t } from './i18n.js';
import { displayDef, displayUnit, displayValue, onUnitsChange } from './units.js';

const SAMPLE = 'reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv';
const STRIP_HEIGHT = 84;   // css px per graph
const AXIS_HEIGHT = 20;    // extra room under the last graph for the time labels
const PAD = { left: 44, right: 12, top: 8, bottom: 8 };

const $ = (id) => document.getElementById(id);

// Holds each graph's downsampled drawing view until the recording or the graph width changes.
const downsampled = createDownsampleCache();

const state = {
  rec: null,
  t: 0,            // playhead, ms into the recording
  playing: false,
  lastFrame: 0,
  hoverT: null,
  strips: [],
  v0: 0,           // visible window, ms into the recording
  v1: 0,
  notes: [],
  events: [],
  reviews: {},
  showRoutine: false,
  reportSkip: new Set(),   // ids of notes left out of the session report
  name: '',
  source: null,    // the CSV file or bytes on screen, kept so it can be saved as .wobd
  saved: true,
};
const MIN_WINDOW_MS = 10000;

// ---------- Formatting ----------

function clock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = formatNumber(total % 60, { minimumIntegerDigits: 2, useGrouping: false });
  const min = formatNumber(m, { minimumIntegerDigits: 2, useGrouping: false });
  return h ? `${formatNumber(h)}:${min}:${s}` : `${formatNumber(m)}:${s}`;
}

function spokenTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const minute = { count: m, formattedCount: formatNumber(m) };
  const second = { count: s, formattedCount: formatNumber(s) };
  return m ? `${t('replay.time.minute', minute)} ${t('replay.time.second', second)}` : t('replay.time.second', second);
}

function displayPidDef(def) { return { ...displayDef(def), label: pidLabel(def) }; }

function displaySeries(series) {
  return { ...series, def: displayPidDef(series.def), values: series.values.map((v) => displayValue(v, series.def.unit)) };
}

function formatValue(def, value) {
  if (value === null) return '—';
  if (typeof value !== 'number') return value;
  const shown = displayDef(def);
  const converted = displayValue(value, def.unit);
  const text = formatNumber(converted, { minimumFractionDigits: shown.digits, maximumFractionDigits: shown.digits });
  return `${def.bipolar && value > 0 ? '+' : ''}${text}${shown.unit ? ` ${displayUnit(shown.unit)}` : ''}`;
}

// ---------- Loading ----------

function showMessage(text, isError = false) {
  const message = $('replay-message');
  message.textContent = text;
  message.setAttribute('role', isError ? 'alert' : 'status');
  message.hidden = !text;
}

function load(rec, sourceName, source = null) {
  show(rec, sourceName);
  state.source = source;
  renderConvert();
  showMessage('');
}

function fail(err) {
  if (!(err instanceof ReplayError) && !(err instanceof WobdError)) console.error('[WOBD] Replay failed:', err);
  const known = err instanceof ReplayError || err instanceof WobdError;
  showMessage(known ? err.message : t('replay.load.fileUnreadable'), true);
}

const isArchive = (bytes) => bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    showMessage(t('replay.load.fileTooLarge', { size: formatNumber(MAX_FILE_BYTES / 1024 / 1024) }), true);
    return;
  }
  showMessage(t('replay.load.readingFile', { name: file.name }));
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (isArchive(head)) { await loadArchive(file); return; }
    load(await parseRecordingStream(file.stream()), file.name, file);
  } catch (err) {
    fail(err);
  }
}

async function loadArchive(file) {
  const result = await readWobd(new Uint8Array(await file.arrayBuffer()));
  const csv = wobdToCsvBytes(result);
  const rec = await parseRecordingStream(new Blob([csv]).stream());
  load(rec, file.name.replace(/\.wobd$/i, '.csv'), new Blob([csv]));
  const notes = [];
  if (result.annotations) notes.push(applyEmbeddedNotes(result.annotations));
  if (result.partial) notes.push(t('replay.load.partialRecording'));
  if (result.problems.length) notes.push(t('replay.load.archiveProblems', { problems: result.problems.join(' ') }));
  notes.push(...result.warnings);
  if (notes.filter(Boolean).length) showMessage(notes.filter(Boolean).join(' '));
}

// Notes saved inside a .wobd file belong to its own recording, so they are added without asking.
function applyEmbeddedNotes(text) {
  try {
    const imported = parseImport(text, state.rec.fingerprint);
    state.notes = mergeNotes(state.notes, imported.notes, state.rec.durationMs);
    state.reviews = { ...imported.reviews, ...state.reviews };
    persistNotes();
    return '';
  } catch (err) {
    if (err instanceof AnnotationError) return t('replay.load.embeddedNotesInvalid', { error: err.message });
    throw err;
  }
}

// Only recordings published in this site's reports folder can be opened by link.
async function loadUrl(path) {
  if (!/^reports\/[\w.-]+(\/[\w.-]+)*\.csv$/.test(path) || path.includes('..')) {
    showMessage(t('replay.load.invalidLink'), true);
    return;
  }
  showMessage(t('replay.load.loadingRecording'));
  let res;
  try {
    res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('[WOBD] Replay download failed:', err);
    showMessage(t('replay.load.downloadFailed'), true);
    return;
  }
  try {
    const bytes = new Uint8Array(await res.arrayBuffer());
    load(await parseRecordingStream(new Blob([bytes]).stream()), path.split('/').pop(), new Blob([bytes]));
  } catch (err) {
    fail(err);
  }
}

// ---------- Showing a recording ----------

function show(rec, sourceName) {
  pause();
  state.rec = rec;
  state.name = sourceName;
  state.notes = loadNotes(localStorage, rec.fingerprint);
  state.reviews = loadReviews(localStorage, rec.fingerprint);
  state.events = detectEvents(rec);
  state.saved = true;
  state.reportSkip = new Set();
  state.t = 0;
  state.v0 = 0;
  state.v1 = rec.durationMs;

  renderSummary();

  renderGauges(rec.series.map((s) => displayPidDef(s.def)));
  buildStrips(rec);
  buildTimeline(rec);
  buildAges(rec);
  renderNotes();
  renderEvents();

  const scrub = $('replay-scrub');
  scrub.max = String(rec.durationMs);
  $('replay-view').hidden = false;
  resizeStrips();
  render();
}

function renderSummary() {
  const rec = state.rec;
  const sourceName = state.name;
  const started = rec.startedAt === null ? null : localTime(rec.startedAt, false);
  $('replay-summary').textContent = [
    sourceName,
    started ? t('replay.load.recorded', { date: started, zoneNote: rec.timeInfo.zone === 'assumed-local' ? t('replay.load.assumedLocal') : '' }) : t('replay.load.noDate'),
    t('replay.load.duration', { duration: clock(rec.durationMs) }),
    t('replay.load.readingCount', { count: formatNumber(rec.readingCount) }),
    `${rec.protocol ?? t('replay.load.protocolUnknown')} · ${baudLabel(rec.baudRate)}`,
    rec.wobdVersion && `WOBD v${rec.wobdVersion}`,
  ].filter(Boolean).join(' · ');
  const unknown = $('replay-unknown');
  unknown.textContent = rec.unknownPids.length
    ? t('replay.load.unknownPids', { pids: rec.unknownPids.join(', ') }) : '';
  unknown.hidden = !rec.unknownPids.length;
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
  state.strips = numeric.map((recorded, i) => {
    const series = displaySeries(recorded);
    let { min, max } = extent(series.values);
    if (series.def.bipolar) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const canvas = document.createElement('canvas');
    canvas.className = 'replay-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const strip = { series, prep: prepareSeries(series), canvas, scale: niceScale(min, max), isLast: i === numeric.length - 1 };
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
  $('replay-chart-summary').textContent = numeric.map(({ def, values }) => {
    const shown = displaySeries({ def, values });
    const { min, max } = extent(shown.values);
    return t('replay.graph.range', { label: shown.def.label, min: formatValue(shown.def, min), max: formatValue(shown.def, max) });
  }).join(' ');
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
  const span = state.v1 - state.v0;
  return PAD.left + (span ? (t - state.v0) / span : 0) * plotWidth(strip);
}

function timeAtX(strip, e) {
  const x = e.clientX - strip.canvas.getBoundingClientRect().left;
  const fraction = Math.min(1, Math.max(0, (x - PAD.left) / plotWidth(strip)));
  return state.v0 + fraction * (state.v1 - state.v0);
}

function colors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return { event: get('--event-mark') || '#8b5cf6', note: get('--note-mark') || '#d98e04', line: get('--chart-line'), grid: get('--chart-grid'), text: get('--muted'), surface: get('--surface'), ink: get('--text') };
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
    ctx.fillText(formatNumber(v, { maximumFractionDigits: tickDigits, minimumFractionDigits: tickDigits }), PAD.left - 6, y);
  }
  const span = state.v1 - state.v0;
  const gridStep = [1000, 5000, 10000, 30000, 60000, 5 * 60000, 15 * 60000].find((s) => span / s <= 12) ?? 30 * 60000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(state.v0 / gridStep) * gridStep; t <= state.v1; t += gridStep) {
    const x = Math.round(xAt(strip, t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, plotBottom); ctx.stroke();
    if (strip.isLast) ctx.fillText(clock(t), x, plotBottom + 6);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, 0, plotWidth(strip), size.height);
  ctx.clip();

  // Connection gaps: no PID answered. Says nothing about why (engine, ignition, adapter).
  ctx.fillStyle = c.grid;
  ctx.globalAlpha = 0.5;
  for (const { from, to } of state.rec.gaps) {
    if (to < state.v0 || from > state.v1) continue;
    const x0 = Math.max(PAD.left, xAt(strip, from));
    const x1 = Math.min(right, xAt(strip, to));
    ctx.fillRect(x0, PAD.top, Math.max(1, x1 - x0), plotBottom - PAD.top);
  }
  ctx.globalAlpha = 1;

  // The reading so far, up to the playhead: a 2px line through the downsampled view (every
  // pixel keeps its first, lowest, highest and last reading), ending in a ringed dot at the
  // exact reading. No line crosses a visual gap; that is only a pause in the readings.
  const last = indexAt(series, state.t);
  if (last >= 0) {
    const opts = { t0: state.v0, t1: state.v1, buckets: Math.max(1, Math.floor(plotWidth(strip))) };
    const parts = playedParts(strip.prep, downsampled.get(strip.prep, opts), state.t, opts);
    const bands = [];
    const dots = [];
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let px = 0;
    let py = 0;
    let open = false;
    let length = 0;
    for (const { view, count } of parts) {
      for (let k = 0; k < count; k++) {
        const x = xAt(strip, view.times[k]);
        const y = yAt(view.values[k]);
        if (open && view.gapBefore[k]) bands.push([px, x]);
        if (!open || view.gapBefore[k]) {
          if (open && length === 1) dots.push([px, py]);
          ctx.moveTo(x, y);
          length = 1;
          open = true;
        } else {
          ctx.lineTo(x, y);
          length++;
        }
        px = x;
        py = y;
      }
    }
    if (open && length === 1) dots.push([px, py]);
    ctx.fillStyle = c.grid;
    for (const [from, to] of bands) ctx.fillRect(from, PAD.top, Math.max(1, to - from), plotBottom - PAD.top);
    ctx.stroke();
    ctx.fillStyle = c.line;
    for (const [x, y] of dots) { ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
    const x = xAt(strip, series.times[last]);
    const y = yAt(series.values[last]);
    ctx.fillStyle = c.surface;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.line;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }

  // Detected patterns, as a faint band along the top of the graph (dismissed ones are not drawn).
  ctx.fillStyle = c.event;
  for (const ev of visibleEvents()) {
    if (ev.to < state.v0 || ev.from > state.v1) continue;
    const x0 = Math.max(PAD.left, xAt(strip, ev.from));
    const x1 = Math.min(right, xAt(strip, ev.to));
    ctx.fillRect(x0, PAD.top, Math.max(2, x1 - x0), 4);
  }

  // Your notes, as amber ticks across every graph.
  ctx.strokeStyle = c.note;
  ctx.lineWidth = 2;
  for (const n of state.notes) {
    if (n.t < state.v0 || n.t > state.v1) continue;
    const x = Math.round(xAt(strip, n.t));
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, plotBottom); ctx.stroke();
  }
  ctx.restore();

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
    ? t('replay.graph.hoverFuture', { time: clock(state.hoverT) })
    : t('replay.graph.hoverValue', { time: clock(state.hoverT), label: def.label, value: formatValue(def, valueAt(strip.series, state.hoverT)) });
  tooltip.hidden = false;
  // Keep the tooltip on screen: flip to the left of the pointer near the right edge.
  const flip = e.clientX > window.innerWidth - tooltip.offsetWidth - 24;
  tooltip.style.left = `${flip ? e.clientX - tooltip.offsetWidth - 12 : e.clientX + 12}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
  drawStrips();
}

// ---------- Time, timeline, quality ----------

// The recorded UTC (or zone-stamped) instant shown in this device's own time zone.
function wallClock(elapsedMs) {
  const { rec } = state;
  if (rec.startedAt === null) return t('replay.time.notRecorded');
  return localTime(rec.startedAt + elapsedMs, true);
}

// Explicit fields rather than dateStyle/timeStyle, which can't be combined with a zone name everywhere.
function localTime(ms, seconds) {
  return formatDate(ms, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(seconds && { second: '2-digit' }), timeZoneName: 'short' });
}

function qualityIssue(kind) {
  return ({
    missingTimestamps: t('replay.quality.missingTimestamps'), malformedTimestamps: t('replay.quality.malformedTimestamps'),
    duplicateRows: t('replay.quality.duplicateRows'), outOfOrderRows: t('replay.quality.outOfOrderRows'), clockJumps: t('replay.quality.clockJumps'),
  })[kind];
}

function buildTimeline(rec) {
  const dur = rec.durationMs;
  const gaps = $('replay-gaps');
  gaps.textContent = rec.gaps.length
    ? t('replay.timeline.gap', { count: rec.gaps.length, ranges: rec.gaps.slice(0, 8).map((g) => `${clock(g.from)} ${t('replay.time.to')} ${clock(g.to)}`).join(', ') + (rec.gaps.length > 8 ? ', …' : '') })
    : '';
  gaps.hidden = !rec.gaps.length;

  const overview = $('replay-overview');
  const pct = (t) => `${dur ? (t / dur) * 100 : 0}%`;
  const bands = rec.gaps.map(({ from, to }) => {
    const band = document.createElement('span');
    band.className = 'replay-overview-gap';
    band.style.left = pct(from);
    band.style.width = `${dur ? Math.max(0.3, ((to - from) / dur) * 100) : 0}%`;
    return band;
  });
  const win = document.createElement('span');
  win.className = 'replay-overview-window';
  const head = document.createElement('span');
  head.className = 'replay-overview-head';
  overview.replaceChildren(...bands, win, head);
  overview.onclick = (e) => {
    const box = overview.getBoundingClientRect();
    const mid = ((e.clientX - box.left) / box.width) * dur;
    const span = state.v1 - state.v0;
    setWindow(mid - span / 2, mid + span / 2);
  };

  const q = rec.quality;
  const items = [
    [q.missingTimestamps, 'missingTimestamps'], [q.malformedTimestamps, 'malformedTimestamps'],
    [q.duplicateRows, 'duplicateRows'], [q.outOfOrderRows, 'outOfOrderRows'], [q.clockJumps, 'clockJumps'],
  ].filter(([n]) => n > 0).map(([n, kind]) => t('replay.quality.rowIssue', { count: n, formattedCount: formatNumber(n), issue: qualityIssue(kind), first: formatNumber(q.firstProblem[kind]) }));
  if (rec.timeInfo.source === 'elapsed') items.unshift(t('replay.quality.elapsedOnly'));
  if (rec.timeInfo.zone === 'assumed-local') items.push(t('replay.quality.assumedLocal'));
  $('replay-quality-summary').textContent = items.length ? t('replay.quality.summaryIssues', { count: items.length, formattedCount: formatNumber(items.length) }) : t('replay.quality.summaryClean');
  $('replay-quality-list').replaceChildren(...(items.length ? items : [t('replay.quality.everyRow')]).map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  $('replay-quality').open = items.length > 0;
  syncWindow();
}

function setWindow(v0, v1) {
  const dur = state.rec.durationMs;
  const span = Math.min(dur, Math.max(Math.min(MIN_WINDOW_MS, dur), v1 - v0));
  state.v0 = Math.min(dur - span, Math.max(0, v0));
  state.v1 = state.v0 + span;
  syncWindow();
  drawStrips();
}

function zoom(factor) {
  const mid = state.playing || state.t >= state.v0 && state.t <= state.v1 ? state.t : (state.v0 + state.v1) / 2;
  const span = (state.v1 - state.v0) * factor;
  setWindow(mid - span / 2, mid + span / 2);
}

function syncWindow() {
  const { rec, v0, v1 } = state;
  const dur = rec.durationMs;
  const span = v1 - v0;
  const pan = $('replay-pan');
  pan.max = String(Math.max(0, Math.round(dur - span)));
  pan.value = String(Math.round(v0));
  pan.disabled = span >= dur;
  pan.setAttribute('aria-valuetext', t('replay.timeline.showingRange', { from: clock(v0), to: clock(v1) }));
  $('replay-window-label').textContent = span >= dur ? t('replay.timeline.showingWhole') : t('replay.timeline.showingRange', { from: clock(v0), to: clock(v1) });
  $('zoom-in').disabled = span <= Math.min(MIN_WINDOW_MS, dur);
  $('zoom-out').disabled = span >= dur;
  $('zoom-reset').disabled = span >= dur;
  const win = $('replay-overview').querySelector('.replay-overview-window');
  if (win) {
    win.style.left = `${dur ? (v0 / dur) * 100 : 0}%`;
    win.style.width = `${dur ? (span / dur) * 100 : 100}%`;
  }
}

// While playing or scrubbing, keep the playhead in view.
function followPlayhead() {
  const { t, v0, v1 } = state;
  const head = $('replay-overview').querySelector('.replay-overview-head');
  if (head) head.style.left = `${state.rec.durationMs ? (t / state.rec.durationMs) * 100 : 0}%`;
  if (v1 - v0 >= state.rec.durationMs || (t >= v0 && t <= v1)) return;
  const span = v1 - v0;
  const start = t < v0 ? t : t - span * 0.9;
  state.v0 = Math.max(0, Math.min(state.rec.durationMs - span, start));
  state.v1 = state.v0 + span;
  syncWindow();
}

// How long before the playhead each reading last arrived.
function buildAges(rec) {
  state.ageCells = rec.series.map((s) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const at = document.createElement('td');
    const age = document.createElement('td');
    name.textContent = pidLabel(s.def);
    row.append(name, at, age);
    return { series: s, row, at, age };
  });
  $('replay-ages').replaceChildren(...state.ageCells.map((c) => c.row));
}

function updateAges() {
  for (const { series, at, age } of state.ageCells) {
    const i = indexAt(series, state.t);
    if (i === -1) { at.textContent = '—'; age.textContent = t('replay.ages.notYet'); continue; }
    const sample = series.times[i];
    at.textContent = clock(sample);
    const seconds = (state.t - sample) / 1000;
    age.textContent = seconds < 10 ? `${formatNumber(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : `${formatNumber(Math.round(seconds))} s`;
  }
}

// ---------- Save as .wobd ----------

function renderConvert() {
  $('wobd-report').hidden = true;
  $('wobd-message').hidden = true;
  $('wobd-source').checked = true;
}

function convertMessage(text, isError = false) {
  const el = $('wobd-message');
  el.textContent = text;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = !text;
}

function reportLines(report, exact, includedSource) {
  const lines = [
    `${t('replay.wobd.rowsRead', { count: formatNumber(report.records), readings: formatNumber(report.telemetry) })}`,
    `${t('replay.wobd.rowsExact', { count: formatNumber(report.exact) })}`,
  ];
  if (report.normalized) lines.push(`${t('replay.wobd.rowsNormalized', { count: formatNumber(report.normalized) })}`);
  if (report.malformed) lines.push(`${t('replay.wobd.rowsMalformed', { count: formatNumber(report.malformed) })}`);
  if (report.unknownPids.length) lines.push(t('replay.wobd.unknownParameters', { pids: `${report.unknownPids.slice(0, 8).join(', ')}${report.unknownPids.length > 8 ? ', …' : ''}` }));
  if (report.duplicates) lines.push(`${t('replay.wobd.rowsDuplicate', { count: formatNumber(report.duplicates) })}`);
  if (report.outOfOrder) lines.push(`${t('replay.wobd.rowsOutOfOrder', { count: formatNumber(report.outOfOrder) })}`);
  lines.push(includedSource
    ? t('replay.wobd.sourceIncluded')
    : exact ? t('replay.wobd.sourceExcludedExact') : '');
  return lines.filter(Boolean);
}

async function saveAsWobd() {
  if (!state.rec || !state.source) return;
  const button = $('wobd-save');
  button.disabled = true;
  convertMessage(t('replay.wobd.converting'));
  try {
    const bytes = new Uint8Array(await state.source.arrayBuffer());
    const { model, report, exact } = analyzeCsv(bytes);
    let keep = $('wobd-source').checked;
    if (!keep && !exact) {
      keep = true;
      $('wobd-source').checked = true;
      convertMessage(t('replay.wobd.sourceRequired'));
    }
    const withNotes = state.notes.length || Object.keys(state.reviews).length;
    const archive = await writeWobd(model, {
      version: wobdVersion(),
      recordedWith: /^# WOBD v([\d.]+)/.exec(model.preamble[0] ?? '')?.[1] ?? null,
      source: keep ? bytes : null,
      annotations: withNotes ? exportNotes(state.rec.fingerprint, state.name, state.notes, state.reviews) : null,
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([archive], { type: 'application/vnd.wobd.session+zip' }));
    link.download = `${state.name.replace(/\.csv$/i, '')}.wobd`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    const list = $('wobd-report-list');
    list.replaceChildren(...reportLines(report, exact, keep).map((text) => Object.assign(document.createElement('li'), { textContent: text })));
    $('wobd-report').hidden = false;
    $('wobd-report').open = true;
    if (!$('wobd-message').hidden && $('wobd-message').textContent === t('replay.wobd.converting')) convertMessage(t('replay.wobd.saved', { name: link.download, size: formatNumber(archive.length / 1024, { maximumFractionDigits: 0 }) }));
  } catch (err) {
    if (!(err instanceof CsvError || err instanceof WobdError)) console.error('[WOBD] Save as .wobd failed:', err);
    convertMessage(err instanceof CsvError || err instanceof WobdError ? err.message : t('replay.wobd.saveFailed'), true);
  } finally {
    button.disabled = false;
  }
}

$('wobd-save').addEventListener('click', saveAsWobd);
$('wobd-source').addEventListener('change', (e) => {
  if (e.target.checked) return;
  if (!confirm(t('replay.wobd.confirmExcludeSource'))) e.target.checked = true;
});

// ---------- Detected patterns ----------

const isShown = (ev) => state.showRoutine || ev.severity !== 'info';
const visibleEvents = () => state.events.filter((ev) => isShown(ev) && state.reviews[ev.id] !== 'dismissed');

function setReview(id, status) {
  if (status) state.reviews[id] = status; else delete state.reviews[id];
  persistNotes();
  renderEvents();
}

function evidenceText(ev) {
  const rows = ev.evidence.map((e) => {
    const def = state.rec.series.find((series) => series.def.key === e.key)?.def;
    const value = typeof e.value === 'number' ? formatNumber(def ? displayValue(e.value, def.unit) : e.value, { maximumFractionDigits: 2 }) : e.value;
    const label = def ? pidLabel(def) : t('replay.events.allGauges');
    const unit = def?.unit ? ` ${displayUnit(def.unit)}` : '';
    return `${clock(e.t)} · ${label}: ${value}${unit}`;
  });
  const rules = Object.entries(ev.threshold).map(([k, v]) => {
    const label = ({
      rpmChange: t('replay.events.threshold.rpmChange'), windowMs: t('replay.events.threshold.windowMs'), steadySpeedMph: t('replay.events.threshold.steadySpeedMph'),
      dwellMs: t('replay.events.threshold.dwellMs'), changes: t('replay.events.threshold.changes'),
      gapMs: t('replay.events.threshold.gapMs'), priorRpm: t('replay.events.threshold.priorRpm'), holdMs: t('replay.events.threshold.holdMs'), otherGauges: t('replay.events.threshold.otherGauges'),
    })[k] ?? k;
    const shown = k === 'steadySpeedMph' ? `${formatNumber(displayValue(v, 'mph'))} ${displayUnit('mph')}` : formatNumber(v);
    return `${label} ${shown}`;
  }).join(', ');
  return t('replay.events.evidence', { detector: ev.detector, version: ev.version, rules, readings: rows.join('; ') });
}

function renderEvents() {
  const list = $('event-list');
  const shown = state.events.filter(isShown);
  list.replaceChildren(...shown.map((ev) => {
    const status = state.reviews[ev.id];
    const li = document.createElement('li');
    li.className = `event-item${status === 'dismissed' ? ' is-dismissed' : ''}`;
    const head = document.createElement('div');
    head.className = 'event-head';
    const title = document.createElement('strong');
    title.textContent = ev.title;
    const when = document.createElement('span');
    when.className = 'event-when';
    when.textContent = ev.to > ev.from ? t('replay.time.range', { from: clock(ev.from), to: clock(ev.to) }) : clock(ev.from);
    head.append(title, when);
    if (ev.severity === 'info') head.append(Object.assign(document.createElement('span'), { className: 'event-tag', textContent: t('replay.events.routine') }));
    if (status) head.append(Object.assign(document.createElement('span'), { className: 'event-tag', textContent: reviewLabel(status) }));
    const text = document.createElement('p');
    text.textContent = ev.explanation;
    const details = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = t('replay.events.whyFlagged');
    const why = document.createElement('p');
    why.className = 'event-evidence';
    why.textContent = evidenceText(ev);
    details.append(sum, why);
    const actions = document.createElement('div');
    actions.className = 'event-actions';
    const jump = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('replay.events.jump') });
    jump.addEventListener('click', () => { pause(); seek(ev.from); centerOn(ev.from); });
    const select = document.createElement('select');
    select.setAttribute('aria-label', t('replay.events.reviewAria', { title: ev.title, time: spokenTime(ev.from) }));
    select.append(new Option(t('replay.events.reviewPrompt'), ''), ...REVIEW_STATUSES.map((s) => new Option(s.label, s.id)));
    select.value = status ?? '';
    select.addEventListener('change', () => setReview(ev.id, select.value));
    actions.append(jump, select);
    li.append(head, text, details, actions);
    return li;
  }));
  const hidden = state.events.length - shown.length;
  const empty = $('event-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = state.events.length === 0
    ? t('replay.events.noneFound')
    : t('replay.events.onlyRoutine', { count: hidden ? ` (${formatNumber(hidden)})` : '' });
  drawStrips();
}

$('event-routine').addEventListener('change', (e) => { state.showRoutine = e.target.checked; renderEvents(); });

// ---------- Session report ----------

function printSessionReport() {
  const message = $('sr-message');
  const include = new Set(state.notes.filter((n) => !state.reportSkip.has(n.id)).map((n) => n.id));
  const model = buildSessionReport(state.rec, { events: state.events, reviews: state.reviews, notes: state.notes, includeNotes: include, vehicle: $('sr-vehicle').value });
  renderSessionReport($('session-report'), state.rec, model, { version: window.WOBD_VERSION });
  message.hidden = true;
  window.print();
}

$('sr-print').addEventListener('click', printSessionReport);

// ---------- Notes ----------

function noteMessage(text, isError = false) {
  const el = $('note-message');
  el.textContent = text;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = !text;
}

function persistNotes() {
  state.saved = saveNotes(localStorage, state.rec.fingerprint, state.name, state.notes, state.reviews);
  renderNotes();
}

function renderNotes() {
  const list = $('note-list');
  state.notes = sortNotes(state.notes);
  list.replaceChildren(...state.notes.map((n) => {
    const li = document.createElement('li');
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'note-jump';
    jump.textContent = `${clock(n.t)} · ${noteTitle(n)}${n.comment ? ` · ${n.comment}` : ''}`;
    jump.title = t('replay.notes.jumpTitle');
    jump.addEventListener('click', () => { pause(); seek(n.t); centerOn(n.t); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn note-delete';
    del.textContent = t('replay.notes.delete');
    del.setAttribute('aria-label', t('replay.notes.deleteAria', { time: spokenTime(n.t) }));
    del.addEventListener('click', () => {
      state.notes = state.notes.filter((x) => x.id !== n.id);
      persistNotes();
    });
    const inReport = document.createElement('label');
    inReport.className = 'note-in-report';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !state.reportSkip.has(n.id) });
    box.addEventListener('change', () => { if (box.checked) state.reportSkip.delete(n.id); else state.reportSkip.add(n.id); });
    inReport.append(box, ` ${t('replay.notes.inReport')}`);
    li.append(jump, inReport, del);
    return li;
  }));
  $('note-empty').hidden = state.notes.length > 0;
  $('note-export').disabled = state.notes.length === 0 && !Object.keys(state.reviews).length;
  $('note-storage').textContent = state.notes.length || Object.keys(state.reviews).length
    ? (state.saved ? t('replay.notes.savedLocal') : t('replay.notes.saveFailed'))
    : '';
  const overview = $('replay-overview');
  overview.querySelectorAll('.replay-overview-note').forEach((el) => el.remove());
  for (const n of state.notes) {
    const tick = document.createElement('span');
    tick.className = 'replay-overview-note';
    tick.style.left = `${state.rec.durationMs ? (n.t / state.rec.durationMs) * 100 : 0}%`;
    overview.append(tick);
  }
  drawStrips();
}

function centerOn(t) {
  const span = state.v1 - state.v0;
  if (t < state.v0 || t > state.v1) setWindow(t - span / 2, t + span / 2);
}

function refreshNoteTypeOptions() {
  const select = $('note-type');
  const selected = select.value;
  select.replaceChildren(...NOTE_TYPES.map((type) => new Option(type.label, type.id)));
  if (NOTE_TYPES.some((type) => type.id === selected)) select.value = selected;
}

function initNotes() {
  const select = $('note-type');
  refreshNoteTypeOptions();
  select.addEventListener('change', () => { $('note-label-wrap').hidden = select.value !== 'custom'; });
  $('note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.rec) return;
    if (state.notes.length >= MAX_NOTES) { noteMessage(t('replay.notes.maximum', { count: formatNumber(MAX_NOTES) }), true); return; }
    try {
      state.notes.push(makeNote({ t: state.t, type: select.value, label: $('note-label').value, comment: $('note-comment').value }, state.rec.durationMs));
    } catch (err) {
      if (!(err instanceof AnnotationError)) throw err;
      noteMessage(err.message, true);
      return;
    }
    noteMessage('');
    $('note-comment').value = '';
    $('note-label').value = '';
    persistNotes();
  });
  $('note-export').addEventListener('click', () => {
    const blob = new Blob([exportNotes(state.rec.fingerprint, state.name, state.notes, state.reviews)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${state.name.replace(/\.csv$/i, '')}-notes.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  $('note-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state.rec) return;
    try {
      const imported = parseImport(await file.text(), state.rec.fingerprint);
      if (!imported.matches && !confirm(t('replay.notes.confirmDifferentRecording', { name: imported.name ? ` (${imported.name})` : '' }))) return;
      const before = state.notes.length;
      state.notes = mergeNotes(state.notes, imported.notes, state.rec.durationMs);
      state.reviews = { ...imported.reviews, ...state.reviews };
      persistNotes();
      noteMessage(t('replay.notes.added', { count: state.notes.length - before, formattedCount: formatNumber(state.notes.length - before) }));
    } catch (err) {
      if (!(err instanceof AnnotationError)) throw err;
      noteMessage(err.message, true);
    }
  });
}
initNotes();

// ---------- Playback ----------

function render() {
  const { rec, t: playhead } = state;
  for (const series of rec.series) {
    const def = displayPidDef(series.def);
    const value = valueAt(series, playhead);
    updateGauge(def, displayValue(value, series.def.unit));
  }
  const scrub = $('replay-scrub');
  scrub.value = String(Math.round(playhead));
  scrub.setAttribute('aria-valuetext', spokenTime(playhead));
  $('replay-time').textContent = t('replay.time.playhead', { current: clock(playhead), duration: clock(rec.durationMs) });
  $('replay-clock').textContent = wallClock(playhead);
  $('note-at').textContent = clock(playhead);
  followPlayhead();
  updateAges();
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
  button.setAttribute('aria-label', state.playing ? t('replay.play.pause') : t('replay.play.play'));
}

// ---------- Wiring ----------

$('replay-file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('replay-sample').addEventListener('click', () => loadUrl(SAMPLE));
$('replay-play').addEventListener('click', () => (state.playing ? pause() : play()));
$('replay-scrub').addEventListener('input', (e) => seek(Number(e.target.value)));
$('zoom-in').addEventListener('click', () => zoom(0.5));
$('zoom-out').addEventListener('click', () => zoom(2));
$('zoom-reset').addEventListener('click', () => setWindow(0, state.rec.durationMs));
$('replay-pan').addEventListener('input', (e) => {
  const span = state.v1 - state.v0;
  setWindow(Number(e.target.value), Number(e.target.value) + span);
});

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


function refreshReplayDisplay() {
  if (!state.rec) return;
  state.events = detectEvents(state.rec);
  state.hoverT = null;
  $('replay-tooltip').hidden = true;
  renderSummary();
  refreshNoteTypeOptions();
  renderGauges(state.rec.series.map((series) => displayPidDef(series.def)));
  buildStrips(state.rec);
  buildTimeline(state.rec);
  buildAges(state.rec);
  renderNotes();
  renderEvents();
  resizeStrips();
  setPlayButton();
  render();
}

onLanguageChange(refreshReplayDisplay);
onUnitsChange(refreshReplayDisplay);

const linked = new URLSearchParams(location.search).get('csv');
if (linked) loadUrl(linked);
