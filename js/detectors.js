// Finds patterns worth a second look in a recording. Deterministic and cautious: every event
// says what was measured and what it might mean, never what is broken. No DOM here, so
// scripts/test-detectors.mjs can check it in Node.
//
// Rules shared by every detector:
//  - only fresh samples count (a reading older than FRESH_MS at the moment it is compared is ignored);
//  - a recording gap alone never means anything but "no readings arrived";
//  - thresholds are fixed and conservative (fewer flags, fewer false alarms);
//  - nothing here changes the recording. An event only points at it.
import { formatNumber, t } from './i18n.js';
import { displayUnit, displayValue } from './units.js';

export const DETECTOR_VERSION = 1;
export const FRESH_MS = 3000;

export const T = {
  rpmWindowMs: 5000,
  rpmSwing: 1500,         // rpm change inside the window
  rpmMaxStep: 2500,       // a longer silence inside the window means the readings are stale
  rpmMinSamples: 3,
  rpmTrimmedSwing: 1000,  // the change must survive dropping the single highest and lowest reading (one-sample spikes)
  steadySpeedRange: 3,    // mph the speed may wander while it counts as steady
  steadySpeedMin: 10,     // below this, revving is ordinary (parked, creeping, launching)
  throttleRise: 15,       // points; a driver pressing the pedal explains an rpm rise
  mergeMs: 10000,         // events closer than this are one event
  loopDwellMs: 3000,      // a new loop state must hold this long to count
  loopFlapCount: 4,
  loopFlapWindowMs: 60000,
  stallPriorRpm: 400,     // rpm just before the drop, so a key-on at 0 rpm is not a stall
  stallStepMs: 2500,      // the readings either side of the drop must be this close
  stallHoldMs: 1000,      // zero must hold this long
  stallMinOthers: 2,      // other gauges still answering: the adapter and car are alive
  stallMovingMph: 5,
};

const seriesOf = (rec, key) => rec.series.find((s) => s.def.key === key);

// Index of the last reading at or before t, or -1.
function lastAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// The reading of `series` at time t, only if it is fresh. Otherwise null.
function fresh(series, t) {
  if (!series) return null;
  const i = lastAtOrBefore(series.times, t);
  return i >= 0 && t - series.times[i] <= FRESH_MS ? { t: series.times[i], value: series.values[i] } : null;
}

const sample = (key, t, value) => ({ key, t, value });

function merge(spans, gap) {
  const out = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s.from - last.to <= gap) {
      last.to = Math.max(last.to, s.to);
      for (const k of ['lo', 'sLo']) if (k in s) last[k] = Math.min(last[k], s[k]);
      for (const k of ['hi', 'sHi']) if (k in s) last[k] = Math.max(last[k], s[k]);
      last.evidence.push(...s.evidence);
    } else out.push({ ...s, evidence: [...s.evidence] });
  }
  return out;
}

const trim = (list, max = 8) => (list.length <= max ? list
  : [...list.slice(0, max / 2), ...list.slice(-max / 2)]);

const clock = (ms) => {
  const total = Math.floor(ms / 1000);
  const seconds = formatNumber(total % 60, { minimumIntegerDigits: 2, useGrouping: false });
  return `${formatNumber(Math.floor(total / 60))}:${seconds}`;
};
const rpm = (n) => formatNumber(Math.round(n));
const speedLabel = (n) => `${formatNumber(Math.round(displayValue(n, 'mph')))} ${displayUnit('mph')}`;
const speedRange = (lo, hi) => `${formatNumber(Math.round(displayValue(lo, 'mph')))}-${formatNumber(Math.round(displayValue(hi, 'mph')))} ${displayUnit('mph')}`;
const seconds = (n, digits = 0) => formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ---------- RPM change at steady speed ----------

