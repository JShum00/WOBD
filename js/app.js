import './i18n-boot.js';
import { formatNumber, onLanguageChange, t } from './i18n.js';
// Wires the adapter, OBD requests, Bob, and the UI together and holds app state.
import { SerialTransport, checkBrowser } from './serial.js';
import { DemoTransport, DemoBaudTransport, BAUD_DEMOS } from './demo.js';
import { vehicleProfile } from './vehicles.js';
import { ELM327, ElmError } from './elm327.js';
import { abortOnUnplug, detectBaud, rateOptions } from './smartbauder.js';
import * as obd from './obd.js';
import { Bob, loadCodeBook, loadGenericCodes, lookup } from './bob.js';
import * as ui from './ui.js';
import { Voice } from './voice.js';
import { createTrafficView } from './traffic.js';
import { DriveLock, Recording } from './recorder.js';
import { createBackup } from './backup.js';
import { RawBudget, RawOptIn, SPEED_FRESH_MS, rawEvery } from './raw-capture.js';
import { RecordLock } from './record-lock.js';
import { GaugePicker, defaultKeys, pickerChoices } from './gauge-picker.js';
import { h } from './dom.js';
import { versionLine } from './version-info.js';
import { diagnoseConnection } from './troubleshoot.js';
import { forgetVehicle, loadSavedVehicle, lookupVin, saveVehicle } from './vin.js';
import { baudLabel, collectConnInfo, friendlyError, hideConnInfo, initConnInfo, isLowBattery, renderConnInfo, FRIENDLY } from './conninfo.js';

const DETECT_PROGRESS_DELAY = 300;  // ms before the baud-rate progress bar appears

const params = new URLSearchParams(location.search);
const demo = params.has('demo') ? params.get('demo') || 'can' : null;
const browser = checkBrowser();

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pluralText = (key, count, params = {}) => t(key, { ...params, count }).replace(String(count), formatNumber(count));

const state = {
  transport: null,
  elm: null,
  protocol: null,
  baudRate: null,    // the rate SmartBauder connected at; null when detection didn't run
  supportedPids: null,  // Set of PIDs the car reported, or null if it wouldn't say
  ecuPids: [],       // per-ECU support maps when the adapter exposes response headers
  offered: [],       // gauge defs the picker offers for this car
  catalog: [],
  undecoded: [],     // supported PIDs with no gauge yet, for the picker's list
  gauges: null,      // gauge defs the user picked; null until picked on this connection
  monitorMode: 'manual',
  requestMs: null,   // measured time per car request (connect, then the live loop)
  pickerIntroDone: false,
  lastHint: null,    // preset Bob last explained in the picker
  vin: null,
  vinStatus: 'none',
  scan: null,        // { scannedAt, status, entries }
  selected: null,    // code Bob is explaining
  tab: 'scan',
  busy: false,
  liveRun: 0,        // bumping this stops the live data loop
  recording: null,   // { data: Recording, lock: DriveLock } while recording live data
  wakeLock: null,
};

const traffic = createTrafficView({
  pre: $('traffic-log'),
  details: $('traffic'),
  copy: $('traffic-copy'),
  clear: $('traffic-clear'),
  mask: $('traffic-mask'),
  header: trafficHeader,
  onFirstEntry: () => { $('traffic').hidden = false; },
});
function trafficHeader() {
  const protocol = ui.getProtocolOverride();
  return [
    versionLine(),
    `Browser: ${navigator.userAgent}`,
    `Date: ${new Date().toISOString()}`,
    `Baud rate: ${state.baudRate ?? 'not detected'}`,
    `Protocol: ${protocol === null ? 'automatic' : `${protocol} chosen`}${state.protocol ? `, connected on ${state.protocol.number} (${state.protocol.name})` : ''}`,
    `Adapter: ${state.connInfo?.version ?? 'unknown'}`,
  ].join('\n');
}

const voice = new Voice();
const bob = new Bob({ slot: $('bob-slot'), live: $('bob-live'), getCar: ui.getCar, voice });
const rawOptIn = new RawOptIn();
const backup = createBackup({ $, download: (data, name, type) => downloadCsv(data, name, type) });
const recordLock = new RecordLock({ onSave: saveRecording, onKeep: keepRecording });
const picker = new GaugePicker({ root: $('gauge-picker'), onApply: applyGauges, onPresetHint: presetHint });

// What Bob says about each picker preset when it's pointed at or tapped.
const PRESET_LINES = {
  basics: () => ({ tone: 'low', text: t('app.preset.basics') }),
  fuel: () => ({ text: t('app.preset.fuel') }),
  all: () => ({ tone: 'medium', text: t('app.preset.all') }),
};

