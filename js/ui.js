// Rendering: tabs, the car form, the codes table, live gauges, dialogs, and
// the printable report. No OBD logic lives here.
import { h, svg } from './dom.js';
import { URGENCY, DIFFICULTY, urgencyBadge } from './bob.js';

const $ = (id) => document.getElementById(id);

const DISCLAIMER = 'WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.';

// Set when this browser can't reach an adapter, so Connect stays off.
let connectBlocked = false;

// check: the result of checkBrowser() in serial.js.
export function showBrowserAlert(check, { demo }) {
  $('browser-alert-title').textContent = check.reason;
  $('browser-alert-text').textContent = `${check.fix} You can still try the demos below.`;
  $('browser-alert').hidden = false;
  if (!demo) {
    connectBlocked = true;
    $('connect-btn').disabled = true;
    $('connect-btn').title = check.reason;
  }
}

// ---------- Welcome card ----------

export function initWelcome(demo) {
  $('welcome-real').hidden = Boolean(demo);
  $('welcome-demo').hidden = !demo;
  for (const link of document.querySelectorAll('.demo-list a')) {
    if (link.dataset.demo === demo) link.setAttribute('aria-current', 'page');
  }
}

export function initProtocolOverride(protocols) {
  const select = $('protocol-select');
  for (const [number, name] of Object.entries(protocols)) {
    select.append(h('option', { value: number }, `${number} · ${name}`));
  }
  $('protocol-override').addEventListener('change', () => {
    select.disabled = !$('protocol-override').checked || $('protocol-options').disabled;
  });
}

export function getProtocolOverride() {
  return $('protocol-override').checked ? $('protocol-select').value : null;
}

// Shown until the first connection. Afterwards the codes area takes over.
export function setWelcomeVisible(visible) {
  $('welcome').hidden = !visible;
  $('codes-empty').hidden = visible || $('codes-body').rows.length > 0;
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

const MODEL_OTHER = '__other';

// models: { Make: [model, ...] } from data/models.json. Makes with no list get a text box.
export function initCarForm(makes, models = {}) {
  const year = $('car-year');
  const newest = new Date().getFullYear() + 1;  // model years run a year ahead
  for (let y = newest; y >= 1996; y--) year.append(h('option', { value: String(y) }, String(y)));

  const make = $('car-make');
  const other = $('car-make-other');
  const model = $('car-model');
  const modelOther = $('car-model-other');
  make.append(...makes.map((m) => h('option', { value: m }, m)), h('option', { value: 'Other' }, 'Other'));

  const fillModels = () => {
    const list = models[make.value] ?? [];
    const typed = make.value !== '' && list.length === 0;
    model.replaceChildren(h('option', { value: '' }, 'Model'), ...list.map((m) => h('option', { value: m }, m)),
      list.length > 0 && h('option', { value: MODEL_OTHER }, 'Other'));
    model.hidden = typed;
    model.disabled = make.value === '';
    modelOther.hidden = !typed;
    modelOther.value = '';
  };
  fillModels();

  make.addEventListener('change', () => {
    other.hidden = make.value !== 'Other';
    fillModels();
    if (!other.hidden) other.focus();
  });
  model.addEventListener('change', () => {
    modelOther.hidden = model.value !== MODEL_OTHER;
    if (!modelOther.hidden) modelOther.focus();
  });

  $('car-skip')?.addEventListener('click', () => setCarSkipped(true));
  $('car-add')?.addEventListener('click', () => setCarSkipped(false));
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
  const modelPicked = $('car-model').hidden || $('car-model').value === MODEL_OTHER;
  const model = modelPicked ? $('car-model-other').value.trim() : $('car-model').value;
  return { year: $('car-year').value, make, model };
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
  $('connect-btn').disabled = connectBlocked || state === 'busy';
  $('protocol-options').disabled = state !== 'idle';
  $('protocol-select').disabled = !$('protocol-override').checked || state !== 'idle';
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

// ---------- Baud rate detection ----------

// Shown inside Bob's bubble when detection takes a moment. update() takes the onProgress payload.
export function createBaudProgress(onCancel) {
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', {
    class: 'progress',
    role: 'progressbar',
    'aria-label': 'Checking the device baud rate',
    'aria-valuemin': 0,
    'aria-valuemax': 1,
    'aria-valuenow': 0,
  }, fill);
  const el = h('div', { class: 'baud-progress' }, bar,
    h('button', { type: 'button', class: 'link-button', onClick: onCancel }, 'Cancel'));
  return {
    el,
    update({ attempt, total }) {
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(attempt));
      bar.setAttribute('aria-valuetext', `Trying speed ${attempt} of ${total}`);
      fill.style.width = `${(attempt / total) * 100}%`;
    },
    remove() { el.remove(); },
  };
}

