// Rendering: tabs, the car form, the codes table, live gauges, dialogs, and
// the printable report. No OBD logic lives here.
import { h, svg } from './dom.js';
import { formatDate, formatNumber, onLanguageChange, pidLabel, t } from './i18n.js';
import { displayDef, displayUnit, displayValue, onUnitsChange } from './units.js';
import { infoTip } from './info-tip.js';
import { versionLine } from './version-info.js';
import { URGENCY, DIFFICULTY, urgencyBadge } from './bob.js';
import { BATTERY, LIVE_PIDS } from './obd.js';

const $ = (id) => document.getElementById(id);
const PARAMETER_DEFS = [...LIVE_PIDS, BATTERY];
const parameterLabel = (entry) => {
  const def = entry.pid == null ? BATTERY : PARAMETER_DEFS.find((item) => item.pid === entry.pid);
  return def ? pidLabel(def) : entry.name;
};


// Set when this browser can't reach an adapter, so Connect stays off.
let connectBlocked = false;

// check: the result of checkBrowser() in serial.js.
export function showBrowserAlert(check, { demo }) {
  $('browser-alert-title').textContent = check.reason;
  $('browser-alert-text').textContent = t('app.ui.browserAlertSuffix', { fix: check.fix });
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
  make.append(...makes.map((m) => h('option', { value: m }, m)), h('option', { value: 'Other' }, t('app.ui.other')));

  const fillModels = () => {
    const list = models[make.value] ?? [];
    const typed = make.value !== '' && list.length === 0;
    model.replaceChildren(h('option', { value: '' }, t('app.ui.model')), ...list.map((m) => h('option', { value: m }, m)),
      list.length > 0 && h('option', { value: MODEL_OTHER }, t('app.ui.other')));
    model.hidden = typed;
    model.disabled = make.value === '';
    modelOther.hidden = !typed;
    modelOther.value = '';
  };
  fillModels();
  onLanguageChange(() => {
    const otherMake = [...make.options].find((option) => option.value === 'Other');
    if (otherMake) otherMake.textContent = t('app.ui.other');
    const emptyModel = [...model.options].find((option) => option.value === '');
    if (emptyModel) emptyModel.textContent = t('app.ui.model');
    const otherModel = [...model.options].find((option) => option.value === MODEL_OTHER);
    if (otherModel) otherModel.textContent = t('app.ui.other');
  });

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

// Fills the form from a link that already names the car. Names the lists don't have go in the text boxes.
export function setCar({ year, make, model } = {}) {
  const pick = (select, value) => {
    const option = [...select.options].find((o) => o.value && o.value.toLowerCase() === String(value).toLowerCase());
    if (option) select.value = option.value;
    return Boolean(option);
  };
  if (year) pick($('car-year'), year);
  if (!make) return;
  if (!pick($('car-make'), make)) {
    $('car-make').value = 'Other';
    $('car-make-other').value = make;
  }
  $('car-make').dispatchEvent(new Event('change'));
  if ($('car-make').value === 'Other') $('car-make-other').value = make;
  if (!model) return;
  if ($('car-model').hidden || !pick($('car-model'), model)) {
    if (!$('car-model').hidden) {
      $('car-model').value = MODEL_OTHER;
      $('car-model').dispatchEvent(new Event('change'));
    }
    $('car-model-other').value = model;
  }
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
  $('connect-btn').textContent = state === 'connected' ? t('app.ui.disconnect') : t('app.ui.connect');
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
    'aria-label': t('app.ui.checkingBaud'),
    'aria-valuemin': 0,
    'aria-valuemax': 1,
    'aria-valuenow': 0,
  }, fill);
  const el = h('div', { class: 'baud-progress' }, bar,
    h('button', { type: 'button', class: 'link-button', onClick: onCancel }, t('app.ui.cancel')));
  return {
    el,
    update({ attempt, total }) {
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(attempt));
      bar.setAttribute('aria-valuetext', t('app.ui.tryingSpeed', { attempt: formatNumber(attempt), total: formatNumber(total) }));
      fill.style.width = `${(attempt / total) * 100}%`;
    },
    remove() { el.remove(); },
  };
}

