// The Simulator page: pick a year, make, and model, connect to a pretend car
// with the same steps WOBD uses, and watch the adapter traffic.
import { DemoTransport } from './demo.js';
import { ELM327 } from './elm327.js';
import * as obd from './obd.js';
import * as ui from './ui.js';
import { CODE_SETS, DEFAULT_CODE_SET, vehicleProfile } from './vehicles.js';
import { createTrafficView } from './traffic.js';
import { h } from './dom.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const traffic = createTrafficView({ pre: $('sim-log') });

start();

async function start() {
  ui.initProtocolOverride(obd.PROTOCOLS);
  for (const [key, { label }] of Object.entries(CODE_SETS)) $('sim-codes').append(h('option', { value: key }, label));
  $('sim-codes').value = CODE_SETS[params.get('codes')] ? params.get('codes') : DEFAULT_CODE_SET;
  $('sim-noauto').checked = params.has('noauto');

  try {
    const [makes, models] = await Promise.all([
      fetch('data/makes.json').then((res) => res.json()),
      fetch('data/models.json').then((res) => res.json()).catch(() => ({})),
    ]);
    ui.initCarForm(makes, models);
    ui.setCar({ year: params.get('year'), make: params.get('make'), model: params.get('model') });
  } catch (err) {
    showResult(`Couldn't load the make and model lists. ${err.message}`, true);
  }

  for (const id of ['car-form', 'sim-codes', 'sim-noauto']) $(id).addEventListener('input', refresh);
  $('sim-connect').addEventListener('click', connect);
  refresh();
}

function currentVehicle() {
  return vehicleProfile({ ...ui.getCar(), codeSet: $('sim-codes').value, autoFails: $('sim-noauto').checked });
}

function refresh() {
  const vehicle = currentVehicle();
  $('sim-profile').textContent = `${vehicle.label}: protocol ${vehicle.protocol} (${obd.PROTOCOLS[vehicle.protocol]}). ${vehicle.reason}. ${vehicle.vin ? 'Reports a VIN.' : 'No VIN.'}`;

  const link = new URLSearchParams({ demo: 'sim' });
  const car = ui.getCar();
  for (const key of ['year', 'make', 'model']) if (car[key]) link.set(key, car[key]);
  link.set('codes', $('sim-codes').value);
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
    showResult('Choose a protocol or uncheck the override to use automatic selection.', true);
    return;
  }

  traffic.clear();
  traffic.begin('Test connection');
  const transport = new DemoTransport(currentVehicle());
  traffic.attach(transport);

  $('sim-connect').disabled = true;
  $('protocol-options').disabled = true;
  showResult('Connecting…');
  try {
    await transport.open();
    const elm = new ELM327(transport);
    await elm.reset();
    await elm.configure(override ?? '0');
    const supported = await obd.readSupportedPids(elm);
    const protocol = await obd.readProtocol(elm);
    const vin = await obd.readVin(elm);
    const codes = await obd.readStoredCodes(elm, protocol.isCan);
    const how = override === null ? 'automatic selection' : `protocol ${override} chosen by you`;
    showResult([
      `Connected on protocol ${protocol.number} (${protocol.name}), ${how}.`,
      supported ? `${supported.pids.size} supported PIDs.` : "The car wouldn't list its supported PIDs.",
      vin ? `VIN ${vin}.` : 'No VIN.',
      codes.length ? `Trouble codes: ${codes.join(', ')}.` : 'No trouble codes.',
    ].join(' '));
  } catch (err) {
    showResult(`${err.code ?? 'Error'}: ${err.message}`, true);
  } finally {
    await transport.close();
    $('sim-connect').disabled = false;
    $('protocol-options').disabled = false;
  }
}
