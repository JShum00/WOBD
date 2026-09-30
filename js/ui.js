// Rendering: tabs, the car form, the codes table, live gauges, dialogs, and
// the printable report. No OBD logic lives here.
import { h } from './dom.js';
import { URGENCY, DIFFICULTY, urgencyBadge } from './bob.js';
import { LIVE_PIDS, BATTERY } from './obd.js';

const $ = (id) => document.getElementById(id);

const DISCLAIMER = 'WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.';

export function showUnsupported() {
  $('app').hidden = true;
  $('car-form').hidden = true;
  $('connect-btn').hidden = true;
  $('unsupported').hidden = false;
}

export function showDemoBadge() {
  $('demo-badge').hidden = false;
}

// ---------- Bob's voice toggle ----------

// Hidden entirely when the browser has no speech synthesis.
export function initVoiceToggle({ supported, enabled }, onToggle) {
  const button = $('voice-btn');
  if (!supported) return;
  button.hidden = false;
  button.setAttribute('aria-pressed', String(enabled));
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    onToggle(on);
  });
}

// ---------- Tabs ----------

export function initTabs(onChange) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    onChange(tab.dataset.tab);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const step = e.key === 'ArrowRight' ? 1 : -1;
      select(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
}

// ---------- Car form ----------

let carSkipped = false;

export function initCarForm(makes) {
  const year = $('car-year');
  const newest = new Date().getFullYear() + 1;  // model years run a year ahead
  for (let y = newest; y >= 1996; y--) year.append(h('option', { value: String(y) }, String(y)));

  const make = $('car-make');
  const other = $('car-make-other');
  make.append(...makes.map((m) => h('option', { value: m }, m)), h('option', { value: 'Other' }, 'Other'));
  make.addEventListener('change', () => {
    other.hidden = make.value !== 'Other';
    if (!other.hidden) other.focus();
  });

  $('car-skip').addEventListener('click', () => setCarSkipped(true));
  $('car-add').addEventListener('click', () => setCarSkipped(false));
}

function setCarSkipped(skipped) {
  carSkipped = skipped;
  $('car-fields').hidden = skipped;
  $('car-add').hidden = !skipped;
  (skipped ? $('car-add') : $('car-year')).focus();
}

export function getCar() {
  if (carSkipped) return {};
  const make = $('car-make').value === 'Other' ? $('car-make-other').value.trim() : $('car-make').value;
  return { year: $('car-year').value, make, model: $('car-model').value.trim() };
}

export function carLabel(car) {
  return [car.year, car.make, car.model].filter(Boolean).join(' ');
}

// ---------- Connection and scan controls ----------

// state: idle | busy | connected
export function setConnection(state, text) {
  $('conn-status').dataset.state = state;
  $('conn-status').textContent = text;
  $('connect-btn').textContent = state === 'connected' ? 'Disconnect' : 'Connect';
  $('connect-btn').disabled = state === 'busy';
}

export function setControls({ scan = false, print = false, clear = false }) {
  $('scan-btn').disabled = !scan;
  $('print-btn').disabled = !print;
  $('clear-btn').disabled = !clear;
}

export function setSummary(text) {
  $('scan-summary').hidden = !text;
  $('scan-summary').textContent = text ?? '';
}

// ---------- Codes table ----------

export function renderCodes(entries, onSelect) {
  $('codes-body').replaceChildren(...entries.map((entry) =>
    h('tr', { dataset: { code: entry.code } },
      h('td', {}, h('button', { type: 'button', class: 'code-link', onClick: () => onSelect(entry) }, entry.code)),
      h('td', {}, entry.title),
      h('td', {}, urgencyBadge(entry.urgency)),
    )));
  $('codes-table').hidden = entries.length === 0;
  $('codes-hint').hidden = entries.length === 0;
  $('codes-empty').hidden = entries.length > 0;
}

export function setEmptyMessage(text) {
  $('codes-empty').textContent = text;
}

export function selectCode(code) {
  for (const row of $('codes-body').rows) row.classList.toggle('selected', row.dataset.code === code);
}

export function focusCode(code) {
  $('codes-body').querySelector(`tr[data-code="${code}"] .code-link`)?.focus();
}