// Manual fallback when no rate answered. onRetry gets the chosen rate.
export function baudRetryForm(rates, onRetry) {
  const select = h('select', {}, rates.map((rate) => h('option', { value: String(rate) }, t('app.conn.baud', { rate: formatNumber(rate, { useGrouping: false }) }))));
  const button = h('button', { type: 'submit', class: 'btn' }, t('app.ui.retry'));
  return h('form', {
    class: 'baud-retry',
    onSubmit: (e) => {
      e.preventDefault();
      select.disabled = true;
      button.disabled = true;
      onRetry(Number(select.value));
    },
  }, h('label', {}, t('app.ui.trySpecificSpeed'), select), button);
}

// ---------- Codes table ----------

export function renderCodes(entries, onSelect) {
  $('codes-body').replaceChildren(...entries.map((entry) =>
    h('tr', { dataset: { code: entry.code } },
      h('td', {}, h('button', { type: 'button', class: 'code-link', onClick: () => onSelect(entry) }, entry.code)),
      h('td', {}, entry.title),
      h('td', {}, urgencyBadge(entry.urgency)),
      h('td', {}, `${entry.dtcStatus}${entry.ecuSource ? ` · ${entry.ecuName ?? 'ECU'} (${entry.ecuSource})` : ''}`),
    )));
  $('codes-table').hidden = entries.length === 0;
  $('codes-hint').hidden = entries.length === 0;
  $('codes-empty').hidden = entries.length > 0;
}

// Tabs appear only when more than one module answered.
export function renderModuleTabs(modules, active, onSelect) {
  const bar = $('module-tabs');
  bar.hidden = modules.length < 2;
  if (bar.hidden) return;
  const tab = (source, label) => h('button', {
    type: 'button',
    class: 'module-tab',
    role: 'tab',
    'aria-selected': String(source === active),
    onClick: () => onSelect(source),
  }, label);
  bar.replaceChildren(tab('all', t('app.ui.allModules')), ...modules.map((m) => tab(m.source, m.name))); 
}

export function setModuleDetail(module) {
  const el = $('module-detail');
  el.hidden = !module;
  if (!module) return;
  const count = (list) => (list === null ? t('app.ui.unavailable') : formatNumber(list.length));
  el.replaceChildren(
    h('strong', {}, module.name),
    t('app.ui.moduleAddress', { address: module.source }),
    module.confidence === 'inferred' ? ` · ${t('app.ui.nameInferred')}` : ` · ${t('app.ui.nameUnknown')}`,
    h('br'),
    module.milOn === null ? t('app.ui.milNotReported') : t('app.ui.milStatus', { status: module.milOn ? t('app.ui.on') : t('app.ui.off') }),
    ` · ${t('app.ui.stored')}: ${count(module.dtcs.stored)} · ${t('app.ui.pending')}: ${count(module.dtcs.pending)} · ${t('app.ui.permanent')}: ${count(module.dtcs.permanent)}`, 
  );
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
const gaugeUnit = (def) => def.unit && h('span', { class: 'gauge-unit' }, displayUnit(def.unit));

function gaugeShell(def, ...children) {
  const meter = def.style !== 'status';
  return h('div', {
    class: `gauge gauge-${def.style}`,
    id: `gauge-${def.key}`,
    role: meter ? 'meter' : null,
    'aria-label': meter ? pidLabel(def) : null,
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
      h('span', { class: 'dial-end dial-min' }, formatNumber(def.min, { useGrouping: false })),
      h('span', { class: 'dial-end dial-max' }, formatNumber(def.max, { useGrouping: false }))),
    h('p', { class: 'gauge-label' }, pidLabel(def)));
}

function verticalGauge(def) {
  return gaugeShell(def,
    h('p', { class: 'gauge-value' }, gaugeNumber(), gaugeUnit(def)),
    h('div', { class: 'vbar-track' }, def.bipolar && h('span', { class: 'bar-zero' }), h('div', { class: 'bar-fill' })),
    h('p', { class: 'gauge-label' }, pidLabel(def)));
}

function horizontalGauge(def) {
  return gaugeShell(def,
    h('div', { class: 'hbar-head' },
      h('p', { class: 'gauge-label' }, pidLabel(def)),
      h('p', { class: 'gauge-value' }, gaugeNumber(), gaugeUnit(def))),
    h('div', { class: 'hbar-track' }, h('div', { class: 'bar-fill' })));
}

function statusGauge(def) {
  return gaugeShell(def,
    h('p', { class: 'gauge-label' }, pidLabel(def)),
    h('p', { class: 'gauge-value' }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), gaugeNumber()));
}

