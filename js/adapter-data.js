// Shared loader for data/tested-adapters.json, used by the table and report pages.
// Add a test by appending one object (with a unique "id") to that file. Put its
// before/after PDFs (and optionally a live data recording "csv" and its "graph" image, and an adapter traffic log "traffic" as .txt) in
// reports/<adapter>/<make>/<year>/<model>/ (lowercase, hyphenated) and point "reports" at them.
// "wobdVersion" is a manual override for the WOBD version; leave it out and the version
// is read from the files by scripts/update-report-versions.mjs (run it after adding files).
// Optional "graphNote" is a caption under the graph (who made it, what a gap means).
// Optional "explanations": { "readCodes" | "clearCodes" | "liveData": "text" } adds an (i) popover.
// Any of before, after, graph, and csv can be null when that file doesn't exist.
export const notTested = 'Not tested yet';

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableTextOrNumber(value) {
  return isNullableString(value) || typeof value === 'number';
}

function isReports(reports) {
  return reports === undefined
    || reports === null
    || (typeof reports === 'object'
      && isNullableString(reports.before)
      && isNullableString(reports.after)
      && [reports.graph, reports.csv, reports.traffic].every((path) => path === undefined || isNullableString(path))
      && isVersions(reports.versions));
}

// Versions read out of the report files by scripts/update-report-versions.mjs: { csv, traffic }.
function isVersions(value) {
  return value === undefined
    || (value !== null && typeof value === 'object'
      && Object.entries(value).every(([key, version]) => ['csv', 'traffic'].includes(key) && typeof version === 'string'));
}

// Which WOBD version made a test's data. A "wobdVersion" typed into the JSON is a
// manual override and always wins; otherwise it comes from the files ("reports.versions").
// Returns { version, manual, files } or null when nothing is known.
export function versionInfo(result) {
  const files = result.reports?.versions ?? {};
  if (result.wobdVersion) return { version: result.wobdVersion, manual: true, files };
  const found = [...new Set(Object.values(files))];
  return found.length ? { version: found.join(', '), manual: false, files } : null;
}

// Optional per-capability explanations, e.g. why something was not tested.
const explanationKeys = ['readCodes', 'clearCodes', 'liveData'];

function isExplanations(value) {
  return value === undefined
    || value === null
    || (typeof value === 'object'
      && Object.entries(value).every(([key, text]) => explanationKeys.includes(key) && typeof text === 'string'));
}

function isResult(result) {
  return result !== null
    && typeof result === 'object'
    && typeof result.id === 'string'
    && typeof result.product === 'string'
    && result.vehicle !== null
    && typeof result.vehicle === 'object'
    && isNullableTextOrNumber(result.vehicle.year)
    && isNullableString(result.vehicle.make)
    && isNullableString(result.vehicle.model)
    && isNullableString(result.protocol)
    && isNullableTextOrNumber(result.baud)
    && [result.readCodes, result.clearCodes, result.liveData].every((value) => (
      value === null || typeof value === 'boolean'
    ))
    && isNullableString(result.dateTested)
    && isNullableString(result.wobdVersion)
    && isNullableString(result.notes)
    && (result.graphNote === undefined || isNullableString(result.graphNote))
    && isExplanations(result.explanations)
    && isReports(result.reports);
}

export function hasReports(result) {
  const { reports } = result;
  return Boolean(reports && (reports.before || reports.after || reports.graph || reports.csv || reports.traffic));
}

export function vehicleName(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model]
    .map((value) => value === null ? notTested : String(value))
    .join(' ');
}

export async function loadResults() {
  const response = await fetch('data/tested-adapters.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || !results.every(isResult)) {
    throw new TypeError('Adapter results must be an array of valid test records');
  }
  return results;
}
