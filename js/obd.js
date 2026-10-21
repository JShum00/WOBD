// OBD-II requests and decoders. Replies are expected with echo, spaces, and
// headers off (see ELM327.configure).
import { ElmError } from './elm327.js';

export const PROTOCOLS = {
  1: 'SAE J1850 PWM',
  2: 'SAE J1850 VPW',
  3: 'ISO 9141-2',
  4: 'ISO 14230-4 KWP (slow init)',
  5: 'ISO 14230-4 KWP (fast init)',
  6: 'CAN 11-bit 500k',
  7: 'CAN 29-bit 500k',
  8: 'CAN 11-bit 250k',
  9: 'CAN 29-bit 250k',
  A: 'SAE J1939 CAN',
  B: 'User CAN 1',
  C: 'User CAN 2',
};

// style picks the gauge look: radial, vbar, hbar, or status (text only).
// warn/danger are the values where a gauge changes color. slow PIDs are
// polled less often so the fast ones refresh quicker. bipolar bars fill
// outward from the middle. Fuel trims show -25..+25 %: the real range is
// -100..+99 %, but healthy trims sit well inside it.
export const LIVE_PIDS = [
  { pid: 0x0C, key: 'rpm', label: 'Engine RPM', unit: 'rpm', style: 'radial', min: 0, max: 7000, digits: 0,
    expectedBytes: 2, priority: 'high', warn: 5500, danger: 6500, decode: ([a, b]) => (a * 256 + b) / 4 },
  { pid: 0x0D, key: 'speed', label: 'Speed', unit: 'mph', style: 'radial', min: 0, max: 120, digits: 0,
    expectedBytes: 1, priority: 'high', decode: ([a]) => a * 0.621371 },
  { pid: 0x11, key: 'throttle', label: 'Throttle', unit: '%', style: 'vbar', min: 0, max: 100, digits: 0,
    expectedBytes: 1, priority: 'high', decode: ([a]) => a * 100 / 255 },
  { pid: 0x04, key: 'load', label: 'Engine load', unit: '%', style: 'vbar', min: 0, max: 100, digits: 0,
    expectedBytes: 1, priority: 'high', decode: ([a]) => a * 100 / 255 },
  { pid: 0x06, key: 'stft', label: 'Short-term fuel trim', unit: '%', style: 'vbar', min: -25, max: 25, digits: 1,
    expectedBytes: 1, priority: 'medium', bipolar: true, warn: 15, danger: 25, decode: ([a]) => (a - 128) * 100 / 128 },
  { pid: 0x07, key: 'ltft', label: 'Long-term fuel trim', unit: '%', style: 'vbar', min: -25, max: 25, digits: 1,
    expectedBytes: 1, bipolar: true, warn: 15, danger: 25, slow: true, decode: ([a]) => (a - 128) * 100 / 128 },
  { pid: 0x05, key: 'coolant', label: 'Coolant temp', unit: '°F', style: 'hbar', min: 100, max: 260, digits: 0,
    expectedBytes: 1, warn: 230, danger: 245, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x0F, key: 'iat', label: 'Intake air temp', unit: '°F', style: 'hbar', min: 0, max: 160, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x10, key: 'maf', label: 'Mass airflow', unit: 'g/s', style: 'hbar', min: 0, max: 250, digits: 1,
    expectedBytes: 2, priority: 'medium', decode: ([a, b]) => (a * 256 + b) / 100 },
  { pid: 0x0B, key: 'map', label: 'Intake manifold pressure', unit: 'kPa', style: 'hbar', min: 0, max: 255, digits: 0,
    expectedBytes: 1, priority: 'high', decode: ([a]) => a },
  { pid: 0x0E, key: 'timing', label: 'Timing advance', unit: '°', style: 'hbar', min: -10, max: 50, digits: 1,
    expectedBytes: 1, priority: 'medium', decode: ([a]) => a / 2 - 64 },
  { pid: 0x14, key: 'o2b1s1', label: 'O2 sensor, bank 1 sensor 1', unit: 'V', style: 'hbar', min: 0, max: 1.2, digits: 2,
    expectedBytes: 2, priority: 'medium', decode: ([a]) => a / 200 },
  { pid: 0x15, key: 'o2b1s2', label: 'O2 sensor, bank 1 sensor 2', unit: 'V', style: 'hbar', min: 0, max: 1.2, digits: 2,
    expectedBytes: 2, priority: 'medium', decode: ([a]) => a / 200 },
  { pid: 0x03, key: 'fuelsys', label: 'Fuel system', style: 'status', slow: true,
    expectedBytes: 2, decode: ([a]) => FUEL_SYSTEM_STATUS[a] ?? null },
  { pid: 0x0A, key: 'fuelpressure', label: 'Fuel pressure', unit: 'kPa', style: 'hbar', min: 0, max: 765, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => a * 3 },
  { pid: 0x21, key: 'mildistance', label: 'Distance with MIL on', unit: 'km', style: 'hbar', min: 0, max: 1000, digits: 0,
    expectedBytes: 2, slow: true, priority: 'low', decode: ([a, b]) => a * 256 + b },
  { pid: 0x23, key: 'railpressure', label: 'Fuel rail pressure', unit: 'kPa', style: 'hbar', min: 0, max: 655350, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => (a * 256 + b) * 10 },
  { pid: 0x31, key: 'cleareddistance', label: 'Distance since codes cleared', unit: 'km', style: 'hbar', min: 0, max: 1000, digits: 0,
    expectedBytes: 2, slow: true, priority: 'low', decode: ([a, b]) => a * 256 + b },
  { pid: 0x3C, key: 'catalystb1s1', label: 'Catalyst temperature, bank 1 sensor 1', unit: '°F', style: 'hbar', min: 0, max: 1800, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => ((a * 256 + b) / 10 - 40) * 9 / 5 + 32 },
  { pid: 0x3D, key: 'catalystb2s1', label: 'Catalyst temperature, bank 2 sensor 1', unit: '°F', style: 'hbar', min: 0, max: 1800, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => ((a * 256 + b) / 10 - 40) * 9 / 5 + 32 },
  { pid: 0x3E, key: 'catalystb1s2', label: 'Catalyst temperature, bank 1 sensor 2', unit: '°F', style: 'hbar', min: 0, max: 1800, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => ((a * 256 + b) / 10 - 40) * 9 / 5 + 32 },
  { pid: 0x3F, key: 'catalystb2s2', label: 'Catalyst temperature, bank 2 sensor 2', unit: '°F', style: 'hbar', min: 0, max: 1800, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => ((a * 256 + b) / 10 - 40) * 9 / 5 + 32 },
  { pid: 0x42, key: 'modulevoltage', label: 'Control module voltage', unit: 'V', style: 'hbar', min: 0, max: 20, digits: 2,
    expectedBytes: 2, slow: true, decode: ([a, b]) => (a * 256 + b) / 1000 },
  { pid: 0x44, key: 'equivratio', label: 'Commanded equivalence ratio', unit: 'ratio', style: 'hbar', min: 0, max: 2, digits: 3,
    expectedBytes: 2, slow: true, decode: ([a, b]) => (a * 256 + b) * 2 / 65536 },
  { pid: 0x46, key: 'ambienttemp', label: 'Ambient air temp', unit: '°F', style: 'hbar', min: -40, max: 160, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x5C, key: 'oiltemp', label: 'Engine oil temp', unit: '°F', style: 'hbar', min: 0, max: 300, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
];

// PID 03 reports one bit per state; only one is ever set per bank.
const FUEL_SYSTEM_STATUS = {
  0x01: 'Open loop · engine warming up',
  0x02: 'Closed loop',
  0x04: 'Open loop · load or coasting',
  0x08: 'Open loop · system fault',
  0x10: 'Closed loop · sensor fault',
};

export const BATTERY = { key: 'battery', label: 'Battery', unit: 'V', style: 'hbar', min: 10, max: 15, digits: 1,
  slow: true };

// Live loop timing: slow PIDs are read every SLOW_EVERY rounds, with a short
// pause after each round. The picker's refresh estimate uses the same numbers.
export const SLOW_EVERY = 5;
export const ROUND_PAUSE_MS = 50;
export const AUTO_POLL_INTERVALS = { high: 1, medium: 3, low: 8 };

export function pollingInterval(def, mode) {
  if (mode !== 'automatic') return def.slow ? SLOW_EVERY : 1;
  const priority = def.priority ?? (def.slow ? 'low' : 'medium');
  return AUTO_POLL_INTERVALS[priority];
}

// The gauges the dashboard showed before the picker existed: every decoder plus battery.
export const DEFAULT_GAUGES = [
  'rpm', 'speed', 'throttle', 'load', 'stft', 'ltft', 'coolant', 'iat',
  'maf', 'map', 'timing', 'o2b1s1', 'o2b1s2', 'fuelsys', BATTERY.key,
];

// Picker presets, by gauge key. keys: null means every gauge this car offers.
export const PRESETS = [
  { id: 'basics', label: 'Basics', keys: ['rpm', 'speed', 'coolant', 'throttle', 'battery'] },
  { id: 'fuel', label: 'Fuel diagnosis', keys: ['stft', 'ltft', 'o2b1s1', 'o2b1s2', 'map', 'iat', 'coolant', 'fuelsys', 'load'] },
  { id: 'all', label: 'Select all', keys: null },
];

// Standard Mode 01 names (SAE J1979), so a supported PID WOBD can't decode yet
// still gets a readable name in the picker.
export const PID_NAMES = {
  0x01: 'Monitor status', 0x02: 'Freeze frame code', 0x08: 'Short-term fuel trim, bank 2',
  0x09: 'Long-term fuel trim, bank 2', 0x0A: 'Fuel pressure', 0x12: 'Secondary air status',
  0x13: 'O2 sensors present', 0x16: 'O2 sensor, bank 1 sensor 3', 0x17: 'O2 sensor, bank 1 sensor 4',
  0x18: 'O2 sensor, bank 2 sensor 1', 0x19: 'O2 sensor, bank 2 sensor 2', 0x1A: 'O2 sensor, bank 2 sensor 3',
  0x1B: 'O2 sensor, bank 2 sensor 4', 0x1C: 'OBD standard', 0x1D: 'O2 sensors present (4 banks)',
  0x1E: 'Auxiliary input status', 0x1F: 'Run time since engine start', 0x21: 'Distance with check engine light on',
  0x22: 'Fuel rail pressure (vacuum)', 0x23: 'Fuel rail pressure', 0x2C: 'Commanded EGR', 0x2D: 'EGR error',
  0x2E: 'Commanded evaporative purge', 0x2F: 'Fuel tank level', 0x30: 'Warm-ups since codes cleared',
  0x31: 'Distance since codes cleared', 0x32: 'Evap system vapor pressure', 0x33: 'Barometric pressure',
  0x3C: 'Catalyst temperature, bank 1 sensor 1', 0x3D: 'Catalyst temperature, bank 2 sensor 1',
  0x3E: 'Catalyst temperature, bank 1 sensor 2', 0x3F: 'Catalyst temperature, bank 2 sensor 2',
  0x41: 'Monitor status this drive cycle', 0x42: 'Control module voltage', 0x43: 'Absolute load',
  0x44: 'Commanded air-fuel ratio', 0x45: 'Relative throttle position', 0x46: 'Ambient air temperature',
  0x47: 'Throttle position B', 0x49: 'Accelerator pedal position D', 0x4A: 'Accelerator pedal position E',
  0x4C: 'Commanded throttle actuator', 0x4D: 'Time run with check engine light on', 0x4E: 'Time since codes cleared',
  0x51: 'Fuel type', 0x52: 'Ethanol fuel %', 0x5A: 'Relative accelerator pedal position',
  0x5B: 'Hybrid battery remaining life', 0x5C: 'Engine oil temperature', 0x5E: 'Engine fuel rate',
};

const NON_LIVE_DECODERS = [
  { pid: 0x1C, key: 'obdstandard', label: 'OBD standards compliance', expectedBytes: 1,
    category: 'Diagnostic information', monitorable: false, decode: ([a]) => a },
];

export const MODE01_DECODERS = new Map([
  ...LIVE_PIDS.map((def) => [def.pid, def]),
  ...NON_LIVE_DECODERS.map((def) => [def.pid, def]),
]);

const PID_CATEGORIES = new Map([
  [0x03, 'Fuel and air management'], [0x04, 'Engine performance'], [0x05, 'Temperature'],
  [0x06, 'Fuel and air management'], [0x07, 'Fuel and air management'], [0x0A, 'Fuel and air management'],
  [0x0B, 'Fuel and air management'], [0x0C, 'Engine performance'], [0x0D, 'Vehicle speed and distance'],
  [0x0E, 'Ignition and timing'], [0x0F, 'Temperature'], [0x10, 'Fuel and air management'],
  [0x11, 'Engine performance'], [0x14, 'Oxygen sensors'], [0x15, 'Oxygen sensors'],
  [0x1C, 'Diagnostic information'], [0x21, 'Vehicle speed and distance'],
  [0x23, 'Fuel and air management'], [0x31, 'Vehicle speed and distance'],
  [0x3C, 'Emissions'], [0x3D, 'Emissions'], [0x3E, 'Emissions'], [0x3F, 'Emissions'],
  [0x42, 'Electrical system'], [0x44, 'Fuel and air management'], [0x46, 'Temperature'], [0x5C, 'Temperature'],
]);

const PID_DESCRIPTIONS = new Map([
  [0x1C, 'Identifies the OBD standard the vehicle reports complying with.'],
  [0x21, 'Distance traveled while the malfunction indicator lamp was on.'],
  [0x31, 'Distance traveled since diagnostic trouble codes were cleared.'],
  [0x42, 'Voltage reported by the control module; distinct from adapter voltage.'],
  [0x23, 'Fuel rail pressure reported by the control module.'],
]);

export function buildPidCatalog(supported, ecus = []) {
  const sources = new Map();
  for (const ecu of ecus) {
    for (const pid of ecu.pids) {
      if (!sources.has(pid)) sources.set(pid, []);
      if (ecu.source && !sources.get(pid).includes(ecu.source)) sources.get(pid).push(ecu.source);
    }
  }
  return [...supported].sort((a, b) => a - b).map((pid) => {
    const def = MODE01_DECODERS.get(pid);
    const name = def?.label ?? PID_NAMES[pid] ?? 'Unknown standard OBD-II parameter';
    return {
      pid,
      name,
      description: PID_DESCRIPTIONS.get(pid) ?? name,
      category: def?.category ?? PID_CATEGORIES.get(pid) ?? 'Supported but undecoded',
      unit: def?.unit ?? null,
      expectedBytes: def?.expectedBytes ?? null,
      decoderAvailable: Boolean(def),
      monitorable: Boolean(def && def.monitorable !== false && def.style),
      priority: def?.priority ?? (def?.slow ? 'low' : 'medium'),
      ecuSources: sources.get(pid) ?? [],
      decoder: def ?? null,
      availability: !def ? 'Supported · decoder unavailable'
        : def.monitorable === false || !def.style ? 'Decoded · not a live reading' : 'Not selected',
      lastSuccessfulReading: null,
      lastUpdatedAt: null,
    };
  });
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// ---------- Decoders ----------

// "A6" (auto-picked protocol 6) or "6" -> { number, name, isCan }
export function parseProtocol(reply) {
  const number = reply.trim().toUpperCase().slice(-1);
  return { number, name: PROTOCOLS[number] ?? 'Unknown protocol', isCan: /^[6-9A-C]$/.test(number) };
}

function toBytes(hex) {
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

// Turns reply lines into messages (byte arrays), one per responding ECU line.
// CAN multi-frame replies arrive as a length line ("014") followed by
// numbered frames ("0:...", "1:...") and are joined back into one message.
export function toMessages(lines) {
  const messages = [];
  let multi = null;
  const headerMulti = new Map();
  const addMessage = (bytes, ecuSource = null) => {
    const message = bytes;
    if (ecuSource) Object.defineProperty(message, 'ecuSource', { value: ecuSource });
    messages.push(message);
  };
  const flush = () => {
    if (!multi) return;
    addMessage(multi.length ? multi.bytes.slice(0, multi.length) : multi.bytes, multi.ecuSource);
    multi = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, '').toUpperCase();
    const frame = /^[0-9A-F]:([0-9A-F]+)$/.exec(line);
    const canHeader = /^(7E[0-9A-F]|18DAF1[0-9A-F]{2})([0-9A-F]{2})([0-9A-F]*)$/.exec(line);
    const legacy = /^([0-9A-F]{6})((?:41[0-9A-F]{2}|43|44|47|4A|49[0-9A-F]{2})[0-9A-F]*)$/.exec(line);
    if (/^[0-9A-F]{3}$/.test(line)) {
      flush();
      multi = { length: parseInt(line, 16), bytes: [] };
    } else if (canHeader) {
      flush();
      const [, source, pciHex, payloadHex] = canHeader;
      const pci = parseInt(pciHex, 16);
      const frameType = pci >> 4;
      if (frameType === 0) {
        addMessage(toBytes(payloadHex).slice(0, pci & 0x0F), source);
      } else if (frameType === 1 && payloadHex.length >= 2) {
        const length = ((pci & 0x0F) << 8) | parseInt(payloadHex.slice(0, 2), 16);
        headerMulti.set(source, { length, bytes: toBytes(payloadHex.slice(2)), nextSequence: 1 });
      } else if (frameType === 2) {
        const current = headerMulti.get(source);
        const sequence = pci & 0x0F;
        if (current && sequence === current.nextSequence) {
          current.bytes.push(...toBytes(payloadHex));
          current.nextSequence = (current.nextSequence + 1) & 0x0F;
          if (current.bytes.length >= current.length) {
            addMessage(current.bytes.slice(0, current.length), source);
            headerMulti.delete(source);
          }
        }
      }
    } else if (frame) {
      multi ??= { length: 0, bytes: [] };
      multi.bytes.push(...toBytes(frame[1]));
    } else if (legacy) {
      flush();
      addMessage(toBytes(legacy[2]), legacy[1]);
    } else if (/^([0-9A-F]{2})+$/.test(line)) {
      flush();
      addMessage(toBytes(line));
    }
  }
  flush();
  return messages;
}

function findReply(messages, mode, pid) {
  return messages.find((m) => m[0] === mode + 0x40 && (pid === undefined || m[1] === pid));
}

// Two bytes -> "P0420". The top 2 bits pick the letter, the next 2 bits are
// the first digit (0-3), and the last 12 bits are three hex digits.
export function dtcToString(a, b) {
  const letter = 'PCBU'[a >> 6];
  return letter + ((a >> 4) & 0x3) + hex2(a & 0x0F).slice(1) + hex2(b);
}

// Mode 03/07/0A replies. CAN puts a code count after the positive service;
// older protocols send code pairs padded with 0000.
export function decodeDtcEntries(messages, isCan, service = 0x03) {
  const positiveService = service + 0x40;
  const entries = [];
  for (const m of messages) {
    if (m[0] !== positiveService) continue;
    let data = m.slice(1);
    if (isCan) {
      const count = data[0];
      if (!Number.isInteger(count) || data.length !== 1 + count * 2) {
        throw new ElmError('MALFORMED_RESPONSE', `Mode ${hex2(service)} returned an invalid DTC count or payload length.`);
      }
      data = data.slice(1);
    }
    if (data.length % 2 !== 0) {
      throw new ElmError('MALFORMED_RESPONSE', `Mode ${hex2(service)} returned an incomplete DTC.`);
    }
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      const code = dtcToString(data[i], data[i + 1]);
      const ecuSource = m.ecuSource ?? null;
      if (!entries.some((entry) => entry.code === code && entry.ecuSource === ecuSource)) {
        entries.push({ code, ecuSource });
      }
    }
  }
  return entries;
}

export function decodeDtcs(messages, isCan, service = 0x03) {
  return [...new Set(decodeDtcEntries(messages, isCan, service).map(({ code }) => code))];
}

// Mode 01 PID 00, 20, 40, ...: a 4-byte bitmap of which of the next 32 PIDs the
// car supports. Byte A bit 7 is base+1, byte D bit 0 is base+0x20 (which also
// means "ask about the next 32"). Every ECU's reply is OR'd together. Short or
// garbled lines are skipped; valid is false when no ECU sent a full reply.
export function decodeSupportedPids(messages, base = 0x00) {
  const pids = new Set();
  let valid = false;
  for (const m of messages) {
    if (m[0] !== 0x41 || m[1] !== base || m.length !== 6) continue;
    valid = true;
    m.slice(2, 6).forEach((byte, i) => {
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) pids.add(base + i * 8 + bit + 1);
      }
    });
  }
  return { pids, valid };
}

