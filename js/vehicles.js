// Turns a year, make, and model into a pretend car for the simulator. The
// protocols follow the usual pattern (Ford on J1850 PWM, GM on VPW, most others
// on ISO 9141 or KWP until CAN became mandatory in 2008), but they are rules of
// thumb, not a lookup of real vehicles. Add a MODEL_RULES entry when a real car
// turns out to differ.

// canFrom: first model year that talks CAN 11-bit 500k. Before that, `legacy` applies.
const FAMILIES = [
  { makes: ['Ford', 'Lincoln', 'Mercury', 'Mazda'], legacy: '1', canFrom: 2008 },
  { makes: ['Chevrolet', 'GMC', 'Buick', 'Cadillac', 'Pontiac', 'Saturn', 'Oldsmobile', 'Hummer'], legacy: '2', canFrom: 2008 },
  { makes: ['Chrysler', 'Dodge', 'Jeep', 'Plymouth', 'Ram'], legacy: '3', canFrom: 2008 },
  { makes: ['Honda', 'Acura', 'Mitsubishi', 'Subaru'], legacy: '3', canFrom: 2008 },
  { makes: ['Toyota', 'Lexus', 'Scion'], legacy: '3', canFrom: 2004 },
  { makes: ['Nissan', 'Infiniti'], legacy: '5', canFrom: 2004 },
  { makes: ['Hyundai', 'Kia', 'Genesis'], legacy: '5', canFrom: 2008 },
  { makes: ['Volkswagen', 'Audi', 'Porsche'], legacy: '4', canFrom: 2008 },
  { makes: ['BMW', 'Mini', 'Mercedes-Benz', 'Volvo', 'Jaguar', 'Land Rover', 'Saab'], legacy: '5', canFrom: 2008 },
];

// Cars that break their make's pattern. until: first model year the rule stops applying.
const MODEL_RULES = [
  { make: 'Chrysler', model: 'PT Cruiser', until: 2004, protocol: '2' },
];

const CAN_PIDS = { supported: { '0100': ['4100BE3FB811'] } };
// Older cars report fewer PIDs; this is the 2001 PT Cruiser's list.
const LEGACY_PIDS = { supported: { '0100': ['4100BE3C9810'] } };

// How long the first request takes while the car wakes up, and per-request speed.
const TIMING = {
  1: { initMs: 1200, latency: 100 },
  2: { initMs: 1200, latency: 150 },
  3: { initMs: 3500, latency: 120 },
  4: { initMs: 4000, latency: 120 },
  5: { initMs: 1500, latency: 90 },
};

export const CODE_SETS = {
  none: { label: 'No trouble codes', codes: [] },
  few: { label: 'A few codes (misfire, lean, EVAP leak)', codes: ['P0301', 'P0171', 'P0442'] },
  brand: { label: 'A generic and a brand-specific code', codes: ['P0420', 'P1491'] },
};

export const DEFAULT_CODE_SET = 'few';

const norm = (text) => String(text ?? '').trim().toLowerCase();

// Returns the protocol number (ELM327 numbering) and why it was chosen.
export function pickProtocol({ year, make, model } = {}) {
  const y = Number(year) || null;
  const rule = MODEL_RULES.find((r) => norm(r.make) === norm(make) && norm(r.model) === norm(model) && y !== null && y < r.until);
  if (rule) return { protocol: rule.protocol, reason: `${rule.make} ${rule.model} before ${rule.until}` };

  const family = FAMILIES.find((f) => f.makes.some((m) => norm(m) === norm(make)));
  if (!y) return { protocol: '6', reason: 'No year chosen, so a modern CAN car' };
  if (!family) {
    return y >= 2008
      ? { protocol: '6', reason: 'CAN is required from 2008' }
      : { protocol: '3', reason: 'Unknown make before 2008, guessing ISO 9141-2' };
  }
  return y >= family.canFrom
    ? { protocol: '6', reason: `${family.makes[0]}-family cars use CAN from ${family.canFrom}` }
    : { protocol: family.legacy, reason: `${family.makes[0]}-family cars before ${family.canFrom}` };
}

// The profile DemoTransport takes as its scenario.
export function vehicleProfile({ year, make, model, codeSet = DEFAULT_CODE_SET, autoFails = false } = {}) {
  const { protocol, reason } = pickProtocol({ year, make, model });
  const can = /^[6-9A-C]$/.test(protocol);
  const y = Number(year) || null;
  return {
    label: [year, make, model].filter(Boolean).join(' ') || 'Unspecified car',
    protocol,
    reason,
    // Mode 9 (VIN) is rare on older non-CAN cars.
    vin: can || (y !== null && y >= 2005) ? 'SMLTD000000000001' : null,
    codes: [...(CODE_SETS[codeSet] ?? CODE_SETS[DEFAULT_CODE_SET]).codes],
    autoFails,
    ...(can ? CAN_PIDS : LEGACY_PIDS),
    ...(TIMING[protocol] ?? {}),
  };
}
