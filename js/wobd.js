// The .wobd archive: a versioned ZIP of JSON and JSON Lines (spec: Docs/WOBD-Format-Spec.md).
// writeWobd() builds one from a model (js/csv-lossless.js); readWobd() verifies and reads one.
// Pure functions over bytes, so scripts/test-wobd.mjs runs without a browser.
import { ZipError, readZip, sha256Hex, writeZip, LIMITS } from './zip.js';
import { CsvError, rebuildCsv } from './csv-lossless.js';
import { t } from './i18n.js';

export const MEDIA_TYPE = 'application/vnd.wobd.session+zip';
export const FORMAT = { name: 'wobd', major: 1, minor: 0 };
export const CHUNK_ROWS = 2000;
export const GAP_MS = 10000;          // same as LOST_AFTER_MS in recorder.js
const MAX_DICT = 5000;
const MAX_TEXT = 4000;
const MAX_ANNOTATIONS = 1024 * 1024;

export class WobdError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const json = (value) => enc.encode(JSON.stringify(value));
const part = (n) => String(n).padStart(6, '0');

const NAMES = [
  /^mimetype$/, /^manifest\.json$/, /^session\.json$/, /^dictionary\.json$/, /^segments\.json$/, /^annotations\.json$/,
  /^telemetry\/seg-\d{4}\/chunk-\d{6}\.jsonl$/, /^events\/events-\d{6}\.jsonl$/,
  /^legacy\/source-\d{6}\.csv$/, /^legacy\/residual-\d{6}\.jsonl$/,
];
export const isKnownName = (name) => NAMES.some((re) => re.test(name));

// Connection and timing events derived from the stored rows. Gaps are recorded as missing time
// only, never as a stall or as made-up readings.
export function deriveEvents(model, status) {
  const events = [];
  let last = null;
  let lastDt = null;
  model.rows.forEach((row, i) => {
    const dt = row[0];
    if (lastDt !== null && dt < lastDt) events.push({ type: 'clock_regression', class: 'inferred', row: i, from_ms: lastDt, to_ms: dt });
    else if (lastDt !== null && dt - lastDt >= GAP_MS) events.push({ type: 'unknown_gap', class: 'unknown', row: i, from_ms: lastDt, to_ms: dt });
    last = row;
    lastDt = dt;
  });
  if (status === 'partial' && last) events.push({ type: 'crash_inferred', class: 'inferred', at_ms: last[0] });
  return events;
}

function splitBytes(bytes) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += LIMITS.maxEntryBytes) parts.push(bytes.subarray(at, at + LIMITS.maxEntryBytes));
  return parts.length ? parts : [new Uint8Array(0)];
}

