import './i18n-boot.js';
// The Simulator page: pick a year, make, and model, connect to a pretend car
// with the same steps WOBD uses, and watch the adapter traffic.
import { DemoTransport } from './demo.js';
import { ELM327 } from './elm327.js';
import * as obd from './obd.js';
import * as ui from './ui.js';
import { CODE_SETS, DEFAULT_CODE_SET, MAX_CUSTOM_CODES, parseCodeList, vehicleProfile } from './vehicles.js';
import { createTrafficView } from './traffic.js';
import { h } from './dom.js';
import { formatNumber, onLanguageChange, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const traffic = createTrafficView({ pre: $('sim-log') });

start();

async function start() {
  ui.initProtocolOverride(obd.PROTOCOLS);
  renderCodeSets();
  $('sim-codes').value = CODE_SETS[params.get('codes')] ? params.get('codes') : DEFAULT_CODE_SET;
  $('sim-custom').value = params.get('custom') ?? '';
  $('sim-noauto').checked = params.has('noauto');

  try {
    const [makes, models] = await Promise.all([
      fetch('data/makes.json').then((res) => res.json()),
      fetch('data/models.json').then((res) => res.json()).catch(() => ({})),
    ]);
    ui.initCarForm(makes, models);
    ui.setCar({ year: params.get('year'), make: params.get('make'), model: params.get('model') });
  } catch (err) {
    showResult(t('bob.simulator.failedLists', { error: err.message }), true);
  }

  for (const id of ['car-form', 'sim-codes', 'sim-custom', 'sim-noauto']) $(id).addEventListener('input', refresh);
  onLanguageChange(() => { renderCodeSets(); refresh(); });
  $('sim-connect').addEventListener('click', connect);
  refresh();
}

function renderCodeSets() {
  const select = $('sim-codes');
  const selected = select.value || params.get('codes');
  select.replaceChildren(...Object.entries(CODE_SETS).map(([key, { label }]) => h('option', { value: key }, label)));
  select.value = CODE_SETS[selected] ? selected : DEFAULT_CODE_SET;
}

function currentVehicle() {
  return vehicleProfile({ ...ui.getCar(), codeSet: $('sim-codes').value, customCodes: $('sim-custom').value, autoFails: $('sim-noauto').checked });
}

function refreshCustomCodes() {
  const custom = $('sim-codes').value === 'custom';
  const note = $('sim-custom-note');
  $('sim-custom').hidden = !custom;
  $('sim-custom-label').hidden = !custom;
  const { invalid, truncated } = parseCodeList($('sim-custom').value);
  const messages = [
    invalid.length && t('bob.simulator.customInvalid', { codes: invalid.join(', ') }),
    truncated && t('bob.simulator.customTooMany', { max: MAX_CUSTOM_CODES }),
  ].filter(Boolean);
  note.hidden = !custom || messages.length === 0;
  note.textContent = messages.join(' ');
}

function refresh() {
  refreshCustomCodes();
  const vehicle = currentVehicle();
  $('sim-profile').textContent = `${vehicle.label}: ${t('bob.simulator.protocolLabel')} ${vehicle.protocol} (${obd.PROTOCOLS[vehicle.protocol]}). ${vehicle.reason}. ${vehicle.vin ? t('bob.simulator.vinReported') : t('bob.simulator.noVin')}`;

  const link = new URLSearchParams({ demo: 'sim' });
  const car = ui.getCar();
  for (const key of ['year', 'make', 'model']) if (car[key]) link.set(key, car[key]);
  link.set('codes', $('sim-codes').value);
  if ($('sim-codes').value === 'custom' && $('sim-custom').value.trim()) link.set('custom', $('sim-custom').value.trim());
  if ($('sim-noauto').checked) link.set('noauto', '');
  $('sim-open').href = `index.html?${link}`;
}

function showResult(text, bad = false) {
  const result = $('sim-result');
  result.hidden = false;
  result.textContent = text;
  result.classList.toggle('is-error', bad);
}

async function connect() {
  const override = ui.getProtocolOverride();
  if (override === '') {
    showResult(t('bob.simulator.chooseProtocolError'), true);
    return;
  }

  traffic.clear();
  traffic.begin('Test connection');
  const transport = new DemoTransport(currentVehicle());
  traffic.attach(transport);

  $('sim-connect').disabled = true;
  $('protocol-options').disabled = true;
  showResult(t('bob.simulator.connecting'));
  try {
    await transport.open();
    const elm = new ELM327(transport);
    await elm.reset();
    await elm.configure(override ?? '0');
    const supported = await obd.readSupportedPids(elm);
    const protocol = await obd.readProtocol(elm);
    const vin = await obd.readVin(elm);
    const codes = await obd.readStoredCodes(elm, protocol.isCan);
    const how = override === null ? t('bob.simulator.protocolAutomatic') : t('bob.simulator.protocolChosen', { protocol: override });
    showResult([
      t('bob.simulator.connected', { number: protocol.number, name: protocol.name, how }),
      supported ? t('bob.simulator.supportedPids', { count: formatNumber(supported.pids.size) }) : t('bob.simulator.noPids'),
      vin ? t('bob.simulator.vin', { vin }) : t('bob.simulator.noVin'),
      codes.length ? t('bob.simulator.codesFound', { codes: codes.join(', ') }) : t('bob.simulator.noCodes'),
    ].join(' '));
  } catch (err) {
    showResult(t('bob.simulator.error', { code: err.code ?? 'Error', message: err.message }), true);
  } finally {
    await transport.close();
    $('sim-connect').disabled = false;
    $('protocol-options').disabled = false;
  }
}