const GAUGE_BUILDERS = { radial: radialGauge, vbar: verticalGauge, hbar: horizontalGauge, status: statusGauge };
let activeGaugeDefs = [];
const activeGaugeValues = new Map();

// Draws exactly these gauges (the picker's choice, or a replay's readings), grouped by style.
export function renderGauges(defs, { preserveValues = false } = {}) {
  if (!preserveValues) activeGaugeValues.clear();
  activeGaugeDefs = [...defs];
  const activeKeys = new Set(activeGaugeDefs.map((def) => def.key));
  for (const key of activeGaugeValues.keys()) if (!activeKeys.has(key)) activeGaugeValues.delete(key);
  const shownDefs = activeGaugeDefs.map((def) => displayDef(def));
  const group = (cls, style) => {
    const gauges = shownDefs.filter((def) => (style === 'hbar' ? def.style === 'hbar' || def.style === 'status' : def.style === style));
    return gauges.length > 0 && h('div', { class: `cluster ${cls}` }, gauges.map((def) => GAUGE_BUILDERS[def.style](def)));
  };
  $('gauges').replaceChildren(...[group('cluster-radial', 'radial'), group('cluster-vbar', 'vbar'), group('cluster-hbar', 'hbar')].filter(Boolean));
  for (const def of activeGaugeDefs) if (activeGaugeValues.has(def.key)) updateGauge(def, activeGaugeValues.get(def.key));
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
  activeGaugeValues.set(def.key, value);
  const shownDef = displayDef(def);
  const shownValue = displayValue(value, def.unit);
  const gauge = $(`gauge-${def.key}`);
  if (!gauge) return;
  const number = gauge.querySelector('.gauge-number');

  if (def.style === 'status') {
    number.textContent = value ?? '—';
    gauge.dataset.zone = statusZone(value);
    return;
  }

  const hasValue = typeof shownValue === 'number' && Number.isFinite(shownValue);
  const sign = def.bipolar && hasValue && shownValue > 0 ? '+' : '';
  number.textContent = hasValue
    ? sign + formatNumber(shownValue, { minimumFractionDigits: def.digits, maximumFractionDigits: def.digits })
    : '\u2014';
  gauge.dataset.zone = hasValue ? zoneFor(shownDef, shownValue) : 'ok';
  if (hasValue) gauge.setAttribute('aria-valuenow', shownValue.toFixed(def.digits));
  else gauge.removeAttribute('aria-valuenow');

  const fraction = hasValue ? Math.min(1, Math.max(0, (shownValue - shownDef.min) / (shownDef.max - shownDef.min))) : 0;
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

let liveCatalogRows = new Map();
let liveCatalogEntries = [];

function catalogKey(pid) {
  return pid == null ? 'ATRV' : pid.toString(16).toUpperCase().padStart(2, '0');
}

function catalogValue(entry) {
  const value = entry.lastSuccessfulReading;
  if (value == null) return '—';
  return typeof value === 'number'
    ? `${formatNumber(displayValue(value, entry.unit), { minimumFractionDigits: entry.digits ?? entry.decoder?.digits ?? 2, maximumFractionDigits: entry.digits ?? entry.decoder?.digits ?? 2, useGrouping: false })}${entry.unit ? ` ${displayUnit(entry.unit)}` : ''}`
    : String(value);
}

export function renderParameterCatalog(entries) {
  liveCatalogEntries = [...entries];
  const table = h('table', { class: 'live-catalog-table' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, t('app.ui.parameter')),
      h('th', { scope: 'col' }, t('app.ui.pid')),
      h('th', { scope: 'col' }, t('app.ui.latestValue')),
      h('th', { scope: 'col' }, t('app.ui.status')),
      h('th', { scope: 'col' }, t('app.ui.lastReading')))),
    h('tbody'));
  const body = table.querySelector('tbody');
  liveCatalogRows = new Map();
  const rows = [...entries, {
    pid: null,
    name: t('app.ui.adapterVoltage'),
    unit: 'V',
    digits: 1,
    ecuSources: [],
    availability: 'not-selected',
    lastSuccessfulReading: null,
    lastUpdatedAt: null,
  }];
  for (const entry of rows) {
    const key = catalogKey(entry.pid);
    const status = h('td', { class: 'catalog-status' }, entry.availability);
    if (entry.statusNote) status.append(' ', infoTip(entry.statusNote, t('app.ui.whyParameter', { name: parameterLabel(entry) ?? t('app.ui.thisParameter') })));
    const row = h('tr', {},
      h('th', { scope: 'row' }, parameterLabel(entry)),
      h('td', { class: 'mono' }, entry.pid == null ? 'ATRV' : `0x${key}`),
      h('td', { class: 'catalog-value' }, catalogValue(entry)),
      status,
      h('td', { class: 'catalog-time' }, entry.lastUpdatedAt ? formatDate(entry.lastUpdatedAt, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : t('app.ui.notReadYet')));
    body.append(row);
    liveCatalogRows.set(key, { row, entry });
  }
  $('live-catalog-table').replaceChildren(table);
}

