// Reads a WOBD live data recording (the CSV js/recorder.js writes) back into
// per-PID time series for the replay page. No DOM here, so
// scripts/test-replay.mjs can check it in Node.
import { LIVE_PIDS, BATTERY, DERIVED_PIDS } from './obd.js';
import { parseVersionLine } from './version-info.js';
import { gapThreshold } from './replay-downsample.js';
import { t } from './i18n.js';

export const MAX_FILE_BYTES = 128 * 1024 * 1024;
const REQUIRED = ['timestamp', 'elapsed_ms', 'pid', 'name', 'value', 'unit'];

// A wall clock that steps back or drifts from elapsed time by more than this is reported
// as a possible clock change rather than trusted.
export const CLOCK_JUMP_MS = 5000;
const HAS_ZONE = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i;

export class ReplayError extends Error {}

// Incremental RFC 4180 reader: commas and newlines inside quotes, "" for a quote,
// \r\n or \n or \r line ends. push() takes text in any chunking, and a quote pair or
// \r\n split across two chunks reads the same as in one piece. onRow gets each finished row.
export class CsvStreamParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.row = [];
    this.field = '';
    this.quoted = false;
    this.pendingQuote = false;   // saw a " inside quotes; the next char decides if it closes
    this.skipLf = false;         // the last row ended on \r, so swallow a following \n
  }

  push(text) {
    let { field, quoted, pendingQuote, skipLf } = this;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (skipLf) {
        skipLf = false;
        if (c === '\n') continue;
      }
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') { field += '"'; continue; }
          quoted = false;
        } else {
          if (c === '"') pendingQuote = true; else field += c;
          continue;
        }
      }
      if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        this.row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        skipLf = c === '\r';
        this.row.push(field);
        const row = this.row;
        this.row = [];
        field = '';
        this.onRow(row);
      } else {
        field += c;
      }
    }
    Object.assign(this, { field, quoted, pendingQuote, skipLf });
  }

  end() {
    this.quoted = false;
    this.pendingQuote = false;
    if (this.field !== '' || this.row.length) {
      const row = [...this.row, this.field];
      this.row = [];
      this.field = '';
      this.onRow(row);
    }
  }
}

export function parseCsv(text) {
  const rows = [];
  const parser = new CsvStreamParser((row) => rows.push(row));
  parser.push(text);
  parser.end();
  return rows;
}

// "0x0D" -> the Speed definition, "ATRV" -> Battery. Unknown PIDs return undefined.
export function defFor(pid) {
  if (pid === 'ATRV') return BATTERY;
  const match = /^0x([0-9A-F]{2})(?:\.(\d))?$/i.exec(pid);
  if (!match) return undefined;
  const number = parseInt(match[1], 16);
  const part = match[2] ? Number(match[2]) : undefined;
  return part === undefined
    ? LIVE_PIDS.find((def) => def.pid === number)
    : DERIVED_PIDS.find((def) => def.pid === number && def.part === part);
}

// Hex data bytes -> a value, or undefined when this decoder doesn't fit them.
function decodeRaw(def, hex) {
  if (!def.decode || !/^([0-9A-F]{2})+$/i.test(hex) || hex.length !== def.expectedBytes * 2) return undefined;
  const bytes = hex.match(/../g).map((pair) => parseInt(pair, 16));
  const value = def.decode(bytes);
  return typeof value === 'number' && !Number.isFinite(value) ? undefined : value;
}

// Turns CSV rows into the recording as they arrive, so a file never has to be held
// whole. Rows with only blank cells are skipped; the first other row is the header.
class RecordingBuilder {
  constructor() {
    this.col = null;
    this.byPid = new Map();
    this.unknownPids = new Set();
    this.protocol = null;
    this.baudRate = null;
    this.startedAt = null;
    this.readingCount = 0;
    this.wobdVersion = null;
    this.rowNumber = 0;
    this.prevElapsed = null;
    this.prevAt = null;
    this.stamped = 0;
    this.unzoned = 0;
    this.quality = {
      missingTimestamps: 0, malformedTimestamps: 0, duplicateRows: 0, outOfOrderRows: 0,
      clockJumps: 0, firstProblem: {},
    };
  }

