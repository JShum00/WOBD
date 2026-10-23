// Printable session report built from a Replay recording. buildSessionReport() is pure, so
// scripts/test-session-report.mjs can check it in Node; renderSessionReport() makes the DOM
// that print.css shows. Nothing here changes the recording, and the VIN is never read.
import { prepareSeries, downsample } from './replay-downsample.js';
import { T, FRESH_MS, DETECTOR_VERSION } from './detectors.js';
import { reviewLabel, noteTitle, sortNotes } from './annotations.js';
import { formatDate, formatNumber, formatTime, pidLabel, t } from './i18n.js';
import { displayDef, displayUnit, displayValue } from './units.js';

export const MAX_DETAIL_EVENTS = 40;   // every event is indexed; only this many get a detail section
export const CONTEXT_MS = 30000;       // length of an event's context chart, centred on the event
export const MIN_CONTEXT_MS = 10000;

const isNumeric = (series) => series.values.length > 0 && series.values.every((v) => typeof v === 'number' && Number.isFinite(v));

// Elapsed time as m:ss or h:mm:ss.
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = formatNumber(total % 60, { minimumIntegerDigits: 2, useGrouping: false });
  const min = formatNumber(m, { minimumIntegerDigits: 2, useGrouping: false });
  return h ? `${formatNumber(h)}:${min}:${s}` : `${formatNumber(m)}:${s}`;
}

// Min, max, and plain average of the readings. The average is of readings, not of time,
// because WOBD polls some gauges more often than others. Categorical gauges get no stats.
export function seriesStats(series) {
  const { times, values } = series;
  if (!isNumeric(series)) return null;
  const def = displayDef(series.def);
  const shownValues = values.map((value) => displayValue(value, series.def.unit));
  let minI = 0;
  let maxI = 0;
  let sum = 0;
  for (let i = 0; i < shownValues.length; i++) {
    if (shownValues[i] < shownValues[minI]) minI = i;
    if (shownValues[i] > shownValues[maxI]) maxI = i;
    sum += shownValues[i];
  }
  return {
    key: series.def.key, label: pidLabel(series.def), unit: displayUnit(def.unit ?? ''), digits: def.digits ?? 0,
    count: values.length, min: shownValues[minI], tMin: times[minI], max: shownValues[maxI], tMax: times[maxI], mean: sum / shownValues.length,
  };
}

// The facts and numbers the report prints. includeNotes is a Set of note ids, or null for all.
export function buildSessionReport(rec, { events = [], reviews = {}, notes = [], includeNotes = null, vehicle = '' } = {}) {
  const gapTotal = rec.gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const stats = [];
  const skipped = [];
  for (const series of rec.series) {
    const s = seriesStats(series);
    if (s) stats.push(s); else skipped.push(pidLabel(series.def));
  }
  // A gauge can go quiet while others keep answering (ignition off, a module not replying); its line breaks.
  const quietGauges = rec.series.filter((series) => {
    const { times, gapMs } = prepareSeries(series);
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > gapMs) return true;
    return false;
  }).map((series) => pidLabel(series.def));
  const eventRows = events.map((ev) => ({ ...ev, review: reviews[ev.id] ?? null }));
  const kept = sortNotes(notes).filter((n) => !includeNotes || includeNotes.has(n.id));
  return {
    vehicle: String(vehicle ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80),
    startedAt: rec.startedAt,
    zone: rec.timeInfo?.zone ?? null,
    durationMs: rec.durationMs,
    gapMs: gapTotal,
    connectedMs: Math.max(0, rec.durationMs - gapTotal),
    gaps: rec.gaps,
    readingCount: rec.readingCount,
    protocol: rec.protocol,
    baudRate: rec.baudRate,
    wobdVersion: rec.wobdVersion,
    quality: rec.quality,
    unknownPids: rec.unknownPids,
    stats,
    skipped,
    quietGauges,
    events: eventRows,
    detailEvents: eventRows.slice(0, MAX_DETAIL_EVENTS),
    notes: kept,
    notesLeftOut: notes.length - kept.length,
  };
}

// The time span of an event's context chart: CONTEXT_MS wide, centred on the event, never
// narrower than the event itself, and clamped to the recording.
export function contextWindow(ev, durationMs) {
  const mid = (ev.from + ev.to) / 2;
  const span = Math.max(CONTEXT_MS, ev.to - ev.from + 2 * MIN_CONTEXT_MS);
  let t0 = mid - span / 2;
  let t1 = mid + span / 2;
  if (t0 < 0) { t1 = Math.min(durationMs, t1 - t0); t0 = 0; }
  if (t1 > durationMs) { t0 = Math.max(0, t0 - (t1 - durationMs)); t1 = durationMs; }
  return { t0, t1: Math.max(t1, t0 + 1) };
}