// The bitmap PIDs themselves. They only describe other PIDs, so they're never gauges.
export const isChainPid = (pid) => pid % 0x20 === 0;

// Mode 01 PID 01: check engine light and stored code count.
export function decodeStatus(messages) {
  const m = findReply(messages, 0x01, 0x01);
  if (!m) return null;
  return { milOn: Boolean(m[2] & 0x80), count: m[2] & 0x7F };
}

// Mode 09 PID 02. CAN sends one long message; older protocols send five
// numbered messages of four bytes each.
export function decodeVin(messages) {
  const parts = messages.filter((m) => m[0] === 0x49 && m[1] === 0x02);
  if (!parts.length) return null;
  const bytes = parts.sort((a, b) => a[2] - b[2]).flatMap((m) => m.slice(3));
  const vin = String.fromCharCode(...bytes).replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return vin.length >= 17 ? vin.slice(-17) : null;
}

// ---------- Requests ----------

// Asks 0100, then follows the chain (0120, 0140, ...) while any ECU sets the
// "more" bit. The first request also makes the adapter search for the car's
// protocol, which can take several seconds on older cars.
// Resolves with a vehicle-wide PID Set, raw replies, and separate ECU maps when
// headers are available. Resolves null when the car won't report support;
// UNABLE TO CONNECT still throws because no car is talking.
export async function readSupportedPids(elm, { headers = false } = {}) {
  if (!headers) return discoverSupportedPids(elm);

  let spacingEnabled = false;
  let headersEnabled = false;
  try {
    await elm.send('ATS1');
    spacingEnabled = true;
    await elm.send('ATH1');
    headersEnabled = true;
  } catch (err) {
    if (err.code !== 'COMMAND_ERROR') throw err;
    if (spacingEnabled) await elm.send('ATS0');
    console.warn('[WOBD] ECU headers unavailable during PID discovery:', err);
    return discoverSupportedPids(elm);
  }

  try {
    return await discoverSupportedPids(elm);
  } finally {
    if (headersEnabled) await elm.send('ATH0');
    if (spacingEnabled) await elm.send('ATS0');
  }
}