start();

onLanguageChange(() => {
  if (!state.busy) ui.setConnection(state.elm ? 'connected' : 'idle', state.elm ? t('app.conn.connected', { connection: connectionLabel() }) : t('app.conn.notConnected'));
  if (state.connInfo && state.elm) renderConnInfo(state.connInfo, { baudRate: state.baudRate });
  if (state.scan) { showScanResults(); announceScan(state.scan); }
  else if (!state.busy && !state.recording) bobIdle();
  if (state.selected) bob.explain(lookup(state.selected));
});

async function start() {
  if (!browser.supported) ui.showBrowserAlert(browser, { demo });
  if (demo) ui.showDemoBadge();
  ui.initWelcome(demo);
  ui.initProtocolOverride(obd.PROTOCOLS);

  initConnInfo();
  ui.initTabs(onTabChange);
  ui.initVoiceToggle(voice, (on) => {
    voice.setEnabled(on);
    if (on) bob.repeat();  // the click is the user gesture browsers need before speaking
  });
  ui.setConnection('idle', t('app.conn.notConnected'));
  ui.setControls({});
  ui.renderGauges(pickerChoices(null).offered);  // preview until a car reports what it supports

  try {
    const [makes, models] = await Promise.all([
      fetch('data/makes.json').then((res) => res.json()),
      // The model list is a nicety: without it the model box is plain text.
      fetch('data/models.json').then((res) => res.json()).catch(() => ({})),
      loadCodeBook(),
    ]);
    ui.initCarForm(makes, models);
    if (demo === 'sim') ui.setCar({ year: params.get('year'), make: params.get('make'), model: params.get('model') });
    else restoreSavedCar();
  } catch (err) {
    showError(new Error(`I couldn't load my notes. ${err.message}`));
    return;
  }

  $('connect-btn').addEventListener('click', onConnectClick);
  $('scan-btn').addEventListener('click', () => busy(t('app.scan.scanning'), scan));
  $('clear-btn').addEventListener('click', onClearClick);
  $('print-btn').addEventListener('click', () => window.print());
  backup.init().catch(() => {});
  $('record-btn').addEventListener('click', startRecording);
  $('record-raw').addEventListener('change', async (e) => {
    if (!e.target.checked) { rawOptIn.disable(); return; }
    e.target.checked = false;
    if (!rawOptIn.request()) return;
    e.target.checked = await ui.confirmRawCapture(rawOptIn);
  });
  $('gauges-btn').addEventListener('click', changeGauges);
  window.addEventListener('beforeunload', (e) => { if (state.recording) e.preventDefault(); });
  document.addEventListener('visibilitychange', keepScreenOn);
  window.addEventListener('beforeprint', renderReport);
  document.addEventListener('keydown', onKeydown);

  bobIdle();
}

// ---------- Bob's default lines ----------

function bobIdle() {
  if (state.tab === 'live') {
    bob.say({
      tone: 'medium',
      mood: 'warning',
      text: state.elm
        ? t('app.live.parkedConnected')
        : t('app.live.connectFirst'),
    });
  } else if (state.selected) {
    bob.explain(lookup(state.selected));
  } else if (state.scan) {
    announceScan(state.scan);
  } else if (state.elm) {
    bob.say({
      tone: 'low',
      mood: 'check',
      text: t('app.conn.connectedIntro'),
    });
  } else if (demo) {
    bob.say({ text: t('app.welcome.demoBob') });
  } else if (!browser.supported) {
    bob.say({
      tone: 'unknown',
      mood: 'question',
      text: t('app.welcome.browserBob', { reason: browser.reason, fix: browser.fix }),
    });
  } else {
    bob.say({
      text: t('app.welcome.adapterBob'),
    });
  }
}

function showError(err) {
  bob.say({ tone: 'high', mood: 'warning', text: friendlyError(err) });
}

// Connection failures get a message for where the conversation stopped, plus
// the adapter's own wording and an optional user-initiated protocol search.
function showConnectError(err, protocol) {
  console.error('[WOBD]', err);
  const result = diagnoseConnection(err, { protocol, car: ui.getCar() });
  traffic.add('note', `Failure type: ${result.category}${result.adapterReply ? ` (adapter said "${result.adapterReply}")` : ''}`);
  const details = [];
  if (result.adapterReply) details.push(h('p', { class: 'hint' }, `${t('app.trouble.adapterSaid')} ${result.adapterReply}`));
  if (result.searchUrl) {
    details.push(h('a', { href: result.searchUrl, target: '_blank', rel: 'noopener noreferrer' }, t('app.trouble.searchLink')));
  }
  bob.say({ tone: 'high', mood: 'warning', text: result.text, details });
}

