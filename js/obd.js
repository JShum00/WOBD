// OBD-II requests and decoders. Replies are expected with echo, spaces, and
// headers off (see ELM327.configure).
import { ElmError } from './elm327.js';
import { inspectVin } from './vin.js';
import { onLanguageChange, t } from './i18n.js';

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
    expectedBytes: 2, decode: ([a]) => FUEL_SYSTEM_STATUS[a]?.() ?? null },
  { pid: 0x0A, key: 'fuelpressure', label: 'Fuel pressure', unit: 'kPa', style: 'hbar', min: 0, max: 765, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => a * 3 },
  { pid: 0x21, key: 'mildistance', label: 'Distance with MIL on', unit: 'km', style: 'hbar', min: 0, max: 1000, digits: 0,
    expectedBytes: 2, slow: true, priority: 'low', decode: ([a, b]) => a * 256 + b },
  { pid: 0x23, key: 'railpressure', label: 'Fuel rail pressure', unit: 'kPa', style: 'hbar', min: 0, max: 655350, digits: 0,
    expectedBytes: 2, slow: true, decode: ([a, b]) => (a * 256 + b) * 10 },
  // Wideband sensors reply with four bytes: lambda in the first two, then a voltage (0x24)
  // or current (0x34) in the last two. Only lambda is shown; the gauges have one value.
  { pid: 0x24, key: 'wideband1v', label: 'Wideband O2 sensor 1, equivalence ratio (voltage type)', unit: 'ratio', style: 'hbar',
    min: 0, max: 2, digits: 3, expectedBytes: 4, slow: true, decode: ([a, b]) => (a * 256 + b) * 2 / 65536 },
  { pid: 0x34, key: 'wideband1c', label: 'Wideband O2 sensor 1, equivalence ratio (current type)', unit: 'ratio', style: 'hbar',
    min: 0, max: 2, digits: 3, expectedBytes: 4, slow: true, decode: ([a, b]) => (a * 256 + b) * 2 / 65536 },
  // Percent of tank capacity as the ECU reports it. Not fuel consumption or range.
  { pid: 0x2F, key: 'fuellevel', label: 'Fuel tank level', unit: '%', style: 'hbar', min: 0, max: 100, digits: 0,
    expectedBytes: 1, slow: true, priority: 'low', decode: ([a]) => a * 100 / 255 },
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
  { pid: 0x53, key: 'evapabsolute', label: 'Absolute evap system vapor pressure', unit: 'kPa', style: 'hbar', min: 0, max: 330, digits: 2,
    expectedBytes: 2, slow: true, decode: ([a, b]) => (a * 256 + b) / 200 },
  { pid: 0x5C, key: 'oiltemp', label: 'Engine oil temp', unit: '°F', style: 'hbar', min: 0, max: 300, digits: 0,
    expectedBytes: 1, slow: true, decode: ([a]) => (a - 40) * 9 / 5 + 32 },
];

