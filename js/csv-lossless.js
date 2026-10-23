// Lossless reading of WOBD CSV recordings into a structured model, and the exact way back.
// Replay's parser (replay-data.js) is deliberately left as it is; this one drops nothing.
// Every record is kept either as a telemetry row (when rebuilding it gives back the identical
// line) or as a residual record with its raw fields. rebuildCsv(model) then reproduces the
// original bytes, and analyzeCsv() verifies that itself, so a file can only be stored without
// its original bytes when that is provably safe.
import { BATTERY, LIVE_PIDS, pidLabel } from './obd.js';
import { t } from './i18n.js';

const STANDARD = ['timestamp', 'elapsed_ms', 'pid', 'name', 'value', 'unit', 'protocol', 'baud', 'raw', 'mode', 'ecu'];
const KNOWN_LABELS = new Set([...LIVE_PIDS, BATTERY].map((def) => pidLabel(def)));

export class CsvError extends Error {}

const fieldText = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

// Quote-aware records plus the line ending used. Nothing is trimmed or normalised.
export function splitRecords(text) {
  const records = [];
  const endings = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let atStart = true;
  let i = 0;
  const endRecord = (ending) => { fields.push(field); records.push(fields); endings.push(ending); fields = []; field = ''; atStart = true; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
      } else field += ch;
      i++;
    } else if (ch === '"' && atStart) {
      quoted = true; atStart = false; i++;
    } else if (ch === ',') {
      fields.push(field); field = ''; atStart = true; i++;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRecord('\r\n'); i += 2;
    } else if (ch === '\n' || ch === '\r') {
      endRecord(ch); i++;
    } else {
      field += ch; atStart = false; i++;
    }
  }
  const finalEol = text.length > 0 && (field === '' && fields.length === 0) && !quoted;
  if (!finalEol && (text.length > 0)) { fields.push(field); records.push(fields); }
  return { records, endings, finalEol };
}

const num = (text) => (text.trim() === '' ? NaN : Number(text));

// A telemetry row's CSV record, built the way WOBD's recorder writes it.
function project(model, row) {
  const [dt, id, value, raw = '', ecu = ''] = row;
  const d = model.dict[id];
  const by = {
    timestamp: new Date(model.startedAt + dt).toISOString(),
    elapsed_ms: String(dt),
    pid: d.pid, name: d.name, value, unit: d.unit,
    protocol: model.protocol, baud: model.baud,
    raw, mode: d.mode, ecu,
  };
  return model.columns.map((col) => by[col] ?? '');
}

// Builds the CSV text back from a model.
export function rebuildCsv(model) {
  const lines = [];
  for (const line of model.preamble) lines.push(line);
  lines.push(model.columns.map(fieldText).join(','));
  const bySource = new Map(model.rows.map((row) => [row[5], row]));
  const residual = new Map(model.residual.map((r) => [r.row, r.fields]));
  for (let n = 0; n < model.recordCount; n++) {
    const row = model.native ? model.rows[n] : bySource.get(n);
    const fields = residual.get(n) ?? (row ? project(model, row) : null);
    if (!fields) throw new CsvError(t('replay.wobd.csvMissingRecord'));
    lines.push(fields.map(fieldText).join(','));
  }
  return `${model.bom ? '\ufeff' : ''}${lines.join(model.eol)}${model.finalEol ? model.eol : ''}`;
}

// Model for rows that came straight from a live recording or its browser backup.
// rows: [at, pid, name, value, unit, raw, mode, ecu]
export function nativeModel({ startedAt, protocol, baud, version }, rows) {
  const dict = [];
  const index = new Map();
  const out = rows.map(([at, pid, name, value, unit, raw, mode, ecu]) => {
    const key = `${pid}|${name}|${unit}|${mode}`;
    if (!index.has(key)) { index.set(key, dict.length); dict.push({ pid, name, unit, mode, decoded: KNOWN_LABELS.has(pid) }); }
    return [at - startedAt, index.get(key), value, raw, ecu];
  });
  return {
    native: true, bom: false, eol: '\r\n', finalEol: true,
    preamble: version ? [`# WOBD v${version}`] : [], columns: [...STANDARD],
    protocol, baud: String(baud), startedAt, dict, rows: out, residual: [], recordCount: out.length,
  };
}

