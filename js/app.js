// Wires the adapter, OBD requests, Bob, and the UI together and holds app state.
import { SerialTransport, isSerialSupported } from './serial.js';
import { DemoTransport } from './demo.js';
import { ELM327, ElmError } from './elm327.js';
import * as obd from './obd.js';
import { Bob, loadCodeBook, lookup } from './bob.js';
import * as ui from './ui.js';
import { Voice } from './voice.js';

const BAUD_RATES = [38400, 9600, 115200];

const params = new URLSearchParams(location.search);
const demo = params.has('demo') ? params.get('demo') || 'can' : null;

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  transport: null,
  elm: null,
  protocol: null,
  supportedPids: new Set(),
  vin: null,
  scan: null,        // { scannedAt, status, entries }
  selected: null,    // code Bob is explaining
  tab: 'scan',
  busy: false,
  liveRun: 0,        // bumping this stops the live data loop
};

const voice = new Voice();
const bob = new Bob({ slot: $('bob-slot'), live: $('bob-live'), getCar: ui.getCar, voice });

start();

async function start() {
  if (!isSerialSupported() && !demo) {
    ui.showUnsupported();
    return;
  }
  if (demo) ui.showDemoBadge();

  ui.initTabs(onTabChange);
  ui.initVoiceToggle(voice, (on) => {
    voice.setEnabled(on);
    if (on) bob.repeat();  // the click is the user gesture browsers need before speaking
  });
  ui.setConnection('idle', 'Not connected');
  ui.setControls({});
  ui.renderGauges(new Set(obd.LIVE_PIDS.map((d) => d.pid)));

  try {
    const [makes] = await Promise.all([
      fetch('data/makes.json').then((res) => res.json()),
      loadCodeBook(),
    ]);
    ui.initCarForm(makes);
  } catch (err) {
    showError(new Error(`I couldn't load my notes. ${err.message}`));
    return;
  }

  $('connect-btn').addEventListener('click', onConnectClick);
  $('scan-btn').addEventListener('click', () => busy('Scanning…', scan));
  $('clear-btn').addEventListener('click', onClearClick);
  $('print-btn').addEventListener('click', () => window.print());
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
  } else {
    bob.say({
      text: demo
        ? "Hi, I'm Bob! This is demo mode, so a pretend car is hooked up. Click Connect to get started."
        : "Hi, I'm Bob! Plug the adapter into your car and this computer, turn the ignition on, then click Connect.",
    });
  }
}

function showError(err) {
  const text = err instanceof ElmError ? err.message : `Something went wrong: ${err.message}`;
  bob.say({ tone: 'high', mood: 'warning', text });
}

// ---------- Connect ----------

async function onConnectClick() {
  if (state.elm) {
    await disconnect();
    bob.say({ text: "Disconnected. Click Connect when you're ready for another scan." });
    return;
  }

  ui.setConnection('busy', 'Connecting…');
  let transport;
  try {
    transport = demo ? new DemoTransport(demo) : await SerialTransport.request();
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

  bob.say({ text: 'Looking for your adapter…' });
  try {
    const elm = await openAdapter(transport);
    ui.setConnection('busy', 'Talking to the car…');
    bob.say({ text: "Found the adapter. Now I'm saying hello to the car. Older cars can take a few seconds." });

    state.supportedPids = await obd.readSupportedPids(elm);
    state.protocol = await obd.readProtocol(elm);
    state.vin = await obd.readVin(elm);
    state.transport = transport;
    state.elm = elm;
  } catch (err) {
    await transport.close();
    ui.setConnection('idle', 'Not connected');
    showError(err);
    return;
  }

  transport.onDisconnect = async () => {
    await disconnect();
    bob.say({
      tone: 'high',
      mood: 'warning',
      text: 'I lost the adapter. Check that the cable is plugged in, then click Connect.',
    });
  };
  ui.renderGauges(state.supportedPids);
  showConnected();
  bobIdle();
  if (state.tab === 'live') startLive();
}

// Tries each baud rate until an ELM327 answers the reset.
async function openAdapter(transport) {
  for (const baudRate of BAUD_RATES) {
    await transport.open(baudRate);
    const elm = new ELM327(transport);
    try {
      await elm.reset();
      await elm.configure();
      return elm;
    } catch (err) {
      await transport.close();
      if (!(err instanceof ElmError)) throw err;
    }
  }
  throw new ElmError('NOT_ELM',
    "The adapter didn't answer. Make sure it's an ELM327-compatible USB cable, then unplug it, plug it back in, and try again.");
}

async function disconnect() {
  stopLive();
  const { transport } = state;
  state.transport = null;
  state.elm = null;
  await transport?.close();
  ui.setConnection('idle', 'Not connected');
  ui.setControls({ print: Boolean(state.scan) });
}

function showConnected() {
  ui.setConnection('connected', `Connected · ${state.protocol.name}`);
  const hasProblems = Boolean(state.scan && (state.scan.entries.length || state.scan.status?.milOn));
  ui.setControls({ scan: true, print: Boolean(state.scan), clear: hasProblems });
}

// Runs an adapter job with the controls locked.
async function busy(label, job) {
  if (!state.elm || state.busy) return;
  state.busy = true;
  ui.setConnection('busy', label);
  ui.setControls({});
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
  const entries = codes.map(lookup);

  state.scan = { scannedAt: new Date(), status, entries };
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
  if (e.key !== 'Escape' || $('clear-dialog').open || !bob.isOpen) return;
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
  const defs = obd.LIVE_PIDS.filter((def) => state.supportedPids.has(def.pid));

  // One command at a time: each read waits for the last one.
  while (active()) {
    for (const def of defs) {
      if (!active()) return;
      ui.updateGauge(def, await obd.readPid(elm, def).catch(() => null));
    }
    if (!active()) return;
    ui.updateGauge(obd.BATTERY, await obd.readBatteryVoltage(elm).catch(() => null));
    await wait(50);
  }
}

function stopLive() {
  state.liveRun++;
}
