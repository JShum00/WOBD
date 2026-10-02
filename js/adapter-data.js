// Shared loader for data/tested-adapters.json, used by the table and report pages.
// Add a test by appending one object (with a unique "id") to that file. Put its
// before/after PDFs in reports/<id>/ and point "reports" at them, or use null.
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
      && isNullableString(reports.after));
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
    && isReports(result.reports);
}

export function hasReports(result) {
  return Boolean(result.reports && (result.reports.before || result.reports.after));
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
