// The connection info panel: asks the adapter about itself and renders the answers.
// Every query fails on its own, so one missing answer never blocks the rest.
import { h } from './dom.js';
import { PROTOCOLS, toMessages } from './obd.js';

const QUERY_TIMEOUT = 3000;
const LOW_BATTERY = 11.8;  // volts; engine-off batteries read about 12.4, running about 13.5+

export const FRIENDLY = {
  noAdapter: "I can't find your adapter. Make sure it's plugged in all the way, then try again.",
  noCar: "Your adapter's working, but I'm not hearing back from the car. Make sure the key is in the On position.",
  lowBattery: "Heads up — your battery's reading a little low, which can cause odd results.",
  generic: 'Something went wrong talking to your adapter. Try unplugging it and plugging it back in.',
};

// Turns any error into plain language and keeps the details in the console.
export function friendlyError(err) {
  console.error('[WOBD]', err);
  switch (err?.code) {
    case 'UNABLE_TO_CONNECT': return FRIENDLY.noCar;
    case 'NOT_ELM': return FRIENDLY.noAdapter;
    case 'NO_DATA': return FRIENDLY.noCar;
    default: break;
  }
  if (['NetworkError', 'InvalidStateError', 'SecurityError'].includes(err?.name)) return FRIENDLY.noAdapter;
  return FRIENDLY.generic;
}

async function query(elm, command) {
  try {
    const [first = ''] = await elm.send(command, QUERY_TIMEOUT);
    return first.trim() || null;
  } catch (err) {
    console.warn(`[WOBD] ${command} failed:`, err);
    return null;
  }
}

// Never throws. Missing answers are null.
export async function collectConnInfo(elm) {
  const protocolText = await query(elm, 'ATDP');
  const protocolNumber = await query(elm, 'ATDPN');
  const volts = parseFloat(await query(elm, 'ATRV'));
  const version = await query(elm, 'ATI');

  let ecuCount = null;
  try {
    ecuCount = toMessages(await elm.send('0100', QUERY_TIMEOUT)).length;
  } catch (err) {
    console.warn('[WOBD] ECU count failed:', err);
  }

  const number = protocolNumber?.slice(-1).toUpperCase();
  return {
    protocolName: protocolText?.replace(/^AUTO,\s*/i, '') ?? PROTOCOLS[number] ?? null,
    protocolNumber,
    carResponding: ecuCount === null ? null : ecuCount > 0,
    ecuCount,
    volts: Number.isFinite(volts) ? volts : null,
    version,
    authenticity: judgeAdapter(version),
  };
}

// Most cheap clones report "ELM327 v1.5", a version the real chip never shipped as.
function judgeAdapter(version) {
  if (!version) return null;
  return /v1\.5/i.test(version) ? 'Probably a clone' : 'Unknown';
}

// "115200 baud" for the rate SmartBauder connected at, or "baud unknown" when
// detection didn't run or record one (the plain demos skip detection).
export function baudLabel(baudRate) {
  return Number.isInteger(baudRate) ? `${baudRate} baud` : 'baud unknown';
}

export function isLowBattery(info) {
  return info?.volts != null && info.volts < LOW_BATTERY;
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

function row(label, value) {
  return h('div', { class: 'info-row' },
    h('dt', {}, label),
    h('dd', { class: value == null ? 'info-missing' : null }, value ?? 'Not available'));
}

export function renderConnInfo(info, { baudRate = null } = {}) {
  const panel = $('conn-info');
  const status = info.carResponding === null ? null
    : info.carResponding ? 'Connected, car is answering' : 'Adapter connected, car is not answering';
  const protocol = `${info.protocolName ?? 'Protocol unknown'} · ${baudLabel(baudRate)}`;

  $('conn-info-basic').replaceChildren(
    row('Protocol', protocol),
    row('Status', status),
    row('Battery', info.volts == null ? null : `${info.volts.toFixed(1)} V`));
  $('conn-info-adapter').replaceChildren(
    row('Adapter', info.version),
    row('Genuine or clone', info.authenticity));
  $('conn-info-advanced').replaceChildren(
    row('Car computers that answered', info.ecuCount == null ? null : String(info.ecuCount)),
    row('Protocol number', info.protocolNumber));

  const note = $('conn-info-note');
  note.textContent = info.carResponding === false ? FRIENDLY.noCar : isLowBattery(info) ? FRIENDLY.lowBattery : '';
  note.hidden = !note.textContent;
  panel.hidden = false;
}

export function hideConnInfo() {
  $('conn-info').hidden = true;
  $('conn-info-more').hidden = true;
  $('conn-info-toggle').setAttribute('aria-expanded', 'false');
  $('conn-info-toggle').textContent = 'More info';
}

export function initConnInfo() {
  const toggle = $('conn-info-toggle');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Less info' : 'More info';
    $('conn-info-more').hidden = !open;
  });
}