async function discoverSupportedPids(elm) {
  const pids = new Set();
  const replies = [];
  const byEcu = new Map();
  for (let base = 0x00; base <= 0xE0; base += 0x20) {
    let lines;
    try {
      lines = await elm.send(`01${hex2(base)}`, base === 0 ? 20000 : undefined);
    } catch (err) {
      if (base === 0 && err.code === 'UNABLE_TO_CONNECT') throw err;
      if (base === 0) return null;
      break;  // a later page failing just ends the chain
    }
    const messages = toMessages(lines);
    const page = decodeSupportedPids(messages, base);
    if (!page.valid) {
      if (base === 0) return null;
      break;
    }
    replies.push(`01${hex2(base)}: ${lines.join(' | ')}`);
    page.pids.forEach((pid) => pids.add(pid));
    for (const message of messages) {
      if (message[0] !== 0x41 || message[1] !== base || message.length !== 6) continue;
      const source = message.ecuSource ?? null;
      const key = source ?? '';
      if (!byEcu.has(key)) byEcu.set(key, { source, pids: new Set() });
      const ecuPids = byEcu.get(key).pids;
      message.slice(2, 6).forEach((byte, i) => {
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (0x80 >> bit)) ecuPids.add(base + i * 8 + bit + 1);
        }
      });
    }
    if (!page.pids.has(base + 0x20)) break;
  }
  for (const pid of pids) if (isChainPid(pid)) pids.delete(pid);
  const ecus = [...byEcu.values()].map((ecu) => {
    for (const pid of ecu.pids) if (isChainPid(pid)) ecu.pids.delete(pid);
    return ecu;
  });
  return { pids, replies, ecus };
}

