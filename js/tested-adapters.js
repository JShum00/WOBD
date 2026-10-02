// Add a test by appending one object with the same fields to data/tested-adapters.json.
const body = document.querySelector('#adapter-results');
const message = document.querySelector('#adapter-message');
const table = document.querySelector('#adapter-table');
const notTested = 'Not tested yet';

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableTextOrNumber(value) {
  return isNullableString(value) || typeof value === 'number';
}

function isResult(result) {
  return result !== null
    && typeof result === 'object'
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
    && isNullableString(result.notes);
}

function field(value) {
  const cell = document.createElement('td');
  if (value === null) {
    const placeholder = document.createElement('span');
    placeholder.className = 'adapter-not-tested';
    placeholder.textContent = notTested;
    cell.append(placeholder);
  } else {
    cell.textContent = String(value);
  }
  return cell;
}

function capability(value) {
  const cell = document.createElement('td');
  if (value === true) {
    cell.textContent = '✓ Yes';
    cell.setAttribute('aria-label', 'Yes');
  } else if (value === false) {
    cell.textContent = '✗ No';
    cell.setAttribute('aria-label', 'No');
  } else {
    cell.textContent = 'Not tested';
    cell.setAttribute('aria-label', 'Not tested');
  }
  return cell;
}

function vehicleName(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model]
    .map((value) => value === null ? notTested : String(value))
    .join(' ');
}

function vehicleSortName(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model]
    .map((value) => value === null ? '' : String(value))
    .join(' ');
}

function compareText(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

function rowFor(result) {
  const row = document.createElement('tr');
  const vehicle = document.createElement('td');
  vehicle.textContent = vehicleName(result.vehicle);
  row.append(
    field(result.product),
    vehicle,
    field(result.protocol),
    field(result.baud),
    capability(result.readCodes),
    capability(result.clearCodes),
    capability(result.liveData),
    field(result.dateTested),
    field(result.wobdVersion),
    field(result.notes),
  );
  return row;
}

try {
  const response = await fetch('data/tested-adapters.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || !results.every(isResult)) {
    throw new TypeError('Adapter results must be an array of valid test records');
  }

  if (results.length === 0) {
    message.textContent = 'No adapter test results are available yet.';
    message.hidden = false;
  } else {
    results.sort((left, right) => compareText(left.product, right.product)
      || compareText(vehicleSortName(left.vehicle), vehicleSortName(right.vehicle)));
    body.replaceChildren(...results.map(rowFor));
    table.hidden = false;
  }
} catch (error) {
  console.error('Unable to load tested adapter results:', error);
  message.textContent = 'Tested adapter results could not be loaded. Please try again later.';
  message.setAttribute('role', 'alert');
  message.hidden = false;
}
