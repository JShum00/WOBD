// Display units. Recordings, CSV and exports always keep the units the car reported
// (mph, °F, km, kPa). This only changes what is shown on screen and in the printed report.
// Imperial (the default) shows values exactly as recorded; metric converts speed and temperature.
// No DOM here, so scripts/test-units.mjs can check it in Node.

export const STORAGE_KEY = 'wobd.units';
export const SYSTEMS = ['imperial', 'metric'];

let system = 'imperial';
const listeners = new Set();

export const getUnits = () => system;
export const onUnitsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function setUnits(value, { storage = globalThis.localStorage } = {}) {
  if (!SYSTEMS.includes(value)) return system;
  system = value;
  try { storage?.setItem(STORAGE_KEY, value); } catch { /* private mode: not remembered */ }
  for (const fn of listeners) fn(system);
  return system;
}

export function initUnits({ storage = globalThis.localStorage } = {}) {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (SYSTEMS.includes(saved)) system = saved;
  } catch { /* keep the default */ }
  return system;
}

// How each recorded unit converts. Units not listed here are shown as recorded.
const CONVERSIONS = {
  mph: { unit: 'km/h', to: (v) => v * 1.609344 },
  '°F': { unit: '°C', to: (v) => (v - 32) * 5 / 9 },
};

export const convertsUnit = (unit, units = system) => units === 'metric' && unit in CONVERSIONS;

// The value as it is shown, given the unit it was recorded in.
export function displayValue(value, unit, units = system) {
  if (typeof value !== 'number' || !convertsUnit(unit, units)) return value;
  return CONVERSIONS[unit].to(value);
}

export const displayUnit = (unit, units = system) => (convertsUnit(unit, units) ? CONVERSIONS[unit].unit : unit);

// A gauge definition with its unit, range and warning limits converted for display.
// The original definition is never changed. Results are cached per definition and system.
const cache = new WeakMap();

export function displayDef(def, units = system) {
  if (!def || !convertsUnit(def.unit, units)) return def;
  const hit = cache.get(def);
  if (hit) return hit;
  const shown = { ...def, unit: displayUnit(def.unit, units) };
  for (const key of ['min', 'max', 'warn', 'danger']) if (typeof def[key] === 'number') shown[key] = Math.round(displayValue(def[key], def.unit, units));
  cache.set(def, shown);
  return shown;
}