export async function readProtocol(elm) {
  const [reply = ''] = await elm.send('ATDPN');
  return parseProtocol(reply);
}

export async function readStatus(elm) {
  return decodeStatus(toMessages(await elm.send('0101')));
}

export async function readStoredCodes(elm, isCan) {
  try {
    return decodeDtcs(toMessages(await elm.send('03', 8000)), isCan);
  } catch (err) {
    if (err.code === 'NO_DATA') return [];
    throw err;
  }
}

export async function readDtcServices(elm, isCan) {
  let spacingEnabled = false;
  let headersEnabled = false;
  try {
    await elm.send('ATS1');
    spacingEnabled = true;
    await elm.send('ATH1');
    headersEnabled = true;
  } catch (err) {
    if (err.code !== 'COMMAND_ERROR') throw err;
    if (spacingEnabled) await elm.send('ATS0');
    console.warn('[WOBD] ECU headers unavailable during DTC scan:', err);
    return queryDtcServices(elm, isCan);
  }

  try {
    return await queryDtcServices(elm, isCan);
  } finally {
    if (headersEnabled) await elm.send('ATH0');
    if (spacingEnabled) await elm.send('ATS0');
  }
}

async function queryDtcServices(elm, isCan) {
  const services = [];
  for (const service of [0x03, 0x07, 0x0A]) {
    const label = { 0x03: 'Stored', 0x07: 'Pending', 0x0A: 'Permanent' }[service];
    let lines;
    try {
      lines = await elm.send(hex2(service), 8000);
    } catch (err) {
      if (err.code === 'NO_DATA' || err.code === 'COMMAND_ERROR') {
        services.push({ service, label, available: false, codes: [] });
        continue;
      }
      throw err;
    }
    const messages = toMessages(lines);
    if (!messages.some((message) => message[0] === service + 0x40)) {
      throw new ElmError('MALFORMED_RESPONSE', `Mode ${hex2(service)} did not return its expected positive response.`);
    }
    services.push({
      service,
      label,
      available: true,
      codes: decodeDtcEntries(messages, isCan, service),
    });
  }
  return services;
}