// ---------- Connect ----------

// ?demo=sim builds the car from the year, make, and model in the header when you connect.
function demoTransport(name) {
  if (name === 'sim') {
    return new DemoTransport(vehicleProfile({
      ...ui.getCar(),
      codeSet: params.get('codes') ?? undefined,
      autoFails: params.has('noauto'),
    }));
  }
  return BAUD_DEMOS.includes(name) ? new DemoBaudTransport(name) : new DemoTransport(name);
}

async function onConnectClick() {
  if (state.elm) {
    await disconnect();
    bob.say({ text: t('app.conn.disconnected') });
    return;
  }

  const protocol = ui.getProtocolOverride();
  if (protocol === '') {
    bob.say({ tone: 'medium', mood: 'question', text: t('app.conn.chooseProtocol') });
    return;
  }

  ui.setConnection('busy', t('app.conn.connecting'));
  let transport;
  try {
    transport = demo ? demoTransport(demo) : await SerialTransport.request();
  } catch (err) {
    ui.setConnection('idle', t('app.conn.notConnected'));
    if (err.name === 'NotFoundError') {
      bob.say({
        tone: 'unknown',
        mood: 'question',
        text: t('app.conn.noAdapterPicked'),
      });
    } else {
      showError(err);
    }
    return;
  }

  traffic.begin(`New connection, ${protocol === null ? 'automatic protocol' : `protocol ${protocol} chosen`}`);
  await connectTo(transport, { protocol });
}

// Opens the adapter and says hello to the car. baudRate skips detection (the manual Retry).
async function connectTo(transport, { baudRate, protocol } = {}) {
  ui.setConnection('busy', t('app.conn.connecting'));
  bob.say({ text: t('app.conn.lookingForAdapter') });

  // Unplugging or cancelling stops detection at once.
  const abort = abortOnUnplug(transport);
  traffic.attach(transport);
  try {
    const { elm, baudRate: connectedBaud } = await openAdapter(transport, { baudRate, protocol, abort });
    ui.setConnection('busy', t('app.conn.talkingToCar'));
    bob.say({ text: t('app.conn.foundAdapter') });

    let supported;
    try {
      supported = await obd.readSupportedPids(elm, { headers: true });
    } catch (err) {
      if (err.code === 'UNABLE_TO_CONNECT') await logAdapterProtocol(elm);
      throw err;
    }
    state.supportedPids = supported?.pids ?? null;
    state.ecuPids = supported?.ecus ?? [];
    if (supported) {
      console.info('[WOBD] Supported PID replies:', supported.replies.join(' · '));
      console.info('[WOBD] Supported PID sources:', supported.ecus.map(({ source, pids }) => ({
        source: source ?? 'unknown ECU',
        pids: [...pids].map((pid) => `0x${pid.toString(16).toUpperCase().padStart(2, '0')}`),
      })));
    }
    else console.info("[WOBD] The car didn't report its supported PIDs; offering the default gauges.");
    state.protocol = await obd.readProtocol(elm);
    ({ vin: state.vin, status: state.vinStatus } = await obd.readVinInfo(elm));
  // The VIN stays out of printouts unless the user opts in each connection.
  $('print-vin').checked = false;
  $('print-vin-wrap').hidden = !state.vin;
    state.connInfo = await collectConnInfo(elm);
    if (!supported) {
      console.info('[WOBD] Adapter protocol after unanswered 0100:', {
        ATDP: state.connInfo.protocolName,
        ATDPN: state.connInfo.protocolNumber,
      });
    }
    state.baudRate = connectedBaud;
    state.requestMs = state.connInfo.requestMs;
    ({
      offered: state.offered,
      undecoded: state.undecoded,
      catalog: state.catalog,
    } = pickerChoices(state.supportedPids, state.ecuPids));
    ui.renderParameterCatalog(state.catalog);
    state.gauges = null;
    state.monitorMode = 'manual';
    state.transport = transport;
    state.elm = elm;
  } catch (err) {
    traffic.add('note', `Connection failed: ${err.code ?? 'error'}: ${err.message}`);
    transport.onDisconnect = () => {};
    await transport.close();
    ui.setConnection('idle', t('app.conn.notConnected'));
    if (err.code === 'CANCELLED') {
      bob.say({ text: t('app.conn.cancelled') });
    } else if (err.rates) {
      showBaudRetry(transport, err);
    } else {
      showConnectError(err, protocol);
    }
    return;
  }

  transport.onDisconnect = async () => {
    await disconnect();
    bob.say({
      tone: 'high',
      mood: 'warning',
      text: state.recording ? t('app.conn.adapterLostRecording') : t('app.conn.adapterLost'),
    });
  };
  ui.setWelcomeVisible(false);
  showConnected();
  console.info('[WOBD] Connected. Baud rate:', state.baudRate ?? 'unknown (detection skipped)');
  renderConnInfo(state.connInfo, { baudRate: state.baudRate });
  bobIdle();
  if (!state.supportedPids) bob.say(FALLBACK_LINE);
  if (state.tab === 'live') showLive();  // the picker's intro mentions the fallback too
  if (isLowBattery(state.connInfo)) bob.say({ tone: 'medium', mood: 'warning', text: FRIENDLY.lowBattery });
  // Demo cars carry made-up VINs that must never be sent anywhere.
  if (!(transport instanceof DemoTransport)) offerVehicleMatch(state.vin, state.vinStatus);
}