// Manual fallback when no rate answered. onRetry gets the chosen rate.
export function baudRetryForm(rates, onRetry) {
  const select = h('select', {}, rates.map((rate) => h('option', { value: String(rate) }, `${rate} baud`)));
  const button = h('button', { type: 'submit', class: 'btn' }, 'Retry');
  return h('form', {
    class: 'baud-retry',
    onSubmit: (e) => {
      e.preventDefault();
      select.disabled = true;
      button.disabled = true;
      onRetry(Number(select.value));
    },
  }, h('label', {}, 'Try a specific speed ', select), button);
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

const DIAL_RADIUS = 50;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;
const DIAL_ARC = DIAL_CIRCUMFERENCE * 0.75;  // 270 degrees, open at the bottom

const gaugeNumber = () => h('span', { class: 'gauge-number' }, '—');
const gaugeUnit = (def) => def.unit && h('span', { class: 'gauge-unit' }, def.unit);

function gaugeShell(def, ...children) {
  const meter = def.style !== 'status';
  return h('div', {
    class: `gauge gauge-${def.style}`,
    id: `gauge-${def.key}`,
    role: meter ? 'meter' : null,
    'aria-label': meter ? def.label : null,
    'aria-valuemin': meter ? def.min : null,
    'aria-valuemax': meter ? def.max : null,
    dataset: { zone: 'ok' },
  }, ...children);
}

function radialGauge(def) {
  const ring = (cls, dash) => svg('circle', {
    class: cls, cx: 60, cy: 60, r: DIAL_RADIUS,
    transform: 'rotate(135 60 60)', 'stroke-dasharray': `${dash} ${DIAL_CIRCUMFERENCE}`,
  });
  return gaugeShell(def,
    h('div', { class: 'dial' },
      svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }, ring('dial-track', DIAL_ARC), ring('dial-fill', 0)),
      h('p', { class: 'gauge-value' }, gaugeNumber(), gaugeUnit(def)),
      h('span', { class: 'dial-end dial-min' }, String(def.min)),
      h('span', { class: 'dial-end dial-max' }, String(def.max))),
    h('p', { class: 'gauge-label' }, def.label));
}

function verticalGauge(def) {
  return gaugeShell(def,
    h('p', { class: 'gauge-value' }, gaugeNumber(), gaugeUnit(def)),
    h('div', { class: 'vbar-track' }, def.bipolar && h('span', { class: 'bar-zero' }), h('div', { class: 'bar-fill' })),
    h('p', { class: 'gauge-label' }, def.label));
}

function horizontalGauge(def) {
  return gaugeShell(def,
    h('div', { class: 'hbar-head' },
      h('p', { class: 'gauge-label' }, def.label),
      h('p', { class: 'gauge-value' }, gaugeNumber(), gaugeUnit(def))),
    h('div', { class: 'hbar-track' }, h('div', { class: 'bar-fill' })));
}

function statusGauge(def) {
  return gaugeShell(def,
    h('p', { class: 'gauge-label' }, def.label),
    h('p', { class: 'gauge-value' }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), gaugeNumber()));
}

const GAUGE_BUILDERS = { radial: radialGauge, vbar: verticalGauge, hbar: horizontalGauge, status: statusGauge };

// Draws exactly these gauges (the picker's choice, or a replay's readings), grouped by style.
export function renderGauges(defs) {
  const group = (cls, style) => {
    const gauges = defs.filter((def) => (style === 'hbar' ? def.style === 'hbar' || def.style === 'status' : def.style === style));
    return gauges.length > 0 && h('div', { class: `cluster ${cls}` }, gauges.map((def) => GAUGE_BUILDERS[def.style](def)));
  };
  $('gauges').replaceChildren(...[group('cluster-radial', 'radial'), group('cluster-vbar', 'vbar'), group('cluster-hbar', 'hbar')].filter(Boolean));
}

function zoneFor(def, value) {
  const size = Math.abs(value);
  if (def.danger != null && size >= def.danger) return 'danger';
  if (def.warn != null && size >= def.warn) return 'warn';
  return 'ok';
}

function statusZone(text) {
  if (!text) return 'idle';
  if (text.includes('fault')) return 'danger';
  return text.startsWith('Closed') ? 'ok' : 'idle';
}

// value is a number, a string for status gauges, or null when the car didn't answer.
export function updateGauge(def, value) {
  const gauge = $(`gauge-${def.key}`);
  if (!gauge) return;
  const number = gauge.querySelector('.gauge-number');

  if (def.style === 'status') {
    number.textContent = value ?? '—';
    gauge.dataset.zone = statusZone(value);
    return;
  }

  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const sign = def.bipolar && hasValue && value > 0 ? '+' : '';
  number.textContent = hasValue
    ? sign + value.toLocaleString(undefined, { minimumFractionDigits: def.digits, maximumFractionDigits: def.digits })
    : '\u2014';
  gauge.dataset.zone = hasValue ? zoneFor(def, value) : 'ok';
  if (hasValue) gauge.setAttribute('aria-valuenow', value.toFixed(def.digits));
  else gauge.removeAttribute('aria-valuenow');

  const fraction = hasValue ? Math.min(1, Math.max(0, (value - def.min) / (def.max - def.min))) : 0;
  if (def.style === 'radial') {
    const fill = gauge.querySelector('.dial-fill');
    fill.style.strokeDasharray = `${DIAL_ARC * fraction} ${DIAL_CIRCUMFERENCE}`;
    fill.style.opacity = fraction > 0 ? '1' : '0';
    return;
  }

  const fill = gauge.querySelector('.bar-fill');
  const from = def.bipolar ? Math.min(fraction, 0.5) : 0;
  const length = def.bipolar ? Math.abs(fraction - 0.5) : fraction;
  if (def.style === 'vbar') {
    fill.style.bottom = `${from * 100}%`;
    fill.style.height = `${length * 100}%`;
  } else {
    fill.style.left = `${from * 100}%`;
    fill.style.width = `${length * 100}%`;
  }
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

export function renderReport({ scannedAt, car, vin, status, entries, connection }) {
  const vehicle = carLabel(car);
  const codeCount = `${entries.length} code${entries.length === 1 ? '' : 's'} found`;

  const parts = [
    h('header', { class: 'report-header' },
      h('p', { class: 'report-logo' }, 'WOBD', h('small', {}, 'Web On-Board Diagnostics · Scan report')),
      h('p', { class: 'report-meta' },
        `Scanned ${scannedAt.toLocaleString()}`,
        h('br'), vehicle || 'Vehicle not entered',
        vin && [h('br'), `VIN ${vin}`],
        connection && [h('br'), connection])),
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