// Many pre-2005 cars don't report a VIN, so this returns null rather than failing.
export async function readVin(elm) {
  try {
    return decodeVin(toMessages(await elm.send('0902', 8000)));
  } catch (err) {
    if (err.code === 'NO_DATA' || err.code === 'COMMAND_ERROR') return null;
    throw err;
  }
}

export async function readPid(elm, def) {
  const messages = toMessages(await elm.send(`01${hex2(def.pid)}`));
  const m = findReply(messages, 0x01, def.pid);
  if (!m) return null;
  if (m.length !== def.expectedBytes + 2) {
    throw new ElmError('MALFORMED_RESPONSE',
      `PID 0x${hex2(def.pid)} returned ${Math.max(0, m.length - 2)} data bytes; expected ${def.expectedBytes}.`);
  }
  const value = def.decode(m.slice(2));
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ElmError('MALFORMED_RESPONSE', `PID 0x${hex2(def.pid)} returned an invalid numeric value.`);
  }
  return value;
}

// The gauges this car can show, in display order. Battery comes from the adapter,
// not the car, so it is always offered.
export function gaugeDefs(supported) {
  return [...LIVE_PIDS.filter((def) => supported.has(def.pid)), BATTERY];
}

// "0x0F", or "ATRV" for the battery (an adapter command, not a PID).
export function pidLabel(def) {
  return def.pid === undefined ? 'ATRV' : `0x${hex2(def.pid)}`;
}

export async function readBatteryVoltage(elm) {
  const [reply = ''] = await elm.send('ATRV');
  const volts = parseFloat(reply);
  return Number.isFinite(volts) ? volts : null;
}

export async function clearCodes(elm) {
  const messages = toMessages(await elm.send('04', 8000));
  if (!messages.some((m) => m[0] === 0x44)) {
    throw new Error("The car didn't confirm that the codes were cleared.");
  }
}