// A car the user confirmed earlier fills the form on the next visit. Only year, make, and model are kept.
function restoreSavedCar() {
  const saved = loadSavedVehicle();
  if (!saved) return;
  ui.setCar(saved);
  ui.showForgetCar(true, () => { forgetVehicle(); ui.showForgetCar(false); });
}

// Fire-and-forget after connecting, so a missing, malformed, or slow VIN never delays the scanner.
// The VIN only leaves the device after the user agrees, every time; any failure leaves the lists as they are.
async function offerVehicleMatch(vin, status) {
  const typed = ui.getCar();
  if (typed.year && typed.make && typed.model) return;
  if (!vin) {
    if (status === 'malformed' || status === 'conflict') {
      bob.say({ tone: 'unknown', mood: 'question', text: t('app.vin.untrusted') });
    }
    return;
  }
  try {
    if (!await ui.confirmVinLookup()) return;
    const car = await lookupVin(vin);
    if (!car) {
      bob.say({ tone: 'unknown', mood: 'question', text: t('app.vin.notFound') });
      return;
    }
    const { confirmed, remember } = await ui.confirmVehicleMatch(car);
    if (!confirmed) {
      $('car-year')?.focus();
      return;
    }
    ui.setCar(car);
    if (remember) {
      saveVehicle(car);
      ui.showForgetCar(true, () => { forgetVehicle(); ui.showForgetCar(false); });
    }
  } catch (err) {
    console.warn('[WOBD] VIN lookup failed:', err);
    bob.say({ tone: 'unknown', mood: 'question', text: t('app.vin.lookupFailed') });
  }
}

const FALLBACK_LINE = {
  tone: 'unknown',
  mood: 'question',
  get text() { return t('app.live.fallback'); },
};

// Detects the baud rate with a quick ID probe, then resets and configures the adapter once.
// Resolves with the adapter and the rate it answered at (null when detection was skipped).
async function openAdapter(transport, { baudRate, protocol, abort }) {
  let detected = null;
  if (transport instanceof DemoTransport && !(transport instanceof DemoBaudTransport)) {
    await transport.open();
  } else {
    detected = await detect(transport, { baudRate, abort });
  }

  const elm = new ELM327(transport);
  try {
    await elm.reset();
    await elm.configure(protocol ?? '0');
    return { elm, baudRate: detected };
  } catch (err) {
    await transport.close();
    throw err;
  }
}

async function logAdapterProtocol(elm) {
  const readings = {};
  for (const command of ['ATDP', 'ATDPN']) {
    try {
      const [reply = ''] = await elm.send(command);
      readings[command] = reply || '(empty reply)';
    } catch (err) {
      readings[command] = `failed: ${err.message}`;
      console.warn(`[WOBD] ${command} failed while checking protocol after no vehicle response:`, err);
    }
  }
  console.info('[WOBD] Adapter protocol after failed vehicle request:', readings);
}

async function detect(transport, { baudRate, abort }) {
  let latest = null;
  let view = null;
  const timer = setTimeout(() => {
    view = ui.createBaudProgress(() => abort.abort(new ElmError('CANCELLED', 'Cancelled.')));
    if (latest) view.update(latest);
    bob.say({ text: t('app.conn.checkingBaud'), details: [view.el] });
  }, DETECT_PROGRESS_DELAY);

  try {
    const found = await detectBaud(transport, {
      rates: baudRate ? [baudRate] : undefined,
      signal: abort.signal,
      onProgress: (progress) => {
        latest = progress;
        view?.update(progress);
      },
    });
    if (found === null) {
      throw Object.assign(new ElmError('NOT_ELM',
        t('app.conn.noBaudResponse')),
      { rates: rateOptions(transport.info) });
    }
    return found;
  } finally {
    clearTimeout(timer);
    view?.remove();
  }
}