  #flag(kind) {
    this.quality[kind]++;
    this.quality.firstProblem[kind] ??= this.rowNumber;
  }

  // Data-quality checks only; no row is ever changed or dropped because of them.
  #checkTime(row, elapsed, series) {
    const { col } = this;
    const text = (row[col.timestamp] ?? '').trim();
    if (series && series.times.length > 1 && series.times.at(-2) === elapsed) this.#flag('duplicateRows');
    if (this.prevElapsed !== null && elapsed < this.prevElapsed) this.#flag('outOfOrderRows');
    this.prevElapsed = elapsed;
    if (!text) { this.#flag('missingTimestamps'); return; }
    const at = Date.parse(text);
    if (!Number.isFinite(at)) { this.#flag('malformedTimestamps'); return; }
    this.stamped++;
    if (!HAS_ZONE.test(text)) this.unzoned++;
    if (this.startedAt === null) this.startedAt = at - elapsed;
    else if (Math.abs(at - elapsed - this.startedAt) > CLOCK_JUMP_MS || (this.prevAt !== null && at < this.prevAt - CLOCK_JUMP_MS)) this.#flag('clockJumps');
    this.prevAt = at;
  }

  addRow(row) {
    if (!row.some((cell) => cell.trim())) return;
    // A "# WOBD v1.71" line before the header says which WOBD wrote the file.
    if (!this.col && row[0].trim().startsWith('#')) {
      this.wobdVersion ??= parseVersionLine(row[0]);
      return;
    }
    if (!this.col) {
      this.col = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      if (!REQUIRED.every((name) => name in this.col)) {
        throw new ReplayError(t('replay.load.notWobdCsv'));
      }
      return;
    }
    const { col } = this;
    this.rowNumber++;
    const before = this.readingCount;
    const elapsed = Number(row[col.elapsed_ms]);
    const def = defFor(row[col.pid]);
    if (!def) {
      if (row[col.pid]) this.unknownPids.add(row[col.pid]);
      return;
    }
    const text = row[col.value];
    if (!Number.isFinite(elapsed)) return;
    if (text !== undefined && text !== '') {
      const value = def.style === 'status' ? text : Number(text);
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      this.#reading(def, elapsed, value);
    } else if ('raw' in col && row[col.raw]) {
      // Nothing was decoded when this was recorded (no decoder then, or an odd reply):
      // decode from the saved bytes with today's decoders, including any second values.
      for (const target of [def, ...DERIVED_PIDS.filter((extra) => extra.pid === def.pid && !def.part)]) {
        const value = decodeRaw(target, row[col.raw]);
        if (value !== undefined) this.#reading(target, elapsed, value);
      }
    } else {
      return;
    }

    if (this.readingCount > before) this.#checkTime(row, elapsed, this.byPid.get(def));
    if (this.protocol === null && 'protocol' in col && row[col.protocol] && row[col.protocol] !== 'unknown') this.protocol = row[col.protocol];
    const baud = 'baud' in col ? Number(row[col.baud]) : NaN;
    if (this.baudRate === null && Number.isInteger(baud) && baud > 0) this.baudRate = baud;
  }

  #reading(def, elapsed, value) {
    if (!this.byPid.has(def)) this.byPid.set(def, { def, times: [], values: [] });
    const series = this.byPid.get(def);
    series.times.push(elapsed);
    series.values.push(value);
    this.readingCount++;
  }

  finish() {
    if (!this.col) {
      throw new ReplayError(t('replay.load.notWobdCsv'));
    }
    if (!this.readingCount) throw new ReplayError(t('replay.load.noReadings'));

    let durationMs = 0;
    for (const series of this.byPid.values()) {
      // Rows are written in time order, but sort anyway in case a file was edited.
      const { times, values } = series;
      let sorted = true;
      for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) { sorted = false; break; }
      if (!sorted) {
        const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
        series.times = order.map((i) => times[i]);
        series.values = order.map((i) => values[i]);
      }
      durationMs = Math.max(durationMs, series.times.at(-1));
    }

    // A connection gap is a stretch where no reading of any PID arrived.
    const all = new Float64Array(this.readingCount);
    let n = 0;
    for (const { times } of this.byPid.values()) for (const t of times) all[n++] = t;
    all.sort();
    const limit = gapThreshold(all);
    const gaps = [];
    for (let i = 1; i < all.length; i++) if (all[i] - all[i - 1] > limit) gaps.push({ from: all[i - 1], to: all[i] });

    // Identifies this recording's content (not its file name) so notes only attach to the same data.
    let hash = 2166136261;
    const mix = (n) => { hash = Math.imul(hash ^ (n | 0), 16777619) >>> 0; };
    for (const { def, times, values } of this.byPid.values()) {
      for (const ch of String(def.pid ?? def.key)) mix(ch.charCodeAt(0));
      for (let i = 0; i < times.length; i++) {
        mix(times[i]);
        const v = values[i];
        mix(typeof v === 'number' ? Math.round(v * 1000) : String(v).length);
      }
    }
    const fingerprint = { readings: this.readingCount, durationMs, startedAt: this.startedAt, hash: hash.toString(16).padStart(8, '0') };

    const timeInfo = this.stamped === 0
      ? { source: 'elapsed', zone: null }
      : { source: 'recorded', zone: this.unzoned === 0 ? 'explicit' : 'assumed-local' };

    const gaugeOrder = [...LIVE_PIDS, ...DERIVED_PIDS, BATTERY];
    const series = [...this.byPid.values()].sort((a, b) => gaugeOrder.indexOf(a.def) - gaugeOrder.indexOf(b.def));
    return {
      startedAt: this.startedAt, durationMs, readingCount: this.readingCount,
      protocol: this.protocol, baudRate: this.baudRate, wobdVersion: this.wobdVersion, series, unknownPids: [...this.unknownPids],
      gaps, gapMs: limit, quality: this.quality, timeInfo, fingerprint,
    };
  }
}

