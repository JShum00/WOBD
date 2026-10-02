// Wires the adapter, OBD requests, Bob, and the UI together and holds app state.
import { SerialTransport, checkBrowser } from './serial.js';
import { DemoTransport, DemoBaudTransport, BAUD_DEMOS } from './demo.js';
import { ELM327, ElmError } from './elm327.js';
import { abortOnUnplug, detectBaud, rateOptions } from './smartbauder.js';
import * as obd from './obd.js';
import { Bob, loadCodeBook, loadGenericCodes, lookup } from './bob.js';
import * as ui from './ui.js';
import { Voice } from './voice.js';
import { DriveLock, Recording } from './recorder.js';
import { RecordLock } from './record-lock.js';
import { baudLabel, collectConnInfo, friendlyError, hideConnInfo, initConnInfo, isLowBattery, renderConnInfo, FRIENDLY } from './conninfo.js';

const SLOW_EVERY = 5;
const DETECT_PROGRESS_DELAY = 300;  // ms before the baud-rate progress bar appears

const params = new URLSearchParams(location.search);
const demo = params.has('demo') ? params.get('demo') || 'can' : null;
const browser = checkBrowser();

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  transport: null,
  elm: null,
  protocol: null,
  baudRate: null,    // the rate SmartBauder connected at; null when detection didn't run
  supportedPids: new Set(),
  vin: null,
  scan: null,        // { scannedAt, status, entries }
  selected: null,    // code Bob is explaining
  tab: 'scan',
  busy: false,
  liveRun: 0,        // bumping this stops the live data loop
  recording: null,   // { data: Recording, lock: DriveLock } while recording live data
  wakeLock: null,
};

const voice = new Voice();
const bob = new Bob({ slot: $('bob-slot'), live: $('bob-live'), getCar: ui.getCar, voice });
const recordLock = new RecordLock({ onSave: saveRecording, onKeep: keepRecording });

start();

async function start() {
  if (!browser.supported) ui.showBrowserAlert(browser, { demo });
  if (demo) ui.showDemoBadge();
  ui.initWelcome(demo);

  initConnInfo();
  ui.initTabs(onTabChange);
  ui.initVoiceToggle(voice, (on) => {
    voice.setEnabled(on);
    if (on) bob.repeat();  // the click is the user gesture browsers need before speaking
  });
  ui.setConnection('idle', 'Not connected');
  ui.setControls({});
  ui.renderGauges(new Set(obd.LIVE_PIDS.map((d) => d.pid)));  // preview until a car reports what it supports

  try {
    const [makes, models] = await Promise.all([
      fetch('data/makes.json').then((res) => res.json()),
      // The model list is a nicety: without it the model box is plain text.
      fetch('data/models.json').then((res) => res.json()).catch(() => ({})),
      loadCodeBook(),
    ]);
    ui.initCarForm(makes, models);
  } catch (err) {
    showError(new Error(`I couldn't load my notes. ${err.message}`));
    return;
  }

  $('connect-btn').addEventListener('click', onConnectClick);
  $('scan-btn').addEventListener('click', () => busy('Scanning…', scan));
  $('clear-btn').addEventListener('click', onClearClick);
  $('print-btn').addEventListener('click', () => window.print());
  $('record-btn').addEventListener('click', startRecording);
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
        ? 'Only watch live data while parked or from the passenger seat. Driver, eyes on the road!'
        : 'Connect first and I’ll show live numbers here. And only watch them while parked or from the passenger seat.',
    });
  } else if (state.selected) {
    bob.explain(lookup(state.selected));
  } else if (state.scan) {
    announceScan(state.scan);
  } else if (state.elm) {
    bob.say({
      tone: 'low',
      mood: 'check',
      text: 'Connected! Tell me the year, make, and model up top so my search links are more useful, or skip it. Then click Scan.',
    });
  } else if (demo) {
    bob.say({ text: "Hi, I'm Bob! This is demo mode, so a pretend car is hooked up. Click Connect to get started." });
  } else if (!browser.supported) {
    bob.say({
      tone: 'unknown',
      mood: 'question',
      text: `Hi, I'm Bob! ${browser.reason} ${browser.fix} Until then, try one of the demos.`,
    });
  } else {
    bob.say({
      text: "Hi, I'm Bob! You'll need a USB OBD-II adapter. Plug it into your car and this computer, turn the ignition on, then click Connect. No adapter yet? Try a demo.",
    });
  }
}

function showError(err) {
  bob.say({ tone: 'high', mood: 'warning', text: friendlyError(err) });
}

// ---------- Connect ----------

function demoTransport(name) {
  return BAUD_DEMOS.includes(name) ? new DemoBaudTransport(name) : new DemoTransport(name);
}

