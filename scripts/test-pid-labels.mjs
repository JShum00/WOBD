import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BATTERY, DERIVED_PIDS, LIVE_PIDS, MODE01_DECODERS, PID_NAMES } from '../js/obd.js';

const english = JSON.parse(readFileSync(new URL('../data/i18n/en.json', import.meta.url), 'utf8'));
const defs = new Map();
for (const def of [...LIVE_PIDS, ...DERIVED_PIDS, ...MODE01_DECODERS.values(), BATTERY]) {
  if (def.key && def.label) defs.set(def.key, def.label);
}
for (const [key, label] of defs) {
  assert.ok(`pid.${key}` in english, `missing pid.${key}`);
  assert.equal(english[`pid.${key}`], label, `pid.${key} differs from the English def.label`);
}
for (const [pid, label] of Object.entries(PID_NAMES)) {
  const key = `pid.pid${Number(pid).toString(16).toUpperCase().padStart(2, '0')}`;
  assert.ok(key in english, `missing ${key} for the parameter catalog`);
  assert.equal(english[key], label, `${key} differs from PID_NAMES`);
}
console.log(`ok - ${defs.size} PID definitions and ${Object.keys(PID_NAMES).length} catalog names`);
