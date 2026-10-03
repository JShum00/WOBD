// Reads a WOBD live data recording (the CSV js/recorder.js writes) back into
// per-PID time series for the replay page. No DOM here, so
// scripts/test-replay.mjs can check it in Node.
import { LIVE_PIDS, BATTERY } from './obd.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const REQUIRED = ['timestamp', 'elapsed_ms', 'pid', 'name', 'value', 'unit'];

export class ReplayError extends Error {}

// RFC 4180: commas and newlines inside quotes, "" for a quote. Handles \r\n or \n.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) rows.push([...row, field]);
  return rows;
}

// "0x0D" -> the Speed definition, "ATRV" -> Battery. Unknown PIDs return undefined.
export function defFor(pid) {
  if (pid === 'ATRV') return BATTERY;
  if (!/^0x[0-9A-F]{2}$/i.test(pid)) return undefined;
  const number = parseInt(pid.slice(2), 16);
  return LIVE_PIDS.find((def) => def.pid === number);
}

// Returns { startedAt, durationMs, readingCount, protocol, baudRate, series, unknownPids }.
// series is in Live data gauge order; each entry is { def, times, values } sorted by time.
export function parseRecording(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, '')).filter((row) => row.some((cell) => cell.trim()));
  const col = Object.fromEntries((header ?? []).map((name, i) => [name.trim(), i]));
  if (!REQUIRED.every((name) => name in col)) {
    throw new ReplayError("This doesn't look like a WOBD recording. Pick a CSV saved from WOBD's Live data recording.");
  }

  const byPid = new Map();
  const unknownPids = new Set();
  let protocol = null;
  let baudRate = null;
  let startedAt = null;
  let readingCount = 0;

  for (const row of rows) {
    const elapsed = Number(row[col.elapsed_ms]);
    const def = defFor(row[col.pid]);
    if (!def) {
      if (row[col.pid]) unknownPids.add(row[col.pid]);
      continue;
    }
    const raw = row[col.value];
    const value = def.style === 'status' ? raw : Number(raw);
    if (!Number.isFinite(elapsed) || raw === undefined || raw === '' || (typeof value === 'number' && !Number.isFinite(value))) continue;

    if (!byPid.has(def)) byPid.set(def, { def, times: [], values: [] });
    const series = byPid.get(def);
    series.times.push(elapsed);
    series.values.push(value);
    readingCount++;

    const at = Date.parse(row[col.timestamp]);
    if (startedAt === null && Number.isFinite(at)) startedAt = at - elapsed;
    if (protocol === null && 'protocol' in col && row[col.protocol] && row[col.protocol] !== 'unknown') protocol = row[col.protocol];
    const baud = 'baud' in col ? Number(row[col.baud]) : NaN;
    if (baudRate === null && Number.isInteger(baud) && baud > 0) baudRate = baud;
  }

  if (!readingCount) throw new ReplayError("This recording doesn't have any readings to replay.");

  let durationMs = 0;
  for (const series of byPid.values()) {
    // Rows are written in time order, but sort anyway in case a file was edited.
    const order = series.times.map((_, i) => i).sort((a, b) => series.times[a] - series.times[b]);
    series.times = order.map((i) => series.times[i]);
    series.values = order.map((i) => series.values[i]);
    durationMs = Math.max(durationMs, series.times.at(-1));
  }

  const gaugeOrder = [...LIVE_PIDS, BATTERY];
  const series = [...byPid.values()].sort((a, b) => gaugeOrder.indexOf(a.def) - gaugeOrder.indexOf(b.def));
  return { startedAt, durationMs, readingCount, protocol, baudRate, series, unknownPids: [...unknownPids] };
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