export function detectRpmSwings(rec) {
  const r = seriesOf(rec, 'rpm');
  const sp = seriesOf(rec, 'speed');
  if (!r || !sp || r.times.length < T.rpmMinSamples) return [];
  const th = seriesOf(rec, 'throttle');
  const spans = [];
  let start = 0;
  for (let j = 0; j < r.times.length; j++) {
    const end = r.times[j];
    while (r.times[start] < end - T.rpmWindowMs) start++;
    if (j - start + 1 < T.rpmMinSamples) continue;
    let lo = Infinity;
    let hi = -Infinity;
    let stale = false;
    for (let k = start; k <= j; k++) {
      lo = Math.min(lo, r.values[k]);
      hi = Math.max(hi, r.values[k]);
      if (k > start && r.times[k] - r.times[k - 1] > T.rpmMaxStep) stale = true;
    }
    if (stale || hi - lo < T.rpmSwing) continue;
    const ordered = r.values.slice(start, j + 1).sort((x, y) => x - y);
    if (ordered.at(-2) - ordered[1] < T.rpmTrimmedSwing) continue;

    // Speed must be fresh at both ends of the window and stay near-constant inside it.
    const from = r.times[start];
    const a = fresh(sp, from);
    const b = fresh(sp, end);
    if (!a || !b) continue;
    let sLo = Math.min(a.value, b.value);
    let sHi = Math.max(a.value, b.value);
    for (let i = lastAtOrBefore(sp.times, from) + 1; i < sp.times.length && sp.times[i] <= end; i++) {
      sLo = Math.min(sLo, sp.values[i]);
      sHi = Math.max(sHi, sp.values[i]);
    }
    if (sHi - sLo > T.steadySpeedRange || sLo < T.steadySpeedMin) continue;

    // A driver pressing the pedal explains a rise, so only call it out when the throttle stayed put.
    const t0 = fresh(th, from);
    const t1 = fresh(th, end);
    if (t0 && t1 && Math.abs(t1.value - t0.value) >= T.throttleRise) continue;

    const evidence = [sample('rpm', r.times[start], r.values[start]), sample('rpm', end, r.values[j]),
      sample('speed', a.t, a.value), sample('speed', b.t, b.value)];
    if (t0 && t1) evidence.push(sample('throttle', t0.t, t0.value), sample('throttle', t1.t, t1.value));
    spans.push({ from, to: end, lo, hi, sLo, sHi, evidence });
  }
  return merge(spans, T.mergeMs).map((s) => {
    const { lo, hi } = s;
    return event('rpm-swing', 'notice', s.from, s.to, ['rpm', 'speed'], trim(s.evidence), {
      rpmChange: T.rpmSwing, windowMs: T.rpmWindowMs, steadySpeedMph: T.steadySpeedRange,
    }, t('replay.detectors.rpmTitle'),
    t('replay.detectors.rpmExplanation', { low: rpm(lo), high: rpm(hi), speedRange: speedRange(s.sLo, s.sHi), time: clock(s.from) }));
  });
}

// ---------- Open / closed loop ----------

function loopState(text) {
  if (typeof text !== 'string') return null;
  if (/fault/i.test(text)) return { id: text.startsWith('Closed') ? 'closed-fault' : 'open-fault', fault: true, text };
  if (text.startsWith('Closed')) return { id: 'closed', fault: false, text };
  if (/warming/i.test(text)) return { id: 'open-warmup', fault: false, text };
  if (text.startsWith('Open')) return { id: 'open-load', fault: false, text };
  return null;
}

export function detectLoopChanges(rec) {
  const s = seriesOf(rec, 'fuelsys');
  if (!s) return [];
  const states = [];
  let current = null;
  for (let i = 0; i < s.times.length; i++) {
    const st = loopState(s.values[i]);
    if (!st) continue;
    if (current && current.id === st.id) { current.to = s.times[i]; current.count++; continue; }
    current = { ...st, from: s.times[i], to: s.times[i], count: 1 };
    states.push(current);
  }
  // A state must last: enough time and at least two readings, except at the very end of the file.
  const lasting = states.filter((st, i) => (st.to - st.from >= T.loopDwellMs && st.count >= 2) || (i === states.length - 1 && st.count >= 2));
  const events = [];
  let previous = null;
  for (const st of lasting) {
    if (st.fault) {
      events.push(event('loop-fault', 'notice', st.from, st.to, ['fuelsys'], [sample('fuelsys', st.from, st.text)],
        { dwellMs: T.loopDwellMs }, t('replay.detectors.loopFaultTitle'),
        t('replay.detectors.loopFaultExplanation', { status: st.text, seconds: seconds((st.to - st.from) / 1000) })));
    } else if (previous && previous.id !== st.id && !previous.fault) {
      events.push(event('loop-change', 'info', st.from, st.from, ['fuelsys'],
        [sample('fuelsys', previous.to, previous.text), sample('fuelsys', st.from, st.text)], { dwellMs: T.loopDwellMs },
        t('replay.detectors.loopChangeTitle', { status: st.text }),
        t('replay.detectors.loopChangeExplanation', { previous: previous.text, status: st.text })));
    }
    previous = st;
  }
  // Flipping back and forth many times in a short span is worth noting once.
  const flips = events.filter((e) => e.detector === 'loop-change').map((e) => e.from);
  for (let i = 0; i + T.loopFlapCount - 1 < flips.length; i++) {
    const a = flips[i];
    const b = flips[i + T.loopFlapCount - 1];
    if (b - a <= T.loopFlapWindowMs) {
      events.push(event('loop-flapping', 'notice', a, b, ['fuelsys'], [sample('fuelsys', a, 'changes'), sample('fuelsys', b, 'changes')],
        { changes: T.loopFlapCount, windowMs: T.loopFlapWindowMs }, t('replay.detectors.loopFlappingTitle'),
        t('replay.detectors.loopFlappingExplanation', { count: T.loopFlapCount })));
      while (i + 1 < flips.length && flips[i + 1] - a <= T.loopFlapWindowMs) i++;
    }
  }
  return events;
}

