// Tests for VIN reading, validation, and vehicle lookup. Run: node scripts/test-vin.mjs
// Legacy lines end with a checksum byte, which toMessages drops.
// Uses the well-known sample VIN 1HGCM82633A004352 (a 2003 Honda Accord); no car or network needed.
import assert from 'node:assert/strict';
import { decodeVin, toMessages } from '../js/obd.js';
import {
  forgetVehicle, inspectVin, isValidVin, loadSavedVehicle, lookupVin, parseVpic, sameVehicle, saveVehicle, tidyName,
} from '../js/vin.js';

const VIN = '1HGCM82633A004352';
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const msg = (bytes, ecuSource) => {
  const m = [...bytes];
  if (ecuSource) Object.defineProperty(m, 'ecuSource', { value: ecuSource });
  return m;
};
// Legacy protocols: five numbered messages, the first with three padding zeros.
const legacy = (vin, src) => {
  const b = [0, 0, 0, ...ascii(vin)];
  return [1, 2, 3, 4, 5].map((n) => msg([0x49, 0x02, n, ...b.slice((n - 1) * 4, n * 4)], src));
};
const can = (vin, src) => msg([0x49, 0x02, 1, ...ascii(vin)], src);
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

const cases = [
  ['a valid North American VIN passes; a bad check digit fails', () => {
    assert.ok(isValidVin(VIN));
    assert.ok(!isValidVin('1HGCM82643A004352'));
  }],
  ['wrong length, lowercase, or I/O/Q characters fail', () => {
    for (const bad of ['', '1HGCM82633A00435', `${VIN}0`, '1hgcm82633a004352', '1HGCM82633A00435O', null, undefined]) assert.ok(!isValidVin(bad), String(bad));
  }],
  ['a CAN reply gives the VIN', () => assert.deepEqual(inspectVin([can(VIN)]), { status: 'ok', vin: VIN })],
  ['a legacy five-message reply gives the VIN, even out of order', () => {
    assert.equal(inspectVin(legacy(VIN)).vin, VIN);
    assert.equal(inspectVin(legacy(VIN).reverse()).vin, VIN);
  }],
  ['two ECUs reporting the same VIN is fine', () => {
    assert.equal(inspectVin([can(VIN, '7E8'), can(VIN, '7E9')]).vin, VIN);
    assert.equal(inspectVin([...legacy(VIN), ...legacy(VIN)]).vin, VIN);
  }],
  ['two ECUs reporting different VINs is a conflict, never an arbitrary pick', () => {
    const other = '1M8GDM9AXKP042788';
    assert.ok(isValidVin(other));
    assert.deepEqual(inspectVin([can(VIN, '7E8'), can(other, '7E9')]), { status: 'conflict', vin: null });
    assert.equal(inspectVin([...legacy(VIN), ...legacy(other)]).status, 'conflict');
  }],
  ['short, garbled, or wrong-check-digit replies are malformed', () => {
    assert.equal(inspectVin([can(VIN.slice(0, 12))]).status, 'malformed');
    assert.equal(inspectVin([can('1HGCM82643A004352')]).status, 'malformed');
    assert.equal(inspectVin([msg([0x49, 0x02, 1, 0xff, 0xfe, 0x20])]).status, 'malformed');
  }],
  ['no Mode 09 reply is "none"', () => {
    assert.deepEqual(inspectVin([]), { status: 'none', vin: null });
    assert.deepEqual(inspectVin([msg([0x41, 0x0c, 0x1a, 0xf8])]), { status: 'none', vin: null });
  }],
  ['decodeVin still returns the VIN or null, from raw adapter lines', () => {
    const hex = (m) => m.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    assert.equal(decodeVin(toMessages(legacy(VIN).map((m) => `48 6B 10 ${hex(m)} 00`))), VIN);
    assert.equal(decodeVin([]), null);
  }],
  ['vPIC replies become year/make/model with tidy capitalization', () => {
    assert.deepEqual(parseVpic({ Results: [{ Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] }), { year: '2003', make: 'Honda', model: 'Accord' });
    assert.equal(tidyName('MERCEDES-BENZ'), 'Mercedes-Benz');
    assert.equal(tidyName('BMW'), 'BMW');
    assert.equal(tidyName('LAND ROVER'), 'Land Rover');
  }],
  ['vPIC replies missing a field give null; unreadable replies throw', () => {
    assert.equal(parseVpic({ Results: [{ Make: 'HONDA', Model: '', ModelYear: '2003' }] }), null);
    assert.equal(parseVpic({ Results: [{ Make: '', Model: '', ModelYear: '' }] }), null);
    assert.throws(() => parseVpic({}), /could not read/);
    assert.throws(() => parseVpic(null), /could not read/);
  }],
  ['lookupVin sends only the VIN, and reports HTTP and network failures', async () => {
    let seen;
    const ok = async (url) => { seen = url; return { ok: true, json: async () => ({ Results: [{ Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] }) }; };
    assert.equal((await lookupVin(VIN, { fetchImpl: ok })).model, 'Accord');
    assert.equal(seen, `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${VIN}?format=json`);
    await assert.rejects(lookupVin(VIN, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
    await assert.rejects(lookupVin(VIN, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Failed to fetch/);
  }],
  ['saved vehicles hold year/make/model only, never the VIN, and can be forgotten', () => {
    const s = store();
    assert.equal(loadSavedVehicle(s), null);
    saveVehicle({ year: '2003', make: 'Honda', model: 'Accord', vin: VIN }, s);
    assert.ok(!s.getItem('wobd.savedVehicle').includes(VIN));
    assert.deepEqual(loadSavedVehicle(s), { year: '2003', make: 'Honda', model: 'Accord' });
    forgetVehicle(s);
    assert.equal(loadSavedVehicle(s), null);
    s.setItem('wobd.savedVehicle', '{not json');
    assert.equal(loadSavedVehicle(s), null);
    assert.equal(loadSavedVehicle({ getItem() { throw new Error('blocked'); } }), null);
  }],
  ['sameVehicle ignores case', () => {
    assert.ok(sameVehicle({ year: '2003', make: 'HONDA', model: 'accord' }, { year: '2003', make: 'Honda', model: 'Accord' }));
    assert.ok(!sameVehicle({ year: '2004', make: 'Honda', model: 'Accord' }, { year: '2003', make: 'Honda', model: 'Accord' }));
  }],
];

let failed = 0;
const rows = [];
for (const [name, test] of cases) {
  try { await test(); rows.push({ case: name, result: 'pass' }); } catch (err) { failed++; rows.push({ case: name, result: `FAIL: ${err.message}` }); }
}
console.table(rows);
if (failed) { console.error(`${failed} of ${cases.length} failed`); process.exit(1); }
console.log(`All ${cases.length} passed`);