// ---------- Charts ----------

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Math.round(n * 10) / 10).toString();

// An SVG line chart of one numeric series between t0 and t1. Gaps break the line and are shaded;
// bands (annotated intervals) are shaded; markers are vertical ticks with a short label.
export function chartSvg(inputSeries, { t0, t1, gaps = [], bands = [], markers = [], showExtremes = true, width = 640, height = 110 } = {}) {
  const series = displaySeries(inputSeries);
  const pad = { left: 46, right: 8, top: 8, bottom: 16 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const prep = prepareSeries(series);
  const from = lowerBound(prep.times, t0);
  const to = lowerBound(prep.times, t1 + 1);
  const view = downsample(prep, { t0, t1, buckets: Math.max(50, Math.floor(w)), from, to });
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of view.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = (t) => pad.left + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * w;
  const y = (v) => pad.top + h - ((v - lo) / (hi - lo)) * h;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('replay.report.chartAria', { label: series.def.label }))}">`];
  parts.push(`<rect x="${pad.left}" y="${pad.top}" width="${w}" height="${h}" fill="none" stroke="#999" stroke-width="0.5"/>`);
  for (const g of gaps) {
    if (g.to < t0 || g.from > t1) continue;
    parts.push(`<rect x="${num(x(g.from))}" y="${pad.top}" width="${num(Math.max(1, x(g.to) - x(g.from)))}" height="${h}" fill="#bbb" fill-opacity="0.45"/>`);
  }
  for (const b of bands) {
    if (b.to < t0 || b.from > t1) continue;
    parts.push(`<rect x="${num(x(b.from))}" y="${pad.top}" width="${num(Math.max(2, x(b.to) - x(b.from)))}" height="${h}" fill="#e8a33d" fill-opacity="0.3"/>`);
  }
  let d = '';
  view.times.forEach((t, i) => { d += `${i === 0 || view.gapBefore[i] ? 'M' : 'L'}${num(x(t))} ${num(y(view.values[i]))}`; });
  if (d) parts.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`);
  for (const m of markers) {
    if (m.t < t0 || m.t > t1) continue;
    parts.push(`<line x1="${num(x(m.t))}" x2="${num(x(m.t))}" y1="${pad.top}" y2="${pad.top + h}" stroke="#c0392b" stroke-width="1" stroke-dasharray="3 2"/>`);
    if (m.label) parts.push(`<text x="${num(x(m.t) + 2)}" y="${pad.top + 8}" font-size="7" fill="#c0392b">${esc(m.label)}</text>`);
  }
  if (showExtremes && view.values.length) {
    let minI = 0;
    let maxI = 0;
    view.values.forEach((v, i) => { if (v < view.values[minI]) minI = i; if (v > view.values[maxI]) maxI = i; });
    const extremeLabels = { max: t('replay.report.maximum'), min: t('replay.report.minimum') };
    for (const [i, name] of [[maxI, 'max'], [minI, 'min']]) {
      parts.push(`<circle cx="${num(x(view.times[i]))}" cy="${num(y(view.values[i]))}" r="2.5" fill="#fff" stroke="#000" stroke-width="1"><title>${extremeLabels[name]}</title></circle>`);
    }
  }
  parts.push(`<text x="${pad.left - 4}" y="${pad.top + 4}" font-size="8" text-anchor="end">${esc(fmt(hi, series.def))}</text>`);
  parts.push(`<text x="${pad.left - 4}" y="${pad.top + h}" font-size="8" text-anchor="end">${esc(fmt(lo, series.def))}</text>`);
  parts.push(`<text x="${pad.left}" y="${height - 3}" font-size="8">${esc(clock(t0))}</text>`);
  parts.push(`<text x="${pad.left + w}" y="${height - 3}" font-size="8" text-anchor="end">${esc(clock(t1))}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function fmt(value, def) {
  const digits = def?.digits ?? 0;
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function displaySeries(series) {
  return { ...series, def: { ...displayDef(series.def), label: pidLabel(series.def) }, values: series.values.map((value) => displayValue(value, series.def.unit)) };
}

// ---------- DOM ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function wallTime(startedAt, t) {
  return startedAt === null ? '' : formatTime(startedAt + t, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

const when = (model, t) => `${clock(t)}${model.startedAt === null ? '' : ` (${wallTime(model.startedAt, t)})`}`;

const severityLabel = (severity) => ({ info: t('replay.events.severityRoutine'), notice: t('replay.events.severityNotice') })[severity] ?? severity;
const qualityLabel = (kind) => ({ missingTimestamps: t('replay.report.qualityMissing'), malformedTimestamps: t('replay.report.qualityMalformed'), duplicateRows: t('replay.report.qualityDuplicate'), outOfOrderRows: t('replay.report.qualityOutOfOrder'), clockJumps: t('replay.report.qualityClockJumps') })[kind] ?? kind;

function table(headers, rows) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { scope: 'col', textContent: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { textContent: c }))))));
}