// ---------- Communication loss ----------

export function detectCommLoss(rec) {
  return rec.gaps.map(({ from, to }) => event('comm-loss', 'notice', from, to, [], [sample('all', from, 'last reading'), sample('all', to, 'next reading')],
    { gapMs: rec.gapMs }, t('replay.detectors.commLossTitle'),
    t('replay.detectors.commLossExplanation', { from: clock(from), to: clock(to), seconds: seconds((to - from) / 1000) })));
}

// ---------- Suspected stall ----------

export function detectStalls(rec) {
  const r = seriesOf(rec, 'rpm');
  if (!r) return [];
  const sp = seriesOf(rec, 'speed');
  const events = [];
  for (let i = 1; i < r.times.length; i++) {
    if (r.values[i] !== 0 || r.values[i - 1] < T.stallPriorRpm) continue;
    if (r.times[i] - r.times[i - 1] > T.stallStepMs) continue;
    // Zero has to hold: the next RPM readings stay at 0 for stallHoldMs, with nothing stale between them.
    let end = i;
    let ok = false;
    for (let k = i + 1; k < r.times.length && r.values[k] === 0; k++) {
      if (r.times[k] - r.times[k - 1] > T.stallStepMs) break;
      end = k;
      if (r.times[k] - r.times[i] >= T.stallHoldMs) { ok = true; break; }
    }
    if (!ok) continue;
    // Ignition context: other gauges kept answering while RPM sat at 0.
    const from = r.times[i - 1];
    const to = r.times[end];
    const others = rec.series.filter((s) => s !== r && s.times.some((t) => t > r.times[i] && t <= to + FRESH_MS)).length;
    if (others < T.stallMinOthers) continue;
    const speed = fresh(sp, r.times[i]);
    const moving = speed && speed.value > T.stallMovingMph;
    const evidence = [sample('rpm', from, r.values[i - 1]), sample('rpm', r.times[i], 0), sample('rpm', to, 0)];
    if (speed) evidence.push(sample('speed', speed.t, speed.value));
    events.push(event('suspected-stall', 'notice', from, to, ['rpm'], evidence,
      { priorRpm: T.stallPriorRpm, holdMs: T.stallHoldMs, otherGauges: T.stallMinOthers }, t('replay.detectors.stallTitle'),
      t('replay.detectors.stallExplanation', { rpm: rpm(r.values[i - 1]), seconds: seconds((to - r.times[i]) / 1000, 1), movingText: moving ? t('replay.detectors.stallMoving', { speed: speedLabel(speed.value) }) : '' })));
    i = end;
  }
  return events;
}

// ---------- Assembly ----------

function event(detector, severity, from, to, keys, evidence, threshold, title, explanation) {
  return { id: `${detector}@${Math.round(from)}`, detector, version: DETECTOR_VERSION, severity, from, to, keys, evidence, threshold, title, explanation };
}

// Every event for a recording, in time order. Pure: the same recording always gives the same list.
export function detectEvents(rec) {
  return [...detectRpmSwings(rec), ...detectLoopChanges(rec), ...detectCommLoss(rec), ...detectStalls(rec)]
    .sort((a, b) => a.from - b.from || a.detector.localeCompare(b.detector));
}