// Offers a manual speed after automatic detection failed. The port stays granted, so Retry reuses it.
function showBaudRetry(transport, err) {
  bob.say({
    tone: 'high',
    mood: 'warning',
    text: err.message,
    details: [ui.baudRetryForm(err.rates, (rate) => {
      if (state.elm) return;
      traffic.begin(`Retrying at ${rate} baud`);
      connectTo(transport, { baudRate: rate, protocol: ui.getProtocolOverride() });
    })],
  });
}

async function disconnect() {
  stopLive();
  picker.hide();
  $('live-dashboard').hidden = false;
  if (state.recording) recordLock.setUnplugged();
  const { transport } = state;
  state.transport = null;
  state.elm = null;
  state.supportedPids = null;
  state.ecuPids = [];
  state.catalog = [];
  ui.renderParameterCatalog([]);
  hideConnInfo();
  await transport?.close();
  ui.setConnection('idle', t('app.conn.notConnected'));
  ui.setControls({ print: Boolean(state.scan) });
  $('record-btn').disabled = true;
  ui.setWelcomeVisible(!state.scan);
}

// "SAE J1850 VPW · 115200 baud", the same wording everywhere the connection is shown.
function connectionLabel() {
  return `${state.protocol?.name ?? t('app.conn.protocolUnknown')} · ${baudLabel(state.baudRate)}`;
}

function showConnected() {
  ui.setConnection('connected', t('app.conn.connected', { connection: connectionLabel() }));
  const hasProblems = Boolean(state.scan && (state.scan.entries.length || state.scan.status?.milOn));
  ui.setControls({ scan: true, print: Boolean(state.scan), clear: hasProblems });
  $('record-btn').disabled = false;
  $('record-raw-label').hidden = !state.undecoded.length;
  $('gauges-btn').disabled = false;
}

// Runs an adapter job with the controls locked.
async function busy(label, job) {
  if (!state.elm || state.busy) return;
  state.busy = true;
  ui.setConnection('busy', label);
  ui.setControls({});
  $('record-btn').disabled = true;
  $('gauges-btn').disabled = true;
  try {
    await job();
  } catch (err) {
    showError(err);
  } finally {
    state.busy = false;
    if (state.elm) showConnected();
  }
}

// ---------- Scan ----------

function buildModules(status, services, knownSources) {
  const sources = new Set([
    ...(status?.ecus ?? []).map((ecu) => ecu.source),
    ...services.flatMap((service) => service.codes.map((entry) => entry.ecuSource)),
    ...knownSources,
  ]);
  sources.delete(null);
  return [...sources].sort().map((source) => {
    const reported = status?.ecus.find((ecu) => ecu.source === source) ?? null;
    return {
      ...obd.ecuIdentity(source),
      milOn: reported ? reported.milOn : null,
      reportedCount: reported ? reported.count : null,
      // null means the service couldn't be read; an empty list means it was read and had no codes.
      dtcs: Object.fromEntries(services.map((service) => [
        service.label.toLowerCase(),
        service.available ? service.codes.filter((entry) => entry.ecuSource === source).map((entry) => entry.code) : null,
      ])),
    };
  });
}

async function scan() {
  bob.say({ text: t('app.scan.hangTight') });
  const { status, services } = await obd.readScan(state.elm, state.protocol.isCan);
  const codes = services.flatMap((service) => service.codes.map((entry) => ({
    ...entry,
    dtcStatus: service.label,
  })));
  const codeTypes = [...new Set(codes.map((entry) => entry.code))];
  await loadGenericCodes(codeTypes);
  const entries = codes.map((entry) => ({
    ...lookup(entry.code),
    dtcStatus: entry.dtcStatus,
    ecuSource: entry.ecuSource,
    ecuName: entry.ecuSource ? obd.ecuIdentity(entry.ecuSource).name : null,
  }));
  const modules = buildModules(status, services, (state.ecuPids ?? []).map((ecu) => ecu.source));

  // The connection is copied in, so the printout matches the scan even after a reconnect.
  state.scan = { scannedAt: new Date(), status, services, entries, modules, connection: connectionLabel() };
  state.selected = null;
  state.moduleView = 'all';
  showScanResults();
  announceScan(state.scan);
}

