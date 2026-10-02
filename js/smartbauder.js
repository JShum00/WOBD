// Finds the adapter's baud rate with the cheap ATI probe instead of a full reset (ATZ) at every rate.
import { ELM327, ElmError } from './elm327.js';

export const BASE_RATES = [115200, 38400, 9600, 57600, 230400];

const PROBE_TIMEOUT = 700;
const LOOKS_LIKE_ADAPTER = /ELM|STN|OBD/i;
// USB vendor IDs whose adapters usually ship at one rate: FTDI, CH340, Prolific.
const VENDOR_FIRST = { 0x0403: 115200, 0x1A86: 38400, 0x067B: 38400 };

const hex4 = (n) => n.toString(16).padStart(4, '0');

function cacheKey({ usbVendorId: vid, usbProductId: pid } = {}) {
  return Number.isInteger(vid) && Number.isInteger(pid) ? `wobd.baud.${hex4(vid)}:${hex4(pid)}` : null;
}

function readCache(key) {
  if (!key) return null;
  try {
    const rate = Number(localStorage.getItem(key));
    return BASE_RATES.includes(rate) ? rate : null;
  } catch {
    return null;  // storage blocked or unavailable
  }
}

function writeCache(key, rate) {
  if (!key) return;
  try {
    localStorage.setItem(key, String(rate));
  } catch {
    // Storage blocked or full; detection just runs again next time.
  }
}

// The base list with the rate this USB chip usually uses moved to the front.
export function rateOptions(info = {}) {
  const first = VENDOR_FIRST[info.usbVendorId];
  return first ? [first, ...BASE_RATES.filter((rate) => rate !== first)] : [...BASE_RATES];
}

// Asks for the adapter's ID. Silence means the rate is wrong; anything else gets one more try.
async function answersAt(transport, signal, aborted) {
  const elm = new ELM327(transport, { timeout: PROBE_TIMEOUT });
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = elm.send('ATI');
    reply.catch(() => {});  // if the abort wins the race, nobody else reads this rejection
    try {
      const lines = await Promise.race([reply, aborted]);
      if (lines.some((line) => LOOKS_LIKE_ADAPTER.test(line))) return true;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (!(err instanceof ElmError)) throw err;
      if (err.code === 'TIMEOUT') return false;
    }
  }
  return false;
}

// An abort controller that fires when the transport reports the adapter is gone.
// Pass its signal to detectBaud(); replace transport.onDisconnect once connected.
export function abortOnUnplug(transport) {
  const abort = new AbortController();
  transport.onDisconnect = () => abort.abort(new ElmError('UNPLUGGED',
    'The adapter was unplugged. Plug it back in and click Connect.'));
  return abort;
}

// Resolves with the rate that worked and leaves the transport open at it, or
// with null (transport closed) if no rate got an answer. The caller still has to reset the adapter.
// rates overrides the candidate list (for a manually chosen rate). If signal aborts, the
// port is closed and signal.reason is thrown.
export async function detectBaud(transport, { rates, onProgress, signal } = {}) {
  const info = transport.info ?? {};
  const key = cacheKey(info);
  const candidates = rates ?? [...new Set([readCache(key), ...rateOptions(info)].filter(Boolean))];

  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});

  for (const [i, baudRate] of candidates.entries()) {
    try {
      signal?.throwIfAborted();
      onProgress?.({ attempt: i + 1, total: candidates.length, baudRate });
      await transport.open(baudRate);
      signal?.throwIfAborted();
      if (await answersAt(transport, signal, aborted)) {
        writeCache(key, baudRate);
        return baudRate;
      }
    } catch (err) {
      await transport.close();
      throw signal?.aborted ? signal.reason : err;
    }
    await transport.close();
  }
  return null;
}