// Reads CSV bytes into a model plus a report. `exact` says whether rebuilding gives the
// original bytes, which decides whether the original can be left out of an archive.
export function analyzeCsv(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes); }
  const bom = text.startsWith('\ufeff');
  if (bom) text = text.slice(1);

  const preamble = [];
  let body = text;
  while (body.startsWith('#')) {
    const m = /\r\n|\n|\r/.exec(body);
    if (!m) { preamble.push(body); body = ''; break; }
    preamble.push(body.slice(0, m.index));
    body = body.slice(m.index + m[0].length);
  }
  const { records, endings, finalEol } = splitRecords(body);
  if (!records.length) throw new CsvError(t('replay.wobd.csvEmpty'));
  const columns = records[0];
  const col = (name) => columns.indexOf(name);
  const need = ['timestamp', 'elapsed_ms', 'pid', 'name', 'value'].filter((c) => col(c) < 0);
  if (need.length) throw new CsvError(t('replay.wobd.csvMissingColumns', { columns: need.join(', ') }));
  const eol = endings[0] ?? '\r\n';

  const data = records.slice(1);
  const at = (rec, name) => (col(name) >= 0 ? rec[col(name)] ?? '' : '');
  let startedAt = null;
  let protocol = '';
  let baud = '';
  for (const rec of data) {
    const dt = num(at(rec, 'elapsed_ms'));
    const stamp = Date.parse(at(rec, 'timestamp'));
    if (startedAt === null && Number.isFinite(dt) && Number.isFinite(stamp)) {
      startedAt = stamp - dt;
      protocol = at(rec, 'protocol');
      baud = at(rec, 'baud');
    }
  }
  const model = {
    native: false, bom, eol, finalEol, preamble, columns, protocol, baud,
    startedAt: startedAt ?? 0, dict: [], rows: [], residual: [], recordCount: data.length,
  };
  const index = new Map();
  const report = {
    records: data.length, telemetry: 0, exact: 0, normalized: 0, kept: 0,
    unknownPids: [], duplicates: 0, outOfOrder: 0, malformed: 0,
  };
  const unknown = new Set();
  const seen = new Set();
  let lastDt = -Infinity;
  data.forEach((rec, n) => {
    const dt = num(at(rec, 'elapsed_ms'));
    const pid = at(rec, 'pid');
    const name = at(rec, 'name');
    const usable = Number.isFinite(dt) && pid !== '' && name !== '' && rec.length <= columns.length;
    if (!usable) {
      model.residual.push({ row: n, fields: rec });
      report.malformed++;
      return;
    }
    const key = `${pid}|${name}|${at(rec, 'unit')}|${at(rec, 'mode')}`;
    if (!index.has(key)) {
      index.set(key, model.dict.length);
      const decoded = KNOWN_LABELS.has(pid);
      model.dict.push({ pid, name, unit: at(rec, 'unit'), mode: at(rec, 'mode'), decoded });
      if (!decoded) unknown.add(`${pid} ${name}`);
    }
    const row = [dt, index.get(key), at(rec, 'value'), at(rec, 'raw'), at(rec, 'ecu'), n];
    model.rows.push(row);
    report.telemetry++;
    const sig = `${dt}|${key}|${row[2]}`;
    if (seen.has(sig)) report.duplicates++;
    seen.add(sig);
    if (dt < lastDt) report.outOfOrder++;
    lastDt = dt;
    const rebuilt = project(model, row);
    if (rebuilt.length === rec.length && rebuilt.every((f, i) => f === rec[i])) report.exact++;
    else { model.residual.push({ row: n, fields: rec }); report.normalized++; }
  });
  report.kept = model.residual.length;
  report.unknownPids = [...unknown];
  const same = (() => {
    const back = new TextEncoder().encode(rebuildCsv(model));
    return back.length === bytes.length && back.every((b, i) => b === bytes[i]);
  })();
  return { model, report, exact: same };
}
