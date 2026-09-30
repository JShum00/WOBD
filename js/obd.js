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

export const LIVE_PIDS = [
  { pid: 0x0C, key: 'rpm', label: 'Engine RPM', unit: 'rpm', min: 0, max: 7000, digits: 0,
    decode: ([a, b]) => (a * 256 + b) / 4 },
  { pid: 0x0D, key: 'speed', label: 'Speed', unit: 'mph', min: 0, max: 120, digits: 0,
    decode: ([a]) => a * 0.621371 },
  { pid: 0x05, key: 'coolant', label: 'Coolant temp', unit: '°F', min: 100, max: 260, digits: 0,
    decode: ([a]) => (a - 40) * 9 / 5 + 32 },
  { pid: 0x04, key: 'load', label: 'Engine load', unit: '%', min: 0, max: 100, digits: 0,
    decode: ([a]) => a * 100 / 255 },
  { pid: 0x11, key: 'throttle', label: 'Throttle', unit: '%', min: 0, max: 100, digits: 0,
    decode: ([a]) => a * 100 / 255 },
];

export const BATTERY = { key: 'battery', label: 'Battery', unit: 'V', min: 10, max: 15, digits: 1 };

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

// Mode 01 PID 00: bitmap of which PIDs 01-20 the car supports.
export function decodeSupportedPids(messages) {
  const supported = new Set();
  for (const m of messages) {
    if (m[0] !== 0x41 || m[1] !== 0x00) continue;
    m.slice(2, 6).forEach((byte, i) => {
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) supported.add(i * 8 + bit + 1);
      }
    });
  }
  return supported;
}

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

// The first request also makes the adapter search for the car's protocol,
// which can take several seconds on older cars.
export async function readSupportedPids(elm) {
  return decodeSupportedPids(toMessages(await elm.send('0100', 20000)));
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