// Shows the whole vehicle or one module, depending on the selected tab.
function showScanResults() {
  const { status, services, entries, modules } = state.scan;
  const module = modules.find((m) => m.source === state.moduleView) ?? null;
  if (!module) state.moduleView = 'all';
  ui.renderModuleTabs(modules, state.moduleView, (source) => {
    state.moduleView = source;
    showScanResults();
  });
  const shown = module ? entries.filter((entry) => entry.ecuSource === module.source) : entries;
  ui.renderCodes(shown, onSelectCode);
  if (module) {
    ui.setEmptyMessage(t('app.scan.moduleNoCodes', { module: module.name }));
    ui.setModuleDetail(module);
    ui.setSummary('');
    return;
  }
  ui.setModuleDetail(null);
  ui.setEmptyMessage(services.some((service) => !service.available)
    ? t('app.scan.codesUnavailableIncomplete')
    : t('app.scan.noCodesFound'));
  ui.setSummary([
    status ? t('app.scan.engineLightStatus', { status: t(status.milOn ? 'app.scan.on' : 'app.scan.off') }) : null,
    ...services.map((service) => t('app.scan.serviceSummary', { label: service.label, count: service.available ? formatNumber(service.codes.length) : t('app.ui.unavailable') })),
    modules.length > 1 ? t('app.scan.moduleCount', { count: formatNumber(modules.length) }) : null,
    ui.carLabel(ui.getCar()) || null,
  ].filter(Boolean).join(' · '));
}

function announceScan({ status, services, entries }) {
  const unavailable = services.filter((service) => !service.available).map((service) => service.label.toLowerCase());
  if (entries.length) {
    bob.say({
      text: pluralText('app.scan.foundCodes', entries.length),
    });
  } else if (status?.milOn) {
    bob.say({
      tone: 'unknown',
      mood: 'question',
      text: unavailable.length
        ? t(unavailable.length === 1 ? 'app.scan.engineLightNoCodesIncompleteOne' : 'app.scan.engineLightNoCodesIncompleteMany', { services: unavailable.join(', ') })
        : t('app.scan.engineLightNoCodes'),
    });
  } else if (unavailable.length) {
    bob.say({
      tone: 'unknown',
      mood: 'question',
      text: t(unavailable.length === 1 ? 'app.scan.servicesUnreadableOne' : 'app.scan.servicesUnreadableMany', { services: unavailable.join(', ') }),
    });
  } else {
    bob.say({
      tone: 'low',
      mood: 'check',
      text: t('app.scan.noTroubleCodes'),
    });
  }
}

function onSelectCode(entry) {
  state.selected = entry.code;
  ui.selectCode(entry.code);
  bob.explain(entry);
}

function onKeydown(e) {
  if (e.key !== 'Escape' || $('clear-dialog').open || recordLock.isOpen || !bob.isOpen) return;
  const code = state.selected;
  state.selected = null;
  ui.selectCode(null);
  bob.close();
  if (code) ui.focusCode(code);
}

// ---------- Clear codes ----------

async function onClearClick() {
  if (!(await ui.confirmClear())) return;
  await busy(t('app.scan.clearingCodes'), async () => {
    await obd.clearCodes(state.elm);
    await scan();
    const remaining = state.scan?.entries ?? [];
    const permanentCount = remaining.filter((entry) => entry.dtcStatus === 'Permanent').length;
    const unavailable = state.scan?.services.some((service) => !service.available);
    let message;
    if (unavailable && remaining.length) {
      message = pluralText('app.scan.clearRemainingIncomplete', remaining.length);
    } else if (unavailable) {
      message = t('app.scan.clearServicesIncomplete');
    } else if (permanentCount === remaining.length && permanentCount > 0) {
      message = pluralText('app.scan.permanentCodesRemain', permanentCount);
    } else if (remaining.length) {
      message = pluralText('app.scan.codesRemain', remaining.length);
    } else if (state.scan?.status?.milOn) {
      message = t('app.scan.lightStillOn');
    } else {
      message = t('app.scan.codesCleared');
    }
    bob.say({
      tone: remaining.length || unavailable || state.scan?.status?.milOn ? 'unknown' : 'low',
      mood: remaining.length || unavailable || state.scan?.status?.milOn ? 'question' : 'check',
      text: message,
    });
  });
}

// ---------- Print ----------

function renderReport() {
  if (!state.scan) return;
  ui.renderReport({ ...state.scan, car: ui.getCar(), vin: $('print-vin').checked ? state.vin : null });
}

// ---------- Live data ----------

function onTabChange(tab) {
  state.tab = tab;
  bobIdle();
  if (tab === 'live') showLive();
  else stopLive();
}