// PID 03 reports one bit per state; only one is ever set per bank.
const FUEL_SYSTEM_STATUS = {
  0x01: () => t('pid.fuelSystem.openWarming'),
  0x02: () => t('pid.fuelSystem.closed'),
  0x04: () => t('pid.fuelSystem.openLoad'),
  0x08: () => t('pid.fuelSystem.openFault'),
  0x10: () => t('pid.fuelSystem.closedSensorFault'),
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
  0x22: 'Fuel rail pressure (vacuum)', 0x23: 'Fuel rail pressure', 0x24: 'Wideband O2 sensor 1, equivalence ratio (voltage type)', 0x25: 'Wideband O2 sensor 2, equivalence ratio (voltage type)',
  0x26: 'Wideband O2 sensor 3, equivalence ratio (voltage type)', 0x27: 'Wideband O2 sensor 4, equivalence ratio (voltage type)',
  0x28: 'Wideband O2 sensor 5, equivalence ratio (voltage type)', 0x29: 'Wideband O2 sensor 6, equivalence ratio (voltage type)',
  0x2A: 'Wideband O2 sensor 7, equivalence ratio (voltage type)', 0x2B: 'Wideband O2 sensor 8, equivalence ratio (voltage type)',
  0x34: 'Wideband O2 sensor 1, equivalence ratio (current type)', 0x35: 'Wideband O2 sensor 2, equivalence ratio (current type)',
  0x36: 'Wideband O2 sensor 3, equivalence ratio (current type)', 0x37: 'Wideband O2 sensor 4, equivalence ratio (current type)',
  0x38: 'Wideband O2 sensor 5, equivalence ratio (current type)', 0x39: 'Wideband O2 sensor 6, equivalence ratio (current type)',
  0x3A: 'Wideband O2 sensor 7, equivalence ratio (current type)', 0x3B: 'Wideband O2 sensor 8, equivalence ratio (current type)',
  0x53: 'Absolute evap system vapor pressure',
  0x2C: 'Commanded EGR', 0x2D: 'EGR error',
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

const PID_NAME_TRANSLATIONS = new Map([
  [0x01, () => t('pid.pid01')],
  [0x02, () => t('pid.pid02')],
  [0x08, () => t('pid.pid08')],
  [0x09, () => t('pid.pid09')],
  [0x0A, () => t('pid.pid0A')],
  [0x12, () => t('pid.pid12')],
  [0x13, () => t('pid.pid13')],
  [0x16, () => t('pid.pid16')],
  [0x17, () => t('pid.pid17')],
  [0x18, () => t('pid.pid18')],
  [0x19, () => t('pid.pid19')],
  [0x1A, () => t('pid.pid1A')],
  [0x1B, () => t('pid.pid1B')],
  [0x1C, () => t('pid.pid1C')],
  [0x1D, () => t('pid.pid1D')],
  [0x1E, () => t('pid.pid1E')],
  [0x1F, () => t('pid.pid1F')],
  [0x21, () => t('pid.pid21')],
  [0x22, () => t('pid.pid22')],
  [0x23, () => t('pid.pid23')],
  [0x24, () => t('pid.pid24')],
  [0x25, () => t('pid.pid25')],
  [0x26, () => t('pid.pid26')],
  [0x27, () => t('pid.pid27')],
  [0x28, () => t('pid.pid28')],
  [0x29, () => t('pid.pid29')],
  [0x2A, () => t('pid.pid2A')],
  [0x2B, () => t('pid.pid2B')],
  [0x34, () => t('pid.pid34')],
  [0x35, () => t('pid.pid35')],
  [0x36, () => t('pid.pid36')],
  [0x37, () => t('pid.pid37')],
  [0x38, () => t('pid.pid38')],
  [0x39, () => t('pid.pid39')],
  [0x3A, () => t('pid.pid3A')],
  [0x3B, () => t('pid.pid3B')],
  [0x53, () => t('pid.pid53')],
  [0x2C, () => t('pid.pid2C')],
  [0x2D, () => t('pid.pid2D')],
  [0x2E, () => t('pid.pid2E')],
  [0x2F, () => t('pid.pid2F')],
  [0x30, () => t('pid.pid30')],
  [0x31, () => t('pid.pid31')],
  [0x32, () => t('pid.pid32')],
  [0x33, () => t('pid.pid33')],
  [0x3C, () => t('pid.pid3C')],
  [0x3D, () => t('pid.pid3D')],
  [0x3E, () => t('pid.pid3E')],
  [0x3F, () => t('pid.pid3F')],
  [0x41, () => t('pid.pid41')],
  [0x42, () => t('pid.pid42')],
  [0x43, () => t('pid.pid43')],
  [0x44, () => t('pid.pid44')],
  [0x45, () => t('pid.pid45')],
  [0x46, () => t('pid.pid46')],
  [0x47, () => t('pid.pid47')],
  [0x49, () => t('pid.pid49')],
  [0x4A, () => t('pid.pid4A')],
  [0x4C, () => t('pid.pid4C')],
  [0x4D, () => t('pid.pid4D')],
  [0x4E, () => t('pid.pid4E')],
  [0x51, () => t('pid.pid51')],
  [0x52, () => t('pid.pid52')],
  [0x5A, () => t('pid.pid5A')],
  [0x5B, () => t('pid.pid5B')],
  [0x5C, () => t('pid.pid5C')],
  [0x5E, () => t('pid.pid5E')],
]);



const PID_LABEL_TRANSLATIONS = new Map([
  [0x0C, () => t('pid.rpm')],
  [0x0D, () => t('pid.speed')],
  [0x11, () => t('pid.throttle')],
  [0x04, () => t('pid.load')],
  [0x06, () => t('pid.stft')],
  [0x07, () => t('pid.ltft')],
  [0x05, () => t('pid.coolant')],
  [0x0F, () => t('pid.iat')],
  [0x10, () => t('pid.maf')],
  [0x0B, () => t('pid.map')],
  [0x0E, () => t('pid.timing')],
  [0x14, () => t('pid.o2b1s1')],
  [0x15, () => t('pid.o2b1s2')],
  [0x03, () => t('pid.fuelsys')],
  [0x0A, () => t('pid.fuelpressure')],
  [0x21, () => t('pid.mildistance')],
  [0x23, () => t('pid.railpressure')],
  [0x24, () => t('pid.wideband1v')],
  [0x34, () => t('pid.wideband1c')],
  [0x2F, () => t('pid.fuellevel')],
  [0x31, () => t('pid.cleareddistance')],
  [0x3C, () => t('pid.catalystb1s1')],
  [0x3D, () => t('pid.catalystb2s1')],
  [0x3E, () => t('pid.catalystb1s2')],
  [0x3F, () => t('pid.catalystb2s2')],
  [0x42, () => t('pid.modulevoltage')],
  [0x44, () => t('pid.equivratio')],
  [0x46, () => t('pid.ambienttemp')],
  [0x53, () => t('pid.evapabsolute')],
  [0x5C, () => t('pid.oiltemp')],
  [0x1C, () => t('pid.obdstandard')],
]);


// Used for a supported PID WOBD has no name for. It may be standard, manufacturer-specific, or reserved.
export let UNNAMED_PID = t('pid.unnamed');
onLanguageChange(() => { UNNAMED_PID = t('pid.unnamed'); });

const NON_LIVE_DECODERS = [
  { pid: 0x1C, key: 'obdstandard', label: 'OBD standards compliance', expectedBytes: 1,
    get category() { return t('pid.category.diagnostic'); }, monitorable: false, decode: ([a]) => a },
];

export const MODE01_DECODERS = new Map([
  ...LIVE_PIDS.map((def) => [def.pid, def]),
  ...NON_LIVE_DECODERS.map((def) => [def.pid, def]),
]);

const PID_CATEGORIES = new Map([
  [0x03, () => t('pid.category.fuelAir')], [0x04, () => t('pid.category.engine')], [0x05, () => t('pid.category.temperature')],
  [0x06, () => t('pid.category.fuelAir')], [0x07, () => t('pid.category.fuelAir')], [0x0A, () => t('pid.category.fuelAir')],
  [0x0B, () => t('pid.category.fuelAir')], [0x0C, () => t('pid.category.engine')], [0x0D, () => t('pid.category.speedDistance')],
  [0x0E, () => t('pid.category.ignition')], [0x0F, () => t('pid.category.temperature')], [0x10, () => t('pid.category.fuelAir')],
  [0x11, () => t('pid.category.engine')], [0x14, () => t('pid.category.oxygen')], [0x15, () => t('pid.category.oxygen')],
  [0x1C, () => t('pid.category.diagnostic')], [0x21, () => t('pid.category.speedDistance')],
  [0x23, () => t('pid.category.fuelAir')], [0x24, () => t('pid.category.oxygen')], [0x34, () => t('pid.category.oxygen')], [0x53, () => t('pid.category.emissions')], [0x2F, () => t('pid.category.fuelAir')], [0x31, () => t('pid.category.speedDistance')],
  [0x3C, () => t('pid.category.emissions')], [0x3D, () => t('pid.category.emissions')], [0x3E, () => t('pid.category.emissions')], [0x3F, () => t('pid.category.emissions')],
  [0x42, () => t('pid.category.electrical')], [0x44, () => t('pid.category.fuelAir')], [0x46, () => t('pid.category.temperature')], [0x5C, () => t('pid.category.temperature')],
]);

const PID_DESCRIPTIONS = new Map([
  [0x2F, () => t('pid.description.fuelLevel')],
  [0x1C, () => t('pid.description.obdStandard')],
  [0x21, () => t('pid.description.milDistance')],
  [0x31, () => t('pid.description.clearedDistance')],
  [0x42, () => t('pid.description.moduleVoltage')],
  [0x23, () => t('pid.description.railPressure')],
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
    const name = PID_LABEL_TRANSLATIONS.get(pid)?.() ?? PID_NAME_TRANSLATIONS.get(pid)?.() ?? UNNAMED_PID;
    return {
      pid,
      name,
      description: PID_DESCRIPTIONS.get(pid)?.() ?? name,
      category: def?.category ?? PID_CATEGORIES.get(pid)?.() ?? t('pid.category.undecoded'),
      unit: def?.unit ?? null,
      expectedBytes: def?.expectedBytes ?? null,
      decoderAvailable: Boolean(def),
      monitorable: Boolean(def && def.monitorable !== false && def.style),
      priority: def?.priority ?? (def?.slow ? 'low' : 'medium'),
      ecuSources: sources.get(pid) ?? [],
      decoder: def ?? null,
      availability: !def ? t('pid.availability.decoderUnavailable')
        : def.monitorable === false || !def.style ? t('pid.availability.notLive') : t('pid.availability.notSelected'),
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
    const legacy = /^((?:[0-9A-F]{2}6B|[89A-F][0-9A-F]F1)[0-9A-F]{2})((?:41[0-9A-F]{2}|43|44|47|4A|49[0-9A-F]{2})[0-9A-F]*)$/.exec(line);
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
      // J1850/ISO replies end with a checksum byte that is not payload
      addMessage(toBytes(legacy[2]).slice(0, -1), legacy[1]);
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
  // Every responding ECU reports its own status; the lamp is on if any says so.
  const replies = messages.filter((m) => m[0] === 0x41 && m[1] === 0x01 && m.length >= 3);
  if (!replies.length) return null;
  return {
    milOn: replies.some((m) => m[2] & 0x80),
    count: replies.reduce((total, m) => total + (m[2] & 0x7F), 0),
    ecus: replies.map((m) => ({
      source: m.ecuSource ?? null,
      milOn: Boolean(m[2] & 0x80),
      count: m[2] & 0x7F,
    })),
  };
}

// Module name guessed from the reply address. Most cars use these addresses, but
// the standard doesn't require them, so the result is only a hint (confidence
// 'inferred'); anything else falls back to the raw address as 'unknown'.
const MODULE_HINTS = {
  '7E8': 'pid.ecu.engine', '7E9': 'pid.ecu.transmission',
  '10': 'pid.ecu.engine', '18': 'pid.ecu.transmission',
};

export function ecuIdentity(source) {
  if (!source) return { source: null, name: t('pid.ecu.vehicle'), confidence: 'unknown' };
  const key = source.startsWith('7E') ? source : source.slice(-2);
  const name = MODULE_HINTS[key];
  return name
    ? { source, name: t(name), confidence: 'inferred' }
    : { source, name: t('pid.ecu.module', { key }), confidence: 'unknown' };
}

// Mode 09 PID 02. CAN sends one long message; older protocols send five
// numbered messages of four bytes each.
export function decodeVin(messages) {
  return inspectVin(messages).vin;
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

// The adapter said the bus itself failed (a forced protocol the car doesn't speak gives CAN ERROR).
// Retrying or asking more questions can't help, so connecting stops there. BUS BUSY and BUFFER FULL
// are left out because they can pass.
function isDefinitiveBusError(err) {
  return err.code === 'BUS_ERROR' && /^(CAN ERROR|BUS ERROR|FB ERROR)/.test(err.reply ?? '');
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
      if (base === 0 && (err.code === 'UNABLE_TO_CONNECT' || isDefinitiveBusError(err))) throw err;
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

// Runs job with spaces and headers on so every reply names its ECU. Without
// header support it runs anyway; replies then have no source and are never
// attributed to a module.
async function withHeaders(elm, job) {
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
    return job();
  }

  try {
    return await job();
  } finally {
    if (headersEnabled) await elm.send('ATH0');
    if (spacingEnabled) await elm.send('ATS0');
  }
}

export function readDtcServices(elm, isCan) {
  return withHeaders(elm, () => queryDtcServices(elm, isCan));
}

// Status and all DTC services in one header-enabled pass.
export function readScan(elm, isCan) {
  return withHeaders(elm, async () => ({
    status: await readStatus(elm),
    services: await queryDtcServices(elm, isCan),
  }));
}

async function queryDtcServices(elm, isCan) {
  const services = [];
  for (const service of [0x03, 0x07, 0x0A]) {
    const label = { 0x03: t('pid.dtc.stored'), 0x07: t('pid.dtc.pending'), 0x0A: t('pid.dtc.permanent') }[service];
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
  return (await readVinInfo(elm)).vin;
}

// Same request, with why there is no VIN: { status: 'ok' | 'none' | 'malformed' | 'conflict', vin }.
export async function readVinInfo(elm) {
  try {
    return inspectVin(toMessages(await elm.send('0902', 8000)));
  } catch (err) {
    if (err.code === 'NO_DATA' || err.code === 'COMMAND_ERROR') return { status: 'none', vin: null };
    throw err;
  }
}

function decodeReply(def, m) {
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

export async function readPid(elm, def) {
  const m = findReply(toMessages(await elm.send(`01${hex2(def.pid)}`)), 0x01, def.pid);
  return m ? decodeReply(def, m) : null;
}

// Some readings carry a second value in the same reply (wideband sensors: lambda plus
// sensor voltage or current). They are not polled; they are decoded from the same bytes.
export const DERIVED_PIDS = [
  { pid: 0x24, part: 2, key: 'wideband1v_volts', label: 'Wideband O2 sensor 1, sensor voltage', unit: 'V', style: 'hbar',
    min: 0, max: 8, digits: 3, expectedBytes: 4, decode: ([, , c, d]) => (c * 256 + d) * 8 / 65536 },
  { pid: 0x34, part: 2, key: 'wideband1c_ma', label: 'Wideband O2 sensor 1, sensor current', unit: 'mA', style: 'hbar',
    min: -128, max: 128, digits: 2, expectedBytes: 4, decode: ([, , c, d]) => (c * 256 + d) / 256 - 128 },
];

export const bytesToHex = (bytes) => bytes.map(hex2).join('');

// Why a reading produced no usable value. One plain-English text per failure kind,
// the same for every make and model.
export const FAILURE_REASONS = {
  'no-response': {
    get short() { return t('pid.failure.noResponseShort'); },
    get text() { return t('pid.failure.noResponse'); },
  },
  malformed: {
    get short() { return t('pid.failure.malformedShort'); },
    get text() { return t('pid.failure.malformed'); },
  },
  invalid: {
    get short() { return t('pid.failure.invalidShort'); },
    get text() { return t('pid.failure.invalid'); },
  },
};

// Reads one PID and keeps everything: the raw data bytes (hex) always, the decoded value
// and any second values when the bytes fit, and a failure kind when they don't.
// def may be a bare { pid } for a parameter WOBD has no decoder for (raw only).
export async function readPidDetailed(elm, def) {
  const m = findReply(toMessages(await elm.send(`01${hex2(def.pid)}`)), 0x01, def.pid);
  if (!m) return { value: null, raw: null, ecu: null, extras: [], failure: 'no-response' };
  const raw = bytesToHex(m.slice(2));
  const ecu = m.ecuSource ?? null;
  if (!def.decode) return { value: null, raw, ecu, extras: [], failure: null };
  let value;
  try {
    value = decodeReply(def, m);
  } catch (err) {
    return { value: null, raw, ecu, extras: [], failure: /invalid numeric/.test(err.message) ? 'invalid' : 'malformed' };
  }
  const extras = DERIVED_PIDS.filter((extra) => extra.pid === def.pid).flatMap((extra) => {
    try {
      return [{ def: extra, value: decodeReply(extra, m) }];
    } catch {
      return [];
    }
  });
  return { value, raw, ecu, extras, failure: null };
}

// Raw-only read of a parameter WOBD can't decode: one entry per responding ECU, so a car with
// several ECUs keeps every answer with its source. Empty when nothing answered.
export async function readRawPid(elm, pid) {
  const messages = toMessages(await elm.send(`01${hex2(pid)}`));
  return messages
    .filter((m) => m[0] === 0x41 && m[1] === pid)
    .map((m) => ({ raw: bytesToHex(m.slice(2)), ecu: m.ecuSource ?? null }));
}

// The gauges this car can show, in display order. Battery comes from the adapter,
// not the car, so it is always offered.
export function gaugeDefs(supported) {
  return [...LIVE_PIDS.filter((def) => supported.has(def.pid)), BATTERY];
}

// "0x0F", or "ATRV" for the battery (an adapter command, not a PID).
export function pidLabel(def) {
  return def.pid === undefined ? 'ATRV' : `0x${hex2(def.pid)}${def.part ? `.${def.part}` : ''}`;
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