async function onConnectClick() {
  if (state.elm) {
    await disconnect();
    bob.say({ text: "Disconnected. Click Connect when you're ready for another scan." });
    return;
  }

  ui.setConnection('busy', 'Connecting…');
  let transport;
  try {
    transport = demo ? demoTransport(demo) : await SerialTransport.request();
  } catch (err) {
    ui.setConnection('idle', 'Not connected');
    if (err.name === 'NotFoundError') {
      bob.say({
        tone: 'unknown',
        mood: 'question',
        text: "No adapter picked. If yours isn't in the list, reseat the cable or try another USB port.",
      });
    } else {
      showError(err);
    }
    return;
  }

  await connectTo(transport);
}

// Opens the adapter and says hello to the car. baudRate skips detection (the manual Retry).
async function connectTo(transport, { baudRate } = {}) {
  ui.setConnection('busy', 'Connecting…');
  bob.say({ text: 'Looking for your adapter…' });

  // Unplugging or cancelling stops detection at once.
  const abort = abortOnUnplug(transport);
  try {
    const { elm, baudRate: connectedBaud } = await openAdapter(transport, { baudRate, abort });
    ui.setConnection('busy', 'Talking to the car…');
    bob.say({ text: "Found the adapter. Now I'm saying hello to the car. Older cars can take a few seconds." });

    state.supportedPids = await obd.readSupportedPids(elm);
    state.protocol = await obd.readProtocol(elm);
    state.vin = await obd.readVin(elm);
    state.connInfo = await collectConnInfo(elm);
    state.baudRate = connectedBaud;
    state.transport = transport;
    state.elm = elm;
  } catch (err) {
    transport.onDisconnect = () => {};
    await transport.close();
    ui.setConnection('idle', 'Not connected');
    if (err.code === 'CANCELLED') {
      bob.say({ text: "Cancelled. Click Connect when you're ready to try again." });
    } else if (err.rates) {
      showBaudRetry(transport, err);
    } else {
      showError(err);
    }
    return;
  }

  transport.onDisconnect = async () => {
    await disconnect();
    bob.say({
      tone: 'high',
      mood: 'warning',
      text: state.recording
        ? "I lost the adapter mid-recording, but I kept everything up to that point. Once you're parked, save the CSV, then check the cable."
        : 'I lost the adapter. Check that the cable is plugged in, then click Connect.',
    });
  };
  ui.renderGauges(state.supportedPids);
  ui.setWelcomeVisible(false);
  showConnected();
  console.info('[WOBD] Connected. Baud rate:', state.baudRate ?? 'unknown (detection skipped)');
  renderConnInfo(state.connInfo, { baudRate: state.baudRate });
  bobIdle();
  if (isLowBattery(state.connInfo)) bob.say({ tone: 'medium', mood: 'warning', text: FRIENDLY.lowBattery });
  if (state.tab === 'live') startLive();
}

// Detects the baud rate with a quick ID probe, then resets and configures the adapter once.
// Resolves with the adapter and the rate it answered at (null when detection was skipped).
async function openAdapter(transport, { baudRate, abort }) {
  let detected = null;
  if (transport instanceof DemoTransport && !(transport instanceof DemoBaudTransport)) {
    await transport.open();
  } else {
    detected = await detect(transport, { baudRate, abort });
  }

  const elm = new ELM327(transport);
  try {
    await elm.reset();
    await elm.configure();
    return { elm, baudRate: detected };
  } catch (err) {
    await transport.close();
    throw err;
  }
}

async function detect(transport, { baudRate, abort }) {
  let latest = null;
  let view = null;
  const timer = setTimeout(() => {
    view = ui.createBaudProgress(() => abort.abort(new ElmError('CANCELLED', 'Cancelled.')));
    if (latest) view.update(latest);
    bob.say({ text: 'One second, checking the device baud rate...', details: [view.el] });
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
        "The adapter didn't answer. Make sure it's an ELM327-compatible USB cable, then unplug it, plug it back in, and try again."),
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
      connectTo(transport, { baudRate: rate });
    })],
  });
}

async function disconnect() {
  stopLive();
  if (state.recording) recordLock.setUnplugged();
  const { transport } = state;
  state.transport = null;
  state.elm = null;
  hideConnInfo();
  await transport?.close();
  ui.setConnection('idle', 'Not connected');
  ui.setControls({ print: Boolean(state.scan) });
  $('record-btn').disabled = true;
  ui.setWelcomeVisible(!state.scan);
}

// "SAE J1850 VPW · 115200 baud", the same wording everywhere the connection is shown.
function connectionLabel() {
  return `${state.protocol?.name ?? 'Protocol unknown'} · ${baudLabel(state.baudRate)}`;
}

function showConnected() {
  ui.setConnection('connected', `Connected · ${connectionLabel()}`);
  const hasProblems = Boolean(state.scan && (state.scan.entries.length || state.scan.status?.milOn));
  ui.setControls({ scan: true, print: Boolean(state.scan), clear: hasProblems });
  $('record-btn').disabled = false;
}