// The Live data tab: the gauge picker until gauges are picked on this connection, then the dashboard.
function showLive() {
  if (!state.elm) return;
  if (state.gauges) {
    startLive();
    return;
  }
  showPicker(defaultKeys(state.offered));
}

function showPicker(checked, mode = state.monitorMode) {
  stopLive();
  state.lastHint = null;
  $('live-dashboard').hidden = true;
  picker.show({
    offered: state.offered,
    undecoded: state.undecoded,
    catalog: state.catalog,
    checked,
    mode,
    timing: state.requestMs
      ? { requestMs: state.requestMs, measured: true }
      : { requestMs: state.protocol?.isCan ? 50 : 150, measured: false },  // a guess until measured
  });
  if (!state.pickerIntroDone) {
    state.pickerIntroDone = true;
    bob.say(state.supportedPids ? {
      tone: 'low',
      mood: 'check',
      text: t('app.live.pickerIntro'),
    } : {
      ...FALLBACK_LINE,
      text: t('app.live.pickerFallbackIntro', { fallback: FALLBACK_LINE.text }),
    });
  }
}

function applyGauges(defs, mode) {
  state.gauges = defs;
  state.monitorMode = mode;
  const selectedPids = new Set(defs.map((def) => def.pid).filter((pid) => pid !== undefined));
  for (const entry of state.catalog) {
    if (entry.monitorable) entry.availability = selectedPids.has(entry.pid) ? 'Waiting for reading' : 'Not selected';
    ui.updateParameterCatalog(entry);
  }
  picker.hide();
  ui.renderGauges(defs);
  $('live-dashboard').hidden = false;
  bobIdle();
  startLive();
}

// Back to the picker with today's choices ticked. Not while recording: the
// recording logs whatever the dashboard polls.
function changeGauges() {
  if (!state.elm || state.busy || state.recording) return;
  showPicker(new Set(state.gauges.map((def) => def.key)), state.monitorMode);
}

// Pointing at a preset makes Bob explain it; the same preset twice in a row
// doesn't restart his bubble.
function presetHint(preset) {
  if (!picker.isOpen || state.lastHint === preset.id) return;
  state.lastHint = preset.id;
  bob.say(PRESET_LINES[preset.id]());
}

async function startLive() {
  if (!state.elm || state.tab !== 'live' || !state.gauges) return;
  const run = ++state.liveRun;
  const { elm } = state;
  const active = () => run === state.liveRun && state.elm === elm;
  const defs = state.gauges.filter((def) => def.pid !== undefined);
  const battery = state.gauges.includes(obd.BATTERY);

  // One command at a time: each read waits for the last one. Slow-changing
  // values are only polled every few rounds so the fast gauges stay lively.
  for (let round = 0; active(); round++) {
    const roundStart = performance.now();
    const slowRound = round % obd.SLOW_EVERY === 0;
    for (const def of defs) {
      if (round % obd.pollingInterval(def, state.monitorMode) !== 0) continue;
      if (!active()) return;
      const started = performance.now();
      const result = await obd.readPidDetailed(elm, def)
        .catch(() => ({ value: null, raw: null, extras: [], failure: 'no-response' }));
      // Answered reads keep the picker's refresh estimate honest for this car.
      if (result.raw !== null) state.requestMs = 0.8 * (state.requestMs ?? 0) + 0.2 * (performance.now() - started);
      reading(def, result.value, result);
    }
    state.recording?.budget.note('gauge', performance.now() - roundStart);
    await sampleRaw(elm, round, active);
    if (!active()) return;
    if (battery && slowRound) reading(obd.BATTERY, await obd.readBatteryVoltage(elm).catch(() => null));
    await wait(obd.ROUND_PAUSE_MS);
  }
}

// Opt-in raw capture while recording: one undecoded parameter now and then, saved as raw bytes only.
// Regular gauges come first; the cadence follows the car's speed and a time budget keeps this small.
async function sampleRaw(elm, round, active) {
  const rec = state.recording;
  if (!rec?.rawPids.length || !active()) return;
  const { lock } = rec;
  const speedValid = lock.speed !== null && Date.now() - lock.speedAt < SPEED_FRESH_MS;
  const { band, every } = rawEvery(lock.speed, speedValid, rec.rawBand);
  rec.rawBand = band;
  if (round % every !== 0 || !rec.budget.allows(band)) return;
  const pid = rec.rawPids[rec.rawCursor++ % rec.rawPids.length];
  const started = performance.now();
  const replies = await obd.readRawPid(elm, pid).catch(() => []);
  rec.budget.note('raw', performance.now() - started);
  const now = Date.now();
  for (const { raw, ecu } of replies) {
    const row = rec.data.add({ pid, label: undecodedName(pid) }, null, now, raw, ecu);
    if (row) rec.backup?.add(Recording.store(row), now);
  }
}

