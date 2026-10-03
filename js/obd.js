// OBD-II requests and decoders. Replies are expected with echo, spaces, and
// headers off (see ELM327.configure).

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
    warn: 5500, danger: 6500, decode: ([a, b]) => (a * 256 + b) / 4 },
  { pid: 0x0D, key: 'speed', label: 'Speed', unit: 'mph', style: 'radial', min: 0, max: 120, digits: 0,
    decode: ([a]) => a * 0.621371 },
  { pid: 0x11, key: 'throttle', label: 'Throttle', unit: '%', style: 'vbar', min: 0, max: 100, digits: 0,
    decode: ([a]) => a * 100 / 255 },
  { pid: 0x04, key: 'load', label: 'Engine load', unit: '%', style: 'vbar', min: 0, max: 100, digits: 0,
    decode: ([a]) => a * 100 / 255 },
  { pid: 0x06, key: 'stft', label: 'Short-term fuel trim', unit: '%', style: 'vbar', min: -25, max: 25, digits: 1,
    bipolar: true, warn: 15, danger: 25, decode: ([a]) => (a - 128) * 100 / 128 },
  { pid: 0x07, key: 'ltft', label: 'Long-term fuel trim', unit: '%', style: 'vbar', min: -25, max: 25, digits: 1,
    bipolar: true, warn: 15, danger: 25, slow: true, decode: ([a]) => (a - 128) * 100 / 128 },
  { pid: 0x05, key: 'coolant', label: 'Coolant temp', unit: '°F', style: 'hbar', min: 100, max: 260, digits: 0,
    warn: 230, danger: 245, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x0F, key: 'iat', label: 'Intake air temp', unit: '°F', style: 'hbar', min: 0, max: 160, digits: 0,
    slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x10, key: 'maf', label: 'Mass airflow', unit: 'g/s', style: 'hbar', min: 0, max: 250, digits: 1,
    decode: ([a, b]) => (a * 256 + b) / 100 },
  { pid: 0x0B, key: 'map', label: 'Intake manifold pressure', unit: 'kPa', style: 'hbar', min: 0, max: 255, digits: 0,
    decode: ([a]) => a },
  { pid: 0x0E, key: 'timing', label: 'Timing advance', unit: '°', style: 'hbar', min: -10, max: 50, digits: 1,
    decode: ([a]) => a / 2 - 64 },
  { pid: 0x14, key: 'o2b1s1', label: 'O2 sensor, bank 1 sensor 1', unit: 'V', style: 'hbar', min: 0, max: 1.2, digits: 2,
    decode: ([a]) => a / 200 },
  { pid: 0x15, key: 'o2b1s2', label: 'O2 sensor, bank 1 sensor 2', unit: 'V', style: 'hbar', min: 0, max: 1.2, digits: 2,
    decode: ([a]) => a / 200 },
  { pid: 0x03, key: 'fuelsys', label: 'Fuel system', style: 'status', slow: true,
    decode: ([a]) => FUEL_SYSTEM_STATUS[a] ?? null },
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

// The gauges the dashboard showed before the picker existed: every decoder plus battery.
export const DEFAULT_GAUGES = [...LIVE_PIDS.map((def) => def.key), BATTERY.key];

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
  const flush = () => {
    if (!multi) return;
    messages.push(multi.length ? multi.bytes.slice(0, multi.length) : multi.bytes);
    multi = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, '').toUpperCase();
    const frame = /^[0-9A-F]:([0-9A-F]+)$/.exec(line);
    if (/^[0-9A-F]{3}$/.test(line)) {
      flush();
      multi = { length: parseInt(line, 16), bytes: [] };
    } else if (frame) {
      multi ??= { length: 0, bytes: [] };
      multi.bytes.push(...toBytes(frame[1]));
    } else if (/^([0-9A-F]{2})+$/.test(line)) {
      flush();
      messages.push(toBytes(line));
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

// Mode 03 replies. CAN puts a code count after the 0x43; older protocols send
// three codes per line padded with 0000.
export function decodeDtcs(messages, isCan) {
  const codes = [];
  for (const m of messages) {
    if (m[0] !== 0x43) continue;
    let data = m.slice(1);
    if (isCan) data = data.slice(1, 1 + data[0] * 2);
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      const code = dtcToString(data[i], data[i + 1]);
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

// Mode 01 PID 00, 20, 40, ...: a 4-byte bitmap of which of the next 32 PIDs the
// car supports. Byte A bit 7 is base+1, byte D bit 0 is base+0x20 (which also
// means "ask about the next 32"). Every ECU's reply is OR'd together. Short or
// garbled lines are skipped; valid is false when no ECU sent a full reply.
export function decodeSupportedPids(messages, base = 0x00) {
  const pids = new Set();
  let valid = false;
  for (const m of messages) {
    if (m[0] !== 0x41 || m[1] !== base || m.length < 6) continue;
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
// Resolves with { pids, replies }, or null when the car won't say what it
// supports (NO DATA, "?", a timeout, or garbage), so the caller can offer the
// usual gauges instead. UNABLE TO CONNECT still throws: then no car is talking.
export async function readSupportedPids(elm) {
  const pids = new Set();
  const replies = [];
  for (let base = 0x00; base <= 0xE0; base += 0x20) {
    let lines;
    try {
      lines = await elm.send(`01${hex2(base)}`, base === 0 ? 20000 : undefined);
    } catch (err) {
      if (base === 0 && err.code === 'UNABLE_TO_CONNECT') throw err;
      if (base === 0) return null;
      break;  // a later page failing just ends the chain
    }
    const page = decodeSupportedPids(toMessages(lines), base);
    if (!page.valid) {
      if (base === 0) return null;
      break;
    }
    replies.push(`01${hex2(base)}: ${lines.join(' | ')}`);
    page.pids.forEach((pid) => pids.add(pid));
    if (!page.pids.has(base + 0x20)) break;
  }
  for (const pid of pids) if (isChainPid(pid)) pids.delete(pid);
  return { pids, replies };
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
  const m = findReply(toMessages(await elm.send(`01${hex2(def.pid)}`)), 0x01, def.pid);
  return m ? def.decode(m.slice(2)) : null;
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
