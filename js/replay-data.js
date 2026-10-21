// Reads a WOBD live data recording (the CSV js/recorder.js writes) back into
// per-PID time series for the replay page. No DOM here, so
// scripts/test-replay.mjs can check it in Node.
import { LIVE_PIDS, BATTERY } from './obd.js';

export const MAX_FILE_BYTES = 128 * 1024 * 1024;
const REQUIRED = ['timestamp', 'elapsed_ms', 'pid', 'name', 'value', 'unit'];

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
  if (!/^0x[0-9A-F]{2}$/i.test(pid)) return undefined;
  const number = parseInt(pid.slice(2), 16);
  return LIVE_PIDS.find((def) => def.pid === number);
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
  }

  addRow(row) {
    if (!row.some((cell) => cell.trim())) return;
    if (!this.col) {
      this.col = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      if (!REQUIRED.every((name) => name in this.col)) {
        throw new ReplayError("This doesn't look like a WOBD recording. Pick a CSV saved from WOBD's Live data recording.");
      }
      return;
    }
    const { col } = this;
    const elapsed = Number(row[col.elapsed_ms]);
    const def = defFor(row[col.pid]);
    if (!def) {
      if (row[col.pid]) this.unknownPids.add(row[col.pid]);
      return;
    }
    const raw = row[col.value];
    const value = def.style === 'status' ? raw : Number(raw);
    if (!Number.isFinite(elapsed) || raw === undefined || raw === '' || (typeof value === 'number' && !Number.isFinite(value))) return;

    if (!this.byPid.has(def)) this.byPid.set(def, { def, times: [], values: [] });
    const series = this.byPid.get(def);
    series.times.push(elapsed);
    series.values.push(value);
    this.readingCount++;

    const at = Date.parse(row[col.timestamp]);
    if (this.startedAt === null && Number.isFinite(at)) this.startedAt = at - elapsed;
    if (this.protocol === null && 'protocol' in col && row[col.protocol] && row[col.protocol] !== 'unknown') this.protocol = row[col.protocol];
    const baud = 'baud' in col ? Number(row[col.baud]) : NaN;
    if (this.baudRate === null && Number.isInteger(baud) && baud > 0) this.baudRate = baud;
  }

  finish() {
    if (!this.col) {
      throw new ReplayError("This doesn't look like a WOBD recording. Pick a CSV saved from WOBD's Live data recording.");
    }
    if (!this.readingCount) throw new ReplayError("This recording doesn't have any readings to replay.");

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

    const gaugeOrder = [...LIVE_PIDS, BATTERY];
    const series = [...this.byPid.values()].sort((a, b) => gaugeOrder.indexOf(a.def) - gaugeOrder.indexOf(b.def));
    return {
      startedAt: this.startedAt, durationMs, readingCount: this.readingCount,
      protocol: this.protocol, baudRate: this.baudRate, series, unknownPids: [...this.unknownPids],
    };
  }
}

// Returns { startedAt, durationMs, readingCount, protocol, baudRate, series, unknownPids }.
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