// Runs an adapter job with the controls locked.
async function busy(label, job) {
  if (!state.elm || state.busy) return;
  state.busy = true;
  ui.setConnection('busy', label);
  ui.setControls({});
  $('record-btn').disabled = true;
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

async function scan() {
  bob.say({ text: 'Scanning… hang tight.' });
  const status = await obd.readStatus(state.elm);
  const codes = await obd.readStoredCodes(state.elm, state.protocol.isCan);
  await loadGenericCodes(codes);
  const entries = codes.map(lookup);

  // The connection is copied in, so the printout matches the scan even after a reconnect.
  state.scan = { scannedAt: new Date(), status, entries, connection: connectionLabel() };
  state.selected = null;
  ui.renderCodes(entries, onSelectCode);
  ui.setEmptyMessage('No stored trouble codes.');
  ui.setSummary([
    status ? `Check engine light ${status.milOn ? 'ON' : 'off'}` : null,
    `${entries.length} stored code${entries.length === 1 ? '' : 's'}`,
    ui.carLabel(ui.getCar()) || null,
  ].filter(Boolean).join(' · '));
  announceScan(state.scan);
}

function announceScan({ status, entries }) {
  if (entries.length) {
    bob.say({
      text: `I found ${entries.length} code${entries.length === 1 ? '' : 's'}. Click a code and I'll explain it.`,
    });
  } else if (status?.milOn) {
    bob.say({
      tone: 'unknown',
      mood: 'question',
      text: "Your check engine light is on, but no codes are stored yet. The problem may still be pending. Pending codes are coming in a later version of WOBD.",
    });
  } else {
    bob.say({
      tone: 'low',
      mood: 'check',
      text: "👍 Thumbs up! No trouble codes stored. Your car's computer is happy.",
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
  await busy('Clearing codes…', async () => {
    await obd.clearCodes(state.elm);
    await scan();
    bob.say({
      tone: 'low',
      mood: 'check',
      text: "Codes cleared, so the check engine light should be off. If the problem isn't really fixed, the light will come back.",
    });
  });
}

// ---------- Print ----------

function renderReport() {
  if (!state.scan) return;
  ui.renderReport({ ...state.scan, car: ui.getCar(), vin: state.vin });
}

// ---------- Live data ----------

function onTabChange(tab) {
  state.tab = tab;
  if (tab === 'live') startLive();
  else stopLive();
  bobIdle();
}

async function startLive() {
  if (!state.elm || state.tab !== 'live') return;
  const run = ++state.liveRun;
  const { elm } = state;
  const active = () => run === state.liveRun && state.elm === elm;
  const defs = obd.supportedLivePids(state.supportedPids);

  // One command at a time: each read waits for the last one. Slow-changing
  // values are only polled every few rounds so the fast gauges stay lively.
  for (let round = 0; active(); round++) {
    const slowRound = round % SLOW_EVERY === 0;
    for (const def of defs) {
      if (def.slow && !slowRound) continue;
      if (!active()) return;
      reading(def, await obd.readPid(elm, def).catch(() => null));
    }
    if (!active()) return;
    if (slowRound) reading(obd.BATTERY, await obd.readBatteryVoltage(elm).catch(() => null));
    await wait(50);
  }
}

function stopLive() {
  state.liveRun++;
}

// Every live reading lands here: the gauge always, the recording when one is running.
function reading(def, value) {
  ui.updateGauge(def, value);
  if (!state.recording) return;
  const now = Date.now();
  state.recording.data.add(def, value, now);
  state.recording.lock.update(def, value, now);
}

// ---------- Recording ----------

// Records whatever the live loop already polls; it never sends commands of its own.
function startRecording() {
  if (!state.elm || state.busy || state.recording || state.tab !== 'live') return;
  const now = Date.now();
  const has = (pid) => state.supportedPids.has(pid);
  state.recording = {
    data: new Recording(now, { protocol: state.protocol?.name, baudRate: state.baudRate }),
    lock: new DriveLock({
      hasSpeed: has(0x0D),
      hasRpm: has(0x0C),
      hasPids: obd.supportedLivePids(state.supportedPids).length > 0,
    }, now),
  };
  recordLock.open({ startedAt: now, lock: state.recording.lock });
  keepScreenOn();
  bob.say({
    tone: 'medium',
    mood: 'warning',
    text: "Recording! Next time, hit Record before you pull out. Once you're moving, hands off the screen. I've got it from here.",
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
  recordLock.close();
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  bob.say({
    tone: 'low',
    mood: 'check',
    text: `Saved! Your drive is in your Downloads folder as ${recording.data.filename()}. Open it in a spreadsheet to graph it.`,
  });
}

function downloadCsv(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
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
