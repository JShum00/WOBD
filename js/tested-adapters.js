// Test records and their validation live in js/adapter-data.js.
import { hasReports, loadResults, notTested, vehicleName } from './adapter-data.js';

const body = document.querySelector('#adapter-results');
const message = document.querySelector('#adapter-message');
const table = document.querySelector('#adapter-table');

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

function reportsLink(result) {
  const cell = document.createElement('td');
  cell.className = 'adapter-reports';
  if (hasReports(result)) {
    const link = document.createElement('a');
    link.href = `report.html?id=${encodeURIComponent(result.id)}`;
    link.textContent = 'View reports';
    cell.append(link);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'adapter-not-tested';
    placeholder.textContent = 'None';
    cell.append(placeholder);
  }
  return cell;
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
    reportsLink(result),
  );
  return row;
}

try {
  const results = await loadResults();

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