// Returns { startedAt, durationMs, readingCount, protocol, baudRate, wobdVersion, series, unknownPids, gaps, gapMs, quality, timeInfo }.
// startedAt is null when no row has a usable timestamp (elapsed time only); a wall clock is never invented.
// gaps are [{ from, to }] in elapsed ms where no PID answered; quality counts timestamp problems and never alters rows.
// wobdVersion is null for files from before v1.71.
// series is in Live data gauge order; each entry is { def, times, values } sorted by time.
export function parseRecording(text) {
  const builder = new RecordingBuilder();
  const parser = new CsvStreamParser((row) => builder.addRow(row));
  parser.push(text.replace(/^\uFEFF/, ''));
  parser.end();
  return builder.finish();
}

// Same result as parseRecording, read from a ReadableStream of bytes (file.stream(),
// response.body) or of strings. Only one chunk of text is held at a time.
export async function parseRecordingStream(stream) {
  const builder = new RecordingBuilder();
  const parser = new CsvStreamParser((row) => builder.addRow(row));
  const decoder = new TextDecoder('utf-8');   // drops a leading BOM
  const reader = stream.getReader();
  let first = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      if (first && text) {
        first = false;
        if (typeof value === 'string') text = text.replace(/^\uFEFF/, '');
      }
      parser.push(text);
    }
    parser.push(decoder.decode());
    parser.end();
    return builder.finish();
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

// Index of the latest reading at or before t, or -1 if there is none yet.
export function indexAt(series, t) {
  let lo = 0;
  let hi = series.times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.times[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function valueAt(series, t) {
  const i = indexAt(series, t);
  return i === -1 ? null : series.values[i];
}