function undecodedName(pid) {
  return state.undecoded.find((item) => item.pid === pid)?.name ?? obd.UNNAMED_PID;
}

function stopLive() {
  state.liveRun++;
}

// Every live reading lands here: the gauge always, the recording when one is running.
function reading(def, value, { raw = null, ecu = null, failure = null, extras = [] } = {}) {
  ui.updateGauge(def, value);
  const now = Date.now();
  if (def.pid === undefined) {
    ui.updateParameterCatalog({
      pid: null,
      availability: value == null ? 'Temporarily not responding' : 'Available',
      lastSuccessfulReading: value,
      lastUpdatedAt: value == null ? null : now,
      digits: def.digits,
      unit: def.unit,
    });
  } else {
    const entry = state.catalog.find((item) => item.pid === def.pid);
    if (entry) {
      const reason = failure ? obd.FAILURE_REASONS[failure] : null;
      entry.statusNote = value == null ? reason?.text ?? null : null;
      entry.availability = value == null
        ? reason && failure !== 'no-response' ? `No usable reading · ${reason.short}`
          : entry.supportKnown ? 'Temporarily not responding' : 'No response · support unknown'
        : 'Available';
      if (value != null) {
        entry.lastSuccessfulReading = value;
        entry.lastUpdatedAt = now;
      }
      ui.updateParameterCatalog(entry);
    }
  }
  if (!state.recording) return;
  const { data, backup: copy } = state.recording;
  const keep = (row) => { if (row && copy) copy.add(Recording.store(row), now); };
  keep(data.add(def, value, now, raw, ecu));
  for (const extra of extras) keep(data.add(extra.def, extra.value, now, null, ecu));
  state.recording.lock.update(def, value, now);
}

// ---------- Recording ----------

// Records whatever the live loop already polls, plus undecoded parameters (raw bytes only) when opted in.
function startRecording() {
  if (!state.elm || state.busy || state.recording || state.tab !== 'live' || !state.gauges) return;
  // The driving lock only unlocks once Speed shows the car has stopped, so a
  // car that has Speed must have it on the dashboard to record.
  const watching = (key) => state.gauges.some((def) => def.key === key);
  if (state.offered.some((def) => def.key === 'speed') && !watching('speed')) {
    bob.say({
      tone: 'medium',
      mood: 'warning',
      text: t('app.live.needSpeed'),
    });
    return;
  }
  const now = Date.now();
  state.recording = {
    data: new Recording(now, { protocol: state.protocol?.name, baudRate: state.baudRate }),
    rawPids: rawOptIn.enabled ? state.undecoded.map((item) => item.pid) : [],
    rawBand: null,
    rawCursor: 0,
    budget: new RawBudget(),
    lock: new DriveLock({
      hasSpeed: watching('speed'),
      hasRpm: watching('rpm'),
      hasPids: state.gauges.some((def) => def.pid !== undefined),
    }, now),
  };
  state.recording.backup = backup.start(state.recording.data);
  rawOptIn.lock();
  $('record-raw').disabled = true;
  $('record-raw-hint').hidden = false;
  recordLock.open({ startedAt: now, lock: state.recording.lock });
  keepScreenOn();
  bob.say({
    tone: 'medium',
    mood: 'warning',
    text: t('app.live.recordingStarted'),
  });
}

// Keep Recording after a stop: same log, and the lock starts over as if the car just started.
function keepRecording() {
  state.recording?.lock.reset(Date.now());
}

function saveRecording() {
  const { recording } = state;
  if (!recording) return;
  downloadCsv(recording.data.toCsv(), recording.data.filename());
  state.recording = null;
  backup.finish();
  rawOptIn.unlock();
  $('record-raw').disabled = false;
  $('record-raw-hint').hidden = true;
  recordLock.close();
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  bob.say({
    tone: 'low',
    mood: 'check',
    text: t('app.live.recordingSaved', { filename: recording.data.filename() }),
    details: [Object.assign(document.createElement('a'), { href: 'replay.html', textContent: t('app.live.replayLink') })],
  });
}

function downloadCsv(data, filename, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A sleeping screen can throttle the page and leave gaps in the log. Browsers
// drop the wake lock when the tab is hidden, so this runs again when it's back.
async function keepScreenOn() {
  if (!state.recording || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Not allowed (battery saver, etc.). Recording still works.
  }
}
