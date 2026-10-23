// The connection info panel: asks the adapter about itself and renders the answers.
// Every query fails on its own, so one missing answer never blocks the rest.
import { h } from './dom.js';
import { t } from './i18n.js';
import { formatNumber } from './i18n.js';
import { PROTOCOLS, toMessages } from './obd.js';

const QUERY_TIMEOUT = 3000;
const LOW_BATTERY = 11.8;  // volts; engine-off batteries read about 12.4, running about 13.5+

export const FRIENDLY = {
  get noAdapter() { return t('app.conn.noAdapter'); },
  get noCar() { return t('app.conn.noCar'); },
  get lowBattery() { return t('app.conn.lowBattery'); },
  get generic() { return t('app.conn.generic'); },
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

  // Timing this ordinary car request gives the gauge picker a real per-reading
  // speed for this protocol without sending anything extra.
  let ecuCount = null;
  let requestMs = null;
  try {
    const started = performance.now();
    ecuCount = toMessages(await elm.send('0100', QUERY_TIMEOUT)).length;
    requestMs = performance.now() - started;
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
    requestMs,
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
  return Number.isInteger(baudRate) ? t('app.conn.baud', { rate: formatNumber(baudRate) }) : t('app.conn.baudUnknown');
}

export function isLowBattery(info) {
  return info?.volts != null && info.volts < LOW_BATTERY;
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

function row(label, value) {
  return h('div', { class: 'info-row' },
    h('dt', {}, label),
    h('dd', { class: value == null ? 'info-missing' : null }, value ?? t('app.conn.notAvailable')));
}

export function renderConnInfo(info, { baudRate = null } = {}) {
  const panel = $('conn-info');
  const status = info.carResponding === null ? null
    : info.carResponding ? t('app.conn.carAnswering') : t('app.conn.carNotAnswering');
  const protocol = `${info.protocolName ?? t('app.conn.protocolUnknown')} · ${baudLabel(baudRate)}`;

  $('conn-info-basic').replaceChildren(
    row(t('app.conn.protocol'), protocol),
    row(t('app.conn.status'), status),
    row(t('app.conn.battery'), info.volts == null ? null : `${formatNumber(info.volts, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} V`));
  $('conn-info-adapter').replaceChildren(
    row(t('app.conn.adapter'), info.version),
    row(t('app.conn.genuineOrClone'), info.authenticity === 'Probably a clone' ? t('app.conn.probablyClone') : info.authenticity === 'Unknown' ? t('app.conn.unknown') : info.authenticity));
  $('conn-info-advanced').replaceChildren(
    row(t('app.conn.ecusAnswered'), info.ecuCount == null ? null : formatNumber(info.ecuCount)),
    row(t('app.conn.protocolNumber'), info.protocolNumber));

  const note = $('conn-info-note');
  note.textContent = info.carResponding === false ? FRIENDLY.noCar : isLowBattery(info) ? FRIENDLY.lowBattery : '';
  note.hidden = !note.textContent;
  panel.hidden = false;
}

export function hideConnInfo() {
  $('conn-info').hidden = true;
  $('conn-info-more').hidden = true;
  $('conn-info-toggle').setAttribute('aria-expanded', 'false');
  $('conn-info-toggle').textContent = t('app.conn.moreInfo');
}

export function initConnInfo() {
  const toggle = $('conn-info-toggle');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? t('app.conn.lessInfo') : t('app.conn.moreInfo');
    $('conn-info-more').hidden = !open;
  });
}