// options: { version, recordedWith, status: 'complete'|'partial', sessionId, source (Uint8Array|null),
//            annotations (string|null), compress }
export async function writeWobd(model, options = {}) {
  const status = options.status ?? 'complete';
  const session = {
    schema: 1,
    session_id: options.sessionId ?? `s${model.startedAt}`,
    source: model.native ? 'live-recording' : 'csv-import',
    written_with: options.version ?? null,
    recorded_with: options.recordedWith ?? null,
    started_at_ms: model.startedAt,
    started_at: Number.isFinite(model.startedAt) ? new Date(model.startedAt).toISOString() : null,
    protocol: model.protocol,
    baud: model.baud,
    status,
    rows: model.rows.length,
    csv: {
      native: Boolean(model.native), bom: model.bom, eol: model.eol, finalEol: model.finalEol,
      preamble: model.preamble, columns: model.columns, recordCount: model.recordCount,
    },
  };
  const files = [
    { name: 'mimetype', data: enc.encode(MEDIA_TYPE), store: true },
    { name: 'session.json', data: json(session) },
    { name: 'dictionary.json', data: json({ schema: 1, pids: model.dict }) },
    {
      name: 'segments.json',
      data: json({
        schema: 1,
        segments: [{ seg: 1, start_ms: model.rows[0]?.[0] ?? 0, end_ms: model.rows.at(-1)?.[0] ?? 0, rows: model.rows.length, status }],
      }),
    },
  ];
  const counts = new Map();
  let seq = 0;
  for (let i = 0, n = 1; i < model.rows.length || n === 1; i += CHUNK_ROWS, n++) {
    const rows = model.rows.slice(i, i + CHUNK_ROWS);
    if (!rows.length) break;
    const header = { v: 1, seg: 1, chunk: n, seq0: seq, mono0: rows[0][0], utc0: model.startedAt + rows[0][0], n: rows.length };
    const lines = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))];
    const name = `telemetry/seg-0001/chunk-${part(n)}.jsonl`;
    files.push({ name, data: enc.encode(`${lines.join('\n')}\n`) });
    counts.set(name, rows.length);
    seq += rows.length;
  }
  const events = deriveEvents(model, status);
  if (events.length) {
    files.push({ name: 'events/events-000001.jsonl', data: enc.encode(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`) });
    counts.set('events/events-000001.jsonl', events.length);
  }
  if (options.annotations) files.push({ name: 'annotations.json', data: enc.encode(options.annotations) });
  for (let i = 0; i < model.residual.length; i += 500) {
    const slice = model.residual.slice(i, i + 500);
    const name = `legacy/residual-${part(i / 500 + 1)}.jsonl`;
    files.push({ name, data: enc.encode(`${slice.map((r) => JSON.stringify(r)).join('\n')}\n`) });
    counts.set(name, slice.length);
  }
  if (options.source) splitBytes(options.source).forEach((bytes, i) => files.push({ name: `legacy/source-${part(i + 1)}.csv`, data: bytes }));

  for (const f of files) if (f.data.length > LIMITS.maxEntryBytes) throw new WobdError(t('replay.wobd.entryTooLarge', { name: f.name }));
  const manifest = {
    schema: 1,
    format: FORMAT,
    session_id: session.session_id,
    writer: { app: 'WOBD', version: options.version ?? null },
    status,
    redactions: [],
    entries: [],
  };
  for (const f of files) {
    manifest.entries.push({ name: f.name, size: f.data.length, sha256: await sha256Hex(f.data), ...(counts.has(f.name) ? { count: counts.get(f.name) } : {}) });
  }
  files.push({ name: 'manifest.json', data: json(manifest) });
  return writeZip(files, { compress: options.compress ?? true });
}

// ---------- Reading ----------

const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;

function parseJson(bytes, what) {
  try { return JSON.parse(dec.decode(bytes)); } catch { throw new WobdError(t('replay.wobd.invalidJson', { what })); }
}

function parseLines(bytes, what) {
  let text;
  try { text = dec.decode(bytes); } catch { throw new WobdError(t('replay.wobd.invalidText', { what })); }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => { try { return JSON.parse(line); } catch { throw new WobdError(t('replay.wobd.damagedLine', { what })); } });
}

function checkSession(s) {
  const ok = s && typeof s === 'object' && s.schema === 1 && isText(s.session_id, 120)
    && Number.isFinite(s.started_at_ms) && isText(s.protocol, 200) && isText(String(s.baud), 40)
    && (s.status === 'complete' || s.status === 'partial') && s.csv && typeof s.csv === 'object'
    && typeof s.csv.bom === 'boolean' && typeof s.csv.finalEol === 'boolean'
    && ['\r\n', '\n', '\r'].includes(s.csv.eol)
    && Array.isArray(s.csv.preamble) && s.csv.preamble.length < 1000 && s.csv.preamble.every((l) => isText(l, 2000))
    && Array.isArray(s.csv.columns) && s.csv.columns.length < 200 && s.csv.columns.every((c) => isText(c, 200))
    && Number.isInteger(s.csv.recordCount) && s.csv.recordCount >= 0 && typeof s.csv.native === 'boolean';
  if (!ok) throw new WobdError(t('replay.wobd.recordingDetailsInvalid'));
  return s;
}

function checkDict(d) {
  const ok = d && d.schema === 1 && Array.isArray(d.pids) && d.pids.length <= MAX_DICT
    && d.pids.every((p) => p && isText(p.pid, 200) && isText(p.name, 200) && isText(p.unit, 80) && isText(p.mode, 20) && typeof p.decoded === 'boolean');
  if (!ok) throw new WobdError(t('replay.wobd.parameterListInvalid'));
  return d.pids.map((p) => ({ pid: p.pid, name: p.name, unit: p.unit, mode: p.mode, decoded: p.decoded }));
}

function checkRow(r, dictSize) {
  const ok = Array.isArray(r) && r.length >= 3 && r.length <= 6 && Number.isFinite(r[0])
    && Number.isInteger(r[1]) && r[1] >= 0 && r[1] < dictSize && isText(r[2], 400)
    && (r[3] === undefined || isText(r[3], 2000)) && (r[4] === undefined || isText(r[4], 100))
    && (r[5] === undefined || (Number.isInteger(r[5]) && r[5] >= 0));
  if (!ok) throw new WobdError(t('replay.wobd.readingInvalid'));
  const row = [r[0], r[1], r[2], r[3] ?? '', r[4] ?? ''];
  if (r[5] !== undefined) row.push(r[5]);
  return row;
}

export async function readWobd(bytes, { limits } = {}) {
  let zip;
  try { zip = await readZip(bytes, { allowed: isKnownName, limits }); } catch (err) {
    if (err instanceof ZipError) throw new WobdError(err.message);
    throw err;
  }
  const { entries, warnings } = zip;
  const mime = entries.get('mimetype');
  if (!mime || dec.decode(mime) !== MEDIA_TYPE) throw new WobdError(t('replay.wobd.notRecordingFile'));
  if (!entries.has('manifest.json')) throw new WobdError(t('replay.wobd.missingManifest'));
  const manifest = parseJson(entries.get('manifest.json'), 'The manifest');
  if (!manifest || manifest.format?.name !== 'wobd') throw new WobdError(t('replay.wobd.notRecordingFile'));
  if (manifest.format.major !== 1) throw new WobdError(t('replay.wobd.newerVersion'));
  if (!Array.isArray(manifest.entries)) throw new WobdError(t('replay.wobd.manifestInvalid'));

  const listed = new Set();
  for (const item of manifest.entries) {
    const data = entries.get(item?.name);
    if (!data || listed.has(item.name)) throw new WobdError(t('replay.wobd.manifestMismatch'));
    listed.add(item.name);
    if (item.size !== data.length || item.sha256 !== await sha256Hex(data)) {
      throw new WobdError(t('replay.wobd.checksumMismatch', { name: String(item.name).slice(0, 60) }));
    }
  }
  for (const name of entries.keys()) {
    if (name !== 'manifest.json' && !listed.has(name)) throw new WobdError(t('replay.wobd.unlistedEntry'));
  }

  const session = checkSession(parseJson(entries.get('session.json') ?? new Uint8Array(), 'The recording details'));
  const dict = checkDict(parseJson(entries.get('dictionary.json') ?? new Uint8Array(), 'The parameter list'));
  const problems = [];

  const rows = [];
  const chunkNames = [...entries.keys()].filter((n) => n.startsWith('telemetry/')).sort();
  let seq = 0;
  for (const name of chunkNames) {
    const [header, ...body] = parseLines(entries.get(name), name);
    if (!header || header.v !== 1 || header.n !== body.length) throw new WobdError(t('replay.wobd.damagedReadingsBlock'));
    if (header.seq0 !== seq) problems.push(t('replay.wobd.missingReadings'));
    seq = header.seq0 + body.length;
    for (const r of body) rows.push(checkRow(r, dict.length));
  }

  const events = [];
  for (const name of [...entries.keys()].filter((n) => n.startsWith('events/')).sort()) {
    for (const e of parseLines(entries.get(name), name)) {
      if (e && isText(e.type, 60) && isText(e.class, 20)) events.push({ type: e.type, class: e.class, from_ms: e.from_ms, to_ms: e.to_ms, at_ms: e.at_ms, row: e.row });
    }
  }

  const residual = [];
  for (const name of [...entries.keys()].filter((n) => n.startsWith('legacy/residual-')).sort()) {
    for (const r of parseLines(entries.get(name), name)) {
      if (!Number.isInteger(r?.row) || !Array.isArray(r.fields) || !r.fields.every((f) => typeof f === 'string')) throw new WobdError(t('replay.wobd.savedCsvRecordInvalid'));
      residual.push({ row: r.row, fields: r.fields });
    }
  }

  const sourceParts = [...entries.keys()].filter((n) => n.startsWith('legacy/source-')).sort();
  let source = null;
  if (sourceParts.length) {
    const all = sourceParts.map((n) => entries.get(n));
    source = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of all) { source.set(p, at); at += p.length; }
  }
  let annotations = null;
  if (entries.has('annotations.json')) {
    if (entries.get('annotations.json').length > MAX_ANNOTATIONS) throw new WobdError(t('replay.wobd.notesTooLarge'));
    annotations = dec.decode(entries.get('annotations.json'));
  }

  const model = {
    native: session.csv.native, bom: session.csv.bom, eol: session.csv.eol, finalEol: session.csv.finalEol,
    preamble: session.csv.preamble, columns: session.csv.columns, protocol: session.protocol, baud: String(session.baud),
    startedAt: session.started_at_ms, dict, rows, residual, recordCount: session.csv.recordCount,
  };
  return { session, manifest, model, source, annotations, events, problems, warnings, partial: session.status === 'partial' };
}

// The recording as CSV bytes: the original bytes when they were kept, otherwise rebuilt.
export function wobdToCsvBytes(result) {
  if (result.source) return result.source;
  try { return enc.encode(rebuildCsv(result.model)); } catch (err) {
    if (err instanceof CsvError) throw new WobdError(err.message);
    throw err;
  }
}
