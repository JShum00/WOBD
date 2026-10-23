// Tests for display units. Run: node scripts/test-units.mjs
import assert from 'node:assert/strict';
import { SYSTEMS, convertsUnit, displayDef, displayUnit, displayValue, getUnits, initUnits, setUnits } from '../js/units.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('imperial shows values exactly as recorded', () => {
  assert.equal(displayValue(60, 'mph', 'imperial'), 60);
  assert.equal(displayUnit('°F', 'imperial'), '°F');
  assert.equal(convertsUnit('mph', 'imperial'), false);
});

test('metric converts speed and temperature only', () => {
  assert.ok(Math.abs(displayValue(60, 'mph', 'metric') - 96.56064) < 1e-6);
  assert.equal(displayValue(212, '°F', 'metric'), 100);
  assert.equal(displayValue(32, '°F', 'metric'), 0);
  assert.equal(displayUnit('mph', 'metric'), 'km/h');
  assert.equal(displayUnit('°F', 'metric'), '°C');
  for (const unit of ['kPa', 'km', 'g/s', 'rpm', '%', 'V', '°']) {
    assert.equal(displayUnit(unit, 'metric'), unit);
    assert.equal(displayValue(7, unit, 'metric'), 7);
  }
});

test('non-numbers pass through untouched', () => {
  assert.equal(displayValue('Closed loop', 'mph', 'metric'), 'Closed loop');
  assert.equal(displayValue(null, '°F', 'metric'), null);
});

test('displayDef converts the unit and the dial limits and leaves the original alone', () => {
  const def = { key: 'coolant', unit: '°F', min: 100, max: 260, warn: 230, danger: 245, digits: 0 };
  const shown = displayDef(def, 'metric');
  assert.equal(shown.unit, '°C');
  assert.equal(shown.min, 38);
  assert.equal(shown.max, 127);
  assert.equal(shown.warn, 110);
  assert.equal(def.unit, '°F');
  assert.equal(def.min, 100);
  assert.equal(displayDef(def, 'metric'), shown);
  assert.equal(displayDef(def, 'imperial'), def);
  const other = { key: 'rpm', unit: 'rpm', min: 0, max: 7000 };
  assert.equal(displayDef(other, 'metric'), other);
});

test('the choice is saved, validated and survives blocked storage', () => {
  const storage = memory();
  setUnits('metric', { storage });
  assert.equal(getUnits(), 'metric');
  assert.equal(storage.getItem('wobd.units'), 'metric');
  setUnits('nonsense', { storage });
  assert.equal(getUnits(), 'metric');
  setUnits('imperial', { storage });
  initUnits({ storage: { getItem: () => 'metric' } });
  assert.equal(getUnits(), 'metric');
  initUnits({ storage: { getItem: () => { throw new Error('blocked'); } } });
  assert.equal(getUnits(), 'metric');
  assert.doesNotThrow(() => setUnits('imperial', { storage: { setItem: () => { throw new Error('full'); } } }));
  assert.deepEqual(SYSTEMS, ['imperial', 'metric']);
});

test('listeners hear about a change', () => {
  const seen = [];
  setUnits('imperial', { storage: memory() });
  import('../js/units.js').then(({ onUnitsChange }) => {
    const off = onUnitsChange((v) => seen.push(v));
    setUnits('metric', { storage: memory() });
    off();
    setUnits('imperial', { storage: memory() });
    assert.deepEqual(seen, ['metric']);
  });
});

console.log(`${passed} passed`);
