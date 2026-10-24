import './i18n-boot.js';
// Test records and their validation live in js/adapter-data.js.
import { infoTip } from './info-tip.js';
import { hasReports, loadResults, notTested, vehicleName, versionInfo } from './adapter-data.js';

const body = document.querySelector('#adapter-results');
const message = document.querySelector('#adapter-message');
const table = document.querySelector('#adapter-table');
const heading = document.querySelector('#adapter-heading');
const crumbs = document.querySelector('#adapter-crumbs');
const choices = document.querySelector('#adapter-choices');
const vehicles = document.querySelector('#adapter-vehicles');
const filterCount = document.querySelector('#adapter-filter-count');
const filters = {
  year: document.querySelector('#filter-year'),
  model: document.querySelector('#filter-model'),
  protocol: document.querySelector('#filter-protocol'),
};
const searchInput = document.querySelector('#filter-search');
let allResults = [];
let currentAdapter = null;
let currentMake = null;

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

function capability(value, tip, label) {
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
  if (tip) cell.append(' ', infoTip(tip, `Why: ${label}`));
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
    vehicle,
    field(result.protocol),
    field(result.baud),
    capability(result.readCodes, result.explanations?.readCodes, 'Read codes'),
    capability(result.clearCodes, result.explanations?.clearCodes, 'Clear codes'),
    capability(result.liveData, result.explanations?.liveData, 'Live data'),
    field(result.dateTested),
    field(versionInfo(result)?.version ?? 'Unknown'),
    field(result.notes),
    reportsLink(result),
  );
  return row;
}

const ANY = '';

function countBy(list, key) {
  const counts = new Map();
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((left, right) => compareText(String(left[0]), String(right[0])));
}

function renderCrumbs() {
  const items = [['Tested Adapters', currentAdapter ? () => showAdapters(true) : null]];
  if (currentAdapter) items.push([currentAdapter, currentMake ? () => showMakes(currentAdapter, true) : null]);
  if (currentMake) items.push([currentMake, null]);
  crumbs.replaceChildren();
  items.forEach(([label, action], index) => {
    if (index > 0) crumbs.append('›');
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', action);
      crumbs.append(button);
    } else {
      const current = document.createElement('span');
      current.textContent = label;
      current.setAttribute('aria-current', 'page');
      crumbs.append(current);
    }
  });
  crumbs.hidden = items.length < 2;
}

function showChoices(entries, onPick, noun) {
  vehicles.hidden = true;
  choices.replaceChildren(...entries.map(([name, count]) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => onPick(name));
    const badge = document.createElement('span');
    badge.className = 'adapter-count';
    badge.textContent = `${count} ${noun}${count === 1 ? '' : 's'}`;
    item.append(button, badge);
    return item;
  }));
  choices.hidden = false;
}

function enter(title) {
  heading.textContent = title;
  renderCrumbs();
  heading.focus();
}

function showAdapters(focus) {
  currentAdapter = null;
  currentMake = null;
  showChoices(countBy(allResults, (r) => r.product), (name) => showMakes(name, true), 'vehicle');
  if (focus) enter('Tested Adapters'); else renderCrumbs();
}

function showMakes(adapter, focus) {
  currentAdapter = adapter;
  currentMake = null;
  const list = allResults.filter((r) => r.product === adapter);
  showChoices(countBy(list, (r) => r.vehicle.make ?? 'Unknown'), (name) => showVehicles(adapter, name), 'vehicle');
  if (focus) enter(adapter); else renderCrumbs();
}

function fillSelect(select, label, values) {
  const previous = select.value;
  select.replaceChildren(new Option(`All ${label}`, ANY));
  for (const value of values) select.append(new Option(value, value));
  select.value = values.includes(previous) ? previous : ANY;
}

function uniqueSorted(list, pick) {
  return [...new Set(list.map(pick).filter((v) => v !== null && v !== undefined).map(String))]
    .sort((left, right) => compareText(left, right));
}

function applyFilters() {
  const base = allResults.filter((r) => r.product === currentAdapter && (r.vehicle.make ?? 'Unknown') === currentMake);
  const needle = searchInput.value.trim().toLowerCase();
  const shown = base.filter((r) => (!filters.year.value || String(r.vehicle.year) === filters.year.value)
    && (!filters.model.value || String(r.vehicle.model) === filters.model.value)
    && (!filters.protocol.value || String(r.protocol) === filters.protocol.value)
    && (!needle || `${vehicleName(r.vehicle)} ${r.notes ?? ''}`.toLowerCase().includes(needle)));
  shown.sort((left, right) => compareText(vehicleSortName(left.vehicle), vehicleSortName(right.vehicle)));
  body.replaceChildren(...shown.map(rowFor));
  table.hidden = shown.length === 0;
  filterCount.textContent = shown.length === 0
    ? 'No vehicles match these filters.'
    : `Showing ${shown.length} of ${base.length} vehicle${base.length === 1 ? '' : 's'}.`;
}

function showVehicles(adapter, make) {
  currentAdapter = adapter;
  currentMake = make;
  const base = allResults.filter((r) => r.product === adapter && (r.vehicle.make ?? 'Unknown') === make);
  fillSelect(filters.year, 'years', uniqueSorted(base, (r) => r.vehicle.year).reverse());
  fillSelect(filters.model, 'models', uniqueSorted(base, (r) => r.vehicle.model));
  fillSelect(filters.protocol, 'protocols', uniqueSorted(base, (r) => r.protocol));
  searchInput.value = '';
  choices.hidden = true;
  vehicles.hidden = false;
  applyFilters();
  enter(`${make} vehicles`);
}

for (const control of [...Object.values(filters), searchInput]) {
  control.addEventListener('input', applyFilters);
}
document.querySelector('#adapter-filters').addEventListener('submit', (event) => event.preventDefault());
document.querySelector('#filter-clear').addEventListener('click', () => {
  for (const select of Object.values(filters)) select.value = ANY;
  searchInput.value = '';
  applyFilters();
});

try {
  allResults = await loadResults();

  if (allResults.length === 0) {
    message.textContent = 'No adapter test results are available yet.';
    message.hidden = false;
  } else {
    showAdapters(false);
  }
} catch (error) {
  console.error('Unable to load tested adapter results:', error);
  message.textContent = 'Tested adapter results could not be loaded. Please try again later.';
  message.setAttribute('role', 'alert');
  message.hidden = false;
}