export function updateParameterCatalog(entry) {
  const row = liveCatalogRows.get(catalogKey(entry.pid));
  if (!row) return;
  row.entry = entry;
  const existing = liveCatalogEntries.findIndex((item) => catalogKey(item.pid) === catalogKey(entry.pid));
  if (existing >= 0) liveCatalogEntries[existing] = entry;
  row.row.querySelector('.catalog-value').textContent = catalogValue(entry);
  const status = row.row.querySelector('.catalog-status');
  status.textContent = entry.availability;
  if (entry.statusNote) status.append(' ', infoTip(entry.statusNote, t('app.ui.whyParameter', { name: parameterLabel(entry) ?? t('app.ui.thisParameter') }))); 
  row.row.querySelector('.catalog-time').textContent = entry.lastUpdatedAt
    ? formatDate(entry.lastUpdatedAt, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : t('app.ui.notReadYet');
}

// ---------- Clear codes dialog ----------

// Consent dialog for recording undecoded parameters. optIn is a RawOptIn (js/raw-capture.js);
// resolves true only when it was confirmed, so Cancel, Escape, or closing never enable it.
export function confirmRawCapture(optIn) {
  const dialog = $('raw-dialog');
  const check = $('raw-ack');
  const confirm = $('raw-confirm');
  check.checked = false;
  confirm.disabled = true;
  check.onchange = () => {
    optIn.setAcknowledged(check.checked);
    confirm.disabled = !optIn.canConfirm;
  };
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'enable' && optIn.confirm()) resolve(true);
      else { optIn.cancel(); resolve(false); }
    }, { once: true });
  });
}

// Asks before a VIN is sent to NHTSA. Resolves true only on "Look it up".
export function confirmVinLookup() {
  const dialog = $('vin-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'lookup'), { once: true });
  });
}

// Shows the decoded car. Resolves { confirmed, remember }; closing or Escape counts as "no".
export function confirmVehicleMatch(car) {
  const dialog = $('vin-match-dialog');
  $('vin-match-car').textContent = carLabel(car);
  $('vin-remember').checked = false;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve({
      confirmed: dialog.returnValue === 'yes',
      remember: dialog.returnValue === 'yes' && $('vin-remember').checked,
    }), { once: true });
  });
}

export function showForgetCar(visible, onForget) {
  const button = $('car-forget');
  if (!button) return;
  button.hidden = !visible;
  button.onclick = onForget;
}

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