// Fills `root` with the whole report. `version` is the WOBD version that made it.
export function renderSessionReport(root, rec, model, { version, now = new Date() } = {}) {
  root.replaceChildren();
  const bands = model.events.filter((e) => e.to > e.from && e.review !== 'dismissed' && e.detector !== 'comm-loss').map((e) => ({ from: e.from, to: e.to }));
  const noteMarks = model.notes.map((n) => ({ t: n.t, label: noteTitle(n).slice(0, 14) }));
  root.lang = document.documentElement.lang;
  const started = model.startedAt === null ? t('replay.load.noDate') : formatDate(model.startedAt);

  root.append(el('div', { className: 'sr-foot', textContent: t('replay.report.footer', { vehicle: model.vehicle ? ` · ${model.vehicle}` : '' }) }));

  root.append(el('header', { className: 'report-header' },
    el('div', {}, el('h1', { className: 'report-logo' }, 'WOBD', el('small', { textContent: t('replay.report.subtitle') }))),
    el('p', { className: 'report-meta' }, t('replay.report.made', { date: formatDate(now.getTime()) }), el('br'), version ? `WOBD v${version}` : '')));

  root.append(el('p', { className: 'sr-disclaimer', textContent: t('replay.report.disclaimer') }));

  const rows = [
    [t('replay.report.vehicle'), model.vehicle || t('replay.report.vehicleNotEntered')],
    [t('replay.report.recorded'), started + (model.zone === 'assumed-local' ? t('replay.load.assumedLocal') : '')],
    [t('replay.report.length'), clock(model.durationMs)],
    [t('replay.report.readingsReceived'), formatNumber(model.readingCount)],
    [t('replay.report.gaps'), model.gaps.length ? t('replay.report.gapCount', { count: model.gaps.length, formattedCount: formatNumber(model.gaps.length), gapTime: clock(model.gapMs), connectedTime: clock(model.connectedMs) }) : t('replay.report.noneFound')],
    [t('replay.report.protocol'), model.protocol ?? t('replay.report.unknown')],
    [t('replay.report.recordedWith'), model.wobdVersion ? `WOBD v${model.wobdVersion}` : t('replay.report.versionNotRecorded')],
    [t('replay.report.locationData'), t('replay.report.notIncluded')],
  ];
  if (model.unknownPids.length) rows.push([t('replay.report.notDecoded'), t('replay.report.noGaugeFor', { pids: model.unknownPids.join(', ') })]);
  root.append(el('h2', { textContent: t('replay.report.overview') }), el('dl', { className: 'sr-facts' }, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])));
  const q = model.quality;
  const problems = q ? Object.entries(q).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${qualityLabel(k)}: ${formatNumber(n)}`) : [];
  if (model.quietGauges.length) root.append(el('p', { className: 'sr-note', textContent: t('replay.report.quietGauges', { labels: model.quietGauges.join(', ') }) }));
  if (problems.length) root.append(el('p', { className: 'sr-note', textContent: t('replay.report.timestampProblems', { problems: problems.join(', ') }) }));

  root.append(el('h2', { className: 'sr-break', textContent: t('replay.report.readingsSummary') }));
  if (model.stats.length) {
    root.append(table([t('replay.report.reading'), t('replay.report.samples'), t('replay.report.lowest'), t('replay.report.at'), t('replay.report.highest'), t('replay.report.at'), t('replay.report.average')], model.stats.map((s) => [
      s.label, formatNumber(s.count), fmt(s.min, s) + (s.unit ? ` ${s.unit}` : ''), when(model, s.tMin), fmt(s.max, s) + (s.unit ? ` ${s.unit}` : ''), when(model, s.tMax), fmt(s.mean, s),
    ])));
  } else root.append(el('p', { textContent: t('replay.report.noNumericReadings') }));
  if (model.skipped.length) root.append(el('p', { className: 'sr-note', textContent: t('replay.report.statesNotSummarized', { labels: model.skipped.join(', ') }) }));
  root.append(el('p', { className: 'sr-note', textContent: t('replay.report.averageMethod') }));

  root.append(el('h2', { className: 'sr-break', textContent: t('replay.report.graphs') }));
  root.append(el('p', { className: 'sr-note', textContent: t('replay.report.graphExplanation') }));
  for (const series of rec.series) {
    if (!isNumeric(series)) continue;
    const shown = displaySeries(series);
    const fig = el('figure', { className: 'sr-figure' }, el('figcaption', { textContent: `${shown.def.label}${shown.def.unit ? ` (${shown.def.unit})` : ''}` }));
    fig.insertAdjacentHTML('beforeend', chartSvg(series, { t0: 0, t1: rec.durationMs, gaps: rec.gaps, bands, markers: noteMarks }));
    root.append(fig);
  }

  root.append(el('h2', { className: 'sr-break', textContent: t('replay.report.detectedPatterns') }));
  if (!model.events.length) {
    root.append(el('p', { textContent: t('replay.events.noneFound') }));
  } else {
    root.append(el('p', { className: 'sr-note', textContent: t('replay.report.allPatternsListed') }));
    root.append(table(['#', t('replay.report.when'), t('replay.report.pattern'), t('replay.report.level'), t('replay.report.yourReview')], model.events.map((ev, i) => [
      formatNumber(i + 1), ev.to > ev.from ? t('replay.time.range', { from: when(model, ev.from), to: clock(ev.to) }) : when(model, ev.from), ev.title, severityLabel(ev.severity), ev.review ? reviewLabel(ev.review) : '—',
    ])));
    model.detailEvents.forEach((ev, i) => {
      const sec = el('section', { className: 'sr-event' },
        el('h3', { textContent: `${formatNumber(i + 1)}. ${ev.title}${ev.review ? ` (${reviewLabel(ev.review)})` : ''}` }),
        el('p', { className: 'sr-note', textContent: `${ev.to > ev.from ? t('replay.time.range', { from: when(model, ev.from), to: clock(ev.to) }) : when(model, ev.from)} · ${severityLabel(ev.severity)} · detector ${ev.detector} v${ev.version}` }),
        el('p', { textContent: ev.explanation }),
        el('p', { className: 'sr-note', textContent: t('replay.report.readingsUsed', { readings: ev.evidence.map((e) => { const def = rec.series.find((item) => item.def.key === e.key)?.def; const value = typeof e.value === 'number' ? formatNumber(def ? displayValue(e.value, def.unit) : e.value, { maximumFractionDigits: 2 }) : e.value; const label = def ? pidLabel(def) : t('replay.report.allGauges'); const unit = def?.unit ? ` ${displayUnit(def.unit)}` : ''; return `${clock(e.t)} ${label} ${value}${unit}`; }).join('; ') }) }));
      const { t0, t1 } = contextWindow(ev, model.durationMs);
      for (const key of ev.keys) {
        const series = rec.series.find((s) => s.def.key === key);
        if (!series || !isNumeric(series)) continue;
        const shown = displaySeries(series);
        const fig = el('figure', { className: 'sr-figure' }, el('figcaption', { textContent: t('replay.report.chartContext', { label: shown.def.label, from: clock(t0), to: clock(t1) }) }));
        fig.insertAdjacentHTML('beforeend', chartSvg(series, { t0, t1, gaps: rec.gaps, bands: [{ from: ev.from, to: ev.to }], markers: [{ t: ev.from }], showExtremes: false, height: 90 }));
        sec.append(fig);
      }
      root.append(sec);
    });
    if (model.events.length > model.detailEvents.length) {
      root.append(el('p', { className: 'sr-note', textContent: t('replay.report.detailLimit', { shown: formatNumber(model.detailEvents.length), total: formatNumber(model.events.length) }) }));
    }
  }

  root.append(el('h2', { className: 'sr-break', textContent: t('replay.report.yourNotes') }));
  if (model.notes.length) {
    root.append(table([t('replay.report.when'), t('replay.report.note'), t('replay.report.comment')], model.notes.map((n) => [when(model, n.t), noteTitle(n), n.comment || ''])));
  } else root.append(el('p', { textContent: t('replay.report.noNotes') }));
  if (model.notesLeftOut) root.append(el('p', { className: 'sr-note', textContent: t('replay.report.notesLeftOut', { count: model.notesLeftOut, formattedCount: formatNumber(model.notesLeftOut) }) }));

  root.append(el('h2', { className: 'sr-break', textContent: t('replay.report.methods') }), el('ul', { className: 'sr-method' },
    el('li', { textContent: t('replay.report.methodDetectors', { version: DETECTOR_VERSION, fresh: formatNumber(FRESH_MS / 1000), rpmSwing: formatNumber(T.rpmSwing), rpmWindow: formatNumber(T.rpmWindowMs / 1000), speedMin: formatNumber(displayValue(T.steadySpeedMin, 'mph')), speedUnit: displayUnit('mph'), loopDwell: formatNumber(T.loopDwellMs / 1000), stallRpm: formatNumber(T.stallPriorRpm), stallHold: formatNumber(T.stallHoldMs / 1000) }) }),
    el('li', { textContent: t('replay.report.methodGap', { seconds: formatNumber(rec.gapMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) }),
    el('li', { textContent: t('replay.report.methodSampling') }),
    el('li', { textContent: t('replay.report.methodGraphs') }),
    el('li', { textContent: t('replay.report.methodExclusions') })));
}