// ---------- Live data ----------

export function renderGauges(supportedPids) {
  $('gauges').replaceChildren(...[...LIVE_PIDS, BATTERY].map((def) => {
    const supported = def.pid === undefined || supportedPids.has(def.pid);
    return h('div', { class: 'gauge', id: `gauge-${def.key}`, dataset: { state: supported ? 'ok' : 'unsupported' } },
      h('p', { class: 'gauge-label' }, def.label),
      h('p', { class: 'gauge-value' },
        h('span', { class: 'gauge-number' }, supported ? '—' : 'Not reported by this car'),
        supported && h('span', { class: 'gauge-unit' }, def.unit)),
      h('div', { class: 'gauge-track' }, h('div', { class: 'gauge-fill' })));
  }));
}

export function updateGauge(def, value) {
  const gauge = $(`gauge-${def.key}`);
  if (!gauge || gauge.dataset.state === 'unsupported') return;
  const hasValue = value != null && Number.isFinite(value);
  gauge.querySelector('.gauge-number').textContent = hasValue ? value.toFixed(def.digits) : '—';
  const pct = hasValue ? Math.min(100, Math.max(0, ((value - def.min) / (def.max - def.min)) * 100)) : 0;
  gauge.querySelector('.gauge-fill').style.width = `${pct}%`;
}

// ---------- Clear codes dialog ----------

export function confirmClear() {
  const dialog = $('clear-dialog');
  const check = $('clear-ready');
  const confirm = $('clear-confirm');
  check.checked = false;
  confirm.disabled = true;
  check.onchange = () => { confirm.disabled = !check.checked; };
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'clear'), { once: true });
  });
}

// ---------- Printable report ----------

export function renderReport({ scannedAt, car, vin, status, entries }) {
  const vehicle = carLabel(car);
  const codeCount = `${entries.length} code${entries.length === 1 ? '' : 's'} found`;

  const parts = [
    h('header', { class: 'report-header' },
      h('p', { class: 'report-logo' }, 'WOBD', h('small', {}, 'Web On-Board Diagnostics · Scan report')),
      h('p', { class: 'report-meta' },
        `Scanned ${scannedAt.toLocaleString()}`,
        h('br'), vehicle || 'Vehicle not entered',
        vin && [h('br'), `VIN ${vin}`])),
    h('p', { class: 'report-status' },
      h('strong', {}, 'Check engine light: '), status ? (status.milOn ? 'ON' : 'OFF') : 'Unknown',
      ` · ${codeCount}`),
    entries.length > 0 && h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Title'), h('th', {}, 'Urgency'), h('th', {}, 'What it means'))),
      h('tbody', {}, entries.map((e) => h('tr', {},
        h('td', { class: 'mono' }, e.code),
        h('td', {}, e.title),
        h('td', { class: 'urgency' }, (URGENCY[e.urgency] ?? URGENCY.unknown).label),
        h('td', {}, e.plain))))),
    entries.map((e) => h('section', { class: 'report-code' },
      h('h3', {}, `${e.code} · ${e.title}`),
      h('p', {}, h('strong', {}, 'Urgency: '), `${(URGENCY[e.urgency] ?? URGENCY.unknown).label}. `,
        (URGENCY[e.urgency] ?? URGENCY.unknown).says),
      e.causes.length > 0 && [h('p', {}, h('strong', {}, 'Common causes:')), h('ul', {}, e.causes.map((c) => h('li', {}, c)))],
      e.difficulty && h('p', {}, h('strong', {}, 'DIY or shop: '), DIFFICULTY[e.difficulty]),
      h('p', {}, h('strong', {}, 'Tell your mechanic: '), `“${e.tellMechanic}”`))),
    entries.length === 0 && h('p', {}, 'No stored trouble codes were found.'),
    h('footer', { class: 'report-footer' },
      h('p', {}, DISCLAIMER),
      h('p', {}, "WOBD is in active testing and development, and its results aren't guaranteed yet."),
      h('p', {}, 'Free car diagnostics at wobd.app')),
  ];
  $('report').replaceChildren(...parts.flat().filter(Boolean));
}
