// VIN handling for vehicle identification: reading the Mode 09 PID 02 reply safely, checking the
// VIN, and turning an NHTSA vPIC answer into year/make/model. No DOM and no network here, so
// scripts/test-vin.mjs can check it. The VIN itself is never stored; only what the user confirms.

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// North American VINs (first character 1-5) must pass the 9th-character check digit.
export function checkDigitValid(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? Number(c) : TRANSLITERATION[c]) * WEIGHTS[i];
  }
  const expected = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === expected;
}

export function isValidVin(vin) {
  if (typeof vin !== 'string' || !VIN_PATTERN.test(vin)) return false;
  return !'12345'.includes(vin[0]) || checkDigitValid(vin);
}

// Assembles each responding ECU's reply separately: replies from the same ECU (or, without
// headers, a run of sequence numbers 1, 2, 3...) form one VIN, and a repeated sequence number
// starts the next ECU's reply. Returns an array of byte arrays.
function groupReplies(messages) {
  const groups = new Map();
  let anonymous = [];
  const anonymousGroups = [anonymous];
  for (const m of messages) {
    if (m[0] !== 0x49 || m[1] !== 0x02) continue;
    const part = { seq: m[2], data: m.slice(3) };
    if (m.ecuSource) {
      if (!groups.has(m.ecuSource)) groups.set(m.ecuSource, []);
      groups.get(m.ecuSource).push(part);
    } else {
      if (anonymous.some((p) => p.seq === part.seq)) anonymousGroups.push(anonymous = []);
      anonymous.push(part);
    }
  }
  return [...groups.values(), ...anonymousGroups]
    .filter((g) => g.length)
    .map((g) => g.sort((a, b) => a.seq - b.seq).flatMap((p) => p.data).filter((b) => b !== 0));
}

// { status, vin }: status is 'none' (no Mode 09 reply), 'malformed' (a reply that isn't a valid VIN),
// 'conflict' (different ECUs gave different VINs), or 'ok'. vin is only set for 'ok'.
export function inspectVin(messages) {
  const replies = groupReplies(messages);
  if (!replies.length) return { status: 'none', vin: null };
  const found = new Set();
  for (const bytes of replies) {
    const text = String.fromCharCode(...bytes).toUpperCase();
    if (isValidVin(text)) found.add(text);
  }
  if (found.size > 1) return { status: 'conflict', vin: null };
  if (found.size === 1) return { status: 'ok', vin: [...found][0] };
  return { status: 'malformed', vin: null };
}

export const VPIC_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/';

// vPIC writes makes in capitals (HONDA, MERCEDES-BENZ); short names such as BMW stay capitals.
export function tidyName(name) {
  return String(name).trim().split(/(\s+|-)/).map((word) => (
    word.length > 3 || /[a-z]/.test(word) ? word.charAt(0) + word.slice(1).toLowerCase() : word
  )).join('');
}

// Looks up a VIN at NHTSA. Only call this after the user agreed. Resolves { year, make, model } or
// null when vPIC doesn't know the vehicle; rejects when the request fails (offline, blocked, bad reply).
export async function lookupVin(vin, { fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await fetchImpl(`${VPIC_URL}${encodeURIComponent(vin)}?format=json`, { signal });
  if (!response.ok) throw new Error(`NHTSA lookup failed (HTTP ${response.status}).`);
  return parseVpic(await response.json());
}

export function parseVpic(body) {
  const result = body?.Results?.[0];
  if (!result || typeof result !== 'object') throw new Error('NHTSA sent a reply WOBD could not read.');
  const year = /^\d{4}$/.test(result.ModelYear ?? '') ? result.ModelYear : '';
  const make = result.Make ? tidyName(result.Make) : '';
  const model = result.Model ? String(result.Model).trim() : '';
  if (!year || !make || !model) return null;
  return { year, make, model };
}

// The saved vehicle is only year/make/model that the user confirmed; never the VIN.
const STORAGE_KEY = 'wobd.savedVehicle';

export function loadSavedVehicle(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    if (saved && ['year', 'make', 'model'].every((k) => typeof saved[k] === 'string' && saved[k])) {
      return { year: saved.year, make: saved.make, model: saved.model };
    }
  } catch { /* unavailable or corrupt: act as if nothing is saved */ }
  return null;
}

export function saveVehicle(car, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ year: car.year, make: car.make, model: car.model })); } catch { /* storage blocked */ }
}

export function forgetVehicle(storage = globalThis.localStorage) {
  try { storage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
}

export const sameVehicle = (a, b) => ['year', 'make', 'model'].every((k) => String(a?.[k] ?? '').toLowerCase() === String(b?.[k] ?? '').toLowerCase());