export function renderReport(data) {
  lastReport = data;
  const { scannedAt, car, vin, status, services, entries, connection } = data;
  const vehicle = carLabel(car);
  const codeCount = t('app.report.codes', { count: entries.length }).replace(String(entries.length), formatNumber(entries.length));
  const serviceSummary = services.map((service) => t('app.report.serviceSummary', {
    label: service.label,
    result: service.available ? t('app.report.reportedCount', { count: formatNumber(service.codes.length) }) : t('app.ui.unavailable'),
  })).join(' · ');

  const parts = [
    h('header', { class: 'report-header' },
      h('p', { class: 'report-logo' }, 'WOBD', h('small', {}, t('app.report.subtitle'))),
      h('p', { class: 'report-meta' },
        t('app.report.scannedAt', { date: formatDate(scannedAt, { dateStyle: 'medium', timeStyle: 'medium' }) }),
        h('br'), vehicle || t('app.report.vehicleNotEntered'),
        vin && [h('br'), t('app.report.vin', { vin })],
        connection && [h('br'), connection],
        h('br'), t('app.report.generatedBy', { version: versionLine() }))),
    h('p', { class: 'report-status' },
      h('strong', {}, t('app.report.engineLight')), ' ', status ? t(status.milOn ? 'app.report.on' : 'app.report.off') : t('app.report.unknown'),
      ` · ${codeCount}`,
      serviceSummary && [h('br'), t('app.report.dtcServices', { services: serviceSummary })]),
    entries.length > 0 && h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('app.report.code')), h('th', {}, t('app.report.title')), h('th', {}, t('app.report.urgency')), h('th', {}, t('app.report.statusEcu')), h('th', {}, t('app.report.meaning')))),
      h('tbody', {}, entries.map((e) => h('tr', {},
        h('td', { class: 'mono' }, e.code),
        h('td', {}, e.title),
        h('td', { class: 'urgency' }, (URGENCY[e.urgency] ?? URGENCY.unknown).label),
        h('td', {}, `${e.dtcStatus}${e.ecuSource ? ` · ${e.ecuName ?? 'ECU'} (${e.ecuSource})` : ''}`),
        h('td', {}, e.plain))))),
    entries.map((e) => h('section', { class: 'report-code' },
      h('h3', {}, `${e.code} · ${e.title} (${e.dtcStatus})`),
      h('p', {}, h('strong', {}, t('app.report.urgencyColon')), ` ${(URGENCY[e.urgency] ?? URGENCY.unknown).label}. `,
        (URGENCY[e.urgency] ?? URGENCY.unknown).says),
      e.causes.length > 0 && [h('p', {}, h('strong', {}, t('app.report.commonCauses'))), h('ul', {}, e.causes.map((c) => h('li', {}, c)))],
      e.difficulty && h('p', {}, h('strong', {}, t('app.report.diyOrShop')), ' ', DIFFICULTY[e.difficulty]),
      h('p', {}, h('strong', {}, t('app.report.tellMechanic')), ` “${e.tellMechanic}”`))),
    entries.length === 0 && h('p', {}, services.some((service) => !service.available)
      ? t('app.report.noCodesIncomplete')
      : t('app.report.noCodes')),
    h('footer', { class: 'report-footer' },
      h('p', {}, t('footer.disclaimer')),
      h('p', {}, t('app.report.testingNotice')),
      h('p', {}, t('app.report.freeDiagnostics'))),
  ];
  $('report').replaceChildren(...parts.flat().filter(Boolean));
}

let lastReport = null;
onLanguageChange(() => {
  const connToggle = $('conn-info-toggle');
  if (connToggle) connToggle.textContent = connToggle.getAttribute('aria-expanded') === 'true' ? t('app.conn.lessInfo') : t('app.conn.moreInfo');
  if (activeGaugeDefs.length) renderGauges(activeGaugeDefs, { preserveValues: true });
  if (liveCatalogEntries.length) renderParameterCatalog(liveCatalogEntries);
  if (lastReport) renderReport(lastReport);
});
onUnitsChange(() => {
  if (activeGaugeDefs.length) renderGauges(activeGaugeDefs, { preserveValues: true });
  if (liveCatalogEntries.length) renderParameterCatalog(liveCatalogEntries);
});
