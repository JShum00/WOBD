// Tests for the supported-PID query (0100 and its chain) and the gauge picker's
// logic, with a fake adapter that answers from canned replies.
// Run: node scripts/test-supported-pids.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { ElmError } from '../js/elm327.js';
import { BATTERY, PRESETS, ROUND_PAUSE_MS, SLOW_EVERY, readSupportedPids, decodeSupportedPids, toMessages } from '../js/obd.js';
import { defaultKeys, estimateRefresh, pickerChoices, presetKeys } from '../js/gauge-picker.js';

// ---------- Fakes ----------

// An adapter that answers each command from `replies`: an array of reply lines,
// or an ElmError code to throw. Anything unlisted is NO DATA. Logs every command.
function fakeElm(replies) {
  const sent = [];
  return {
    sent,
    async send(command) {
      sent.push(command);
      const reply = replies[command];
      if (reply === undefined) throw new ElmError('NO_DATA', 'NO DATA');
      if (typeof reply === 'string') throw new ElmError(reply, reply);
      return reply;
    },
  };
}

const hex = (pids) => [...pids].sort((a, b) => a - b).map((p) => p.toString(16).toUpperCase().padStart(2, '0'));

// Synthetic J1850 VPW reply for the 2001 PT Cruiser: the 12 gauges it shows in
// WOBD, plus 0x01 (monitor status) and 0x1C (OBD standard) that every car
// reports. Replace with the real bytes from the console log after a connect.
const PT_CRUISER = { '0100': ['4100BE3C9810'] };
const PT_CRUISER_GAUGES = ['03', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '11', '14', '15'];

// ---------- Cases ----------

const cases = [
  ['decoder: byte A bit 7 is base+1, byte D bit 0 is base+0x20', async () => {
    const { pids, valid } = decodeSupportedPids(toMessages(['412080000001']), 0x20);
    assert.equal(valid, true);
    assert.deepEqual(hex(pids), ['21', '40']);
  }],
  ['J1850 VPW single ECU (PT Cruiser): exactly its 12 gauges', async () => {
    const elm = fakeElm(PT_CRUISER);
    const { pids } = await readSupportedPids(elm);
    assert.deepEqual(hex(pids), ['01', ...PT_CRUISER_GAUGES, '1C'].sort());
    assert.deepEqual(elm.sent, ['0100'], 'byte D bit 0 clear: no chain');
    const { offered, undecoded } = pickerChoices(pids);
    assert.deepEqual(offered.filter((d) => d !== BATTERY).map((d) => d.pid.toString(16).toUpperCase().padStart(2, '0')).sort(), PT_CRUISER_GAUGES);
    assert.equal(offered.at(-1), BATTERY, 'battery is always offered');
    assert.deepEqual(undecoded.map((u) => u.pid), [0x1C], '0x01 is used by the scan, so not listed');
    assert.equal(undecoded[0].name, 'OBD standard');
  }],
  ['multi-ECU: masks are OR-ed and either ECU can continue the chain', async () => {
    const elm = fakeElm({
      '0100': ['4100BE3FB811', '410080180000'],  // only the first ECU sets 0x20
      '0120': ['412080022001', '412000000000'],
      '0140': ['414044008010'],
    });
    const { pids } = await readSupportedPids(elm);
    assert.deepEqual(elm.sent, ['0100', '0120', '0140']);
    for (const pid of [0x0C, 0x0D, 0x21, 0x2F, 0x33, 0x42, 0x46, 0x51, 0x5C]) assert.ok(pids.has(pid), `0x${pid.toString(16)}`);
    const { undecoded } = pickerChoices(pids);
    assert.deepEqual(undecoded.map((u) => u.pid), [0x13, 0x1C, 0x21, 0x2F, 0x33, 0x42, 0x46, 0x51, 0x5C]);
  }],
  ['the second ECU alone can carry the chain bit', async () => {
    const elm = fakeElm({ '0100': ['4100BE3FB810', '410000000001'], '0120': ['412000000000', '412080000000'] });
    const { pids } = await readSupportedPids(elm);
    assert.deepEqual(elm.sent, ['0100', '0120']);
    assert.ok(pids.has(0x21));
  }],
  ['chain stops at 0x20 when its last bit is clear', async () => {
    const elm = fakeElm({ '0100': ['4100BE3FB811'], '0120': ['412080000000'] });
    const { pids } = await readSupportedPids(elm);
    assert.deepEqual(elm.sent, ['0100', '0120'], '0140 is never asked');
    assert.ok(pids.has(0x21));
  }],
  ['a later page failing keeps what was found', async () => {
    const elm = fakeElm({ '0100': ['4100BE3FB811'], '0120': ['412080000001'] });  // 0140 -> NO DATA
    const { pids } = await readSupportedPids(elm);
    assert.deepEqual(elm.sent, ['0100', '0120', '0140']);
    assert.ok(pids.has(0x0C) && pids.has(0x21));
  }],
  ['bitmap PIDs (0x20, 0x40, ...) never come back', async () => {
    const elm = fakeElm({ '0100': ['4100BE3FB811'], '0120': ['412080000001'], '0140': ['414000000000'] });
    const { pids } = await readSupportedPids(elm);
    for (const pid of [0x00, 0x20, 0x40]) assert.equal(pids.has(pid), false, `0x${pid.toString(16)}`);
  }],
  ['NO DATA on 0100: null, so the default gauges are offered', async () => {
    assert.equal(await readSupportedPids(fakeElm({})), null);
    const { offered, undecoded } = pickerChoices(null);
    assert.equal(offered.length, 15, 'every decoder plus battery');
    assert.deepEqual(undecoded, []);
  }],
  ['"?", timeout, and bus errors on 0100 also fall back', async () => {
    for (const code of ['COMMAND_ERROR', 'TIMEOUT', 'BUS_ERROR']) {
      assert.equal(await readSupportedPids(fakeElm({ '0100': code })), null, code);
    }
  }],
  ['garbled or short replies on 0100 fall back', async () => {
    assert.equal(await readSupportedPids(fakeElm({ '0100': ['41 00 BE'] })), null);
    assert.equal(await readSupportedPids(fakeElm({ '0100': ['OK'] })), null);
    assert.equal(await readSupportedPids(fakeElm({ '0100': ['4300'] })), null, 'wrong mode');
  }],
  ['UNABLE TO CONNECT on 0100 is still a connection error', async () => {
    await assert.rejects(readSupportedPids(fakeElm({ '0100': 'UNABLE_TO_CONNECT' })), { code: 'UNABLE_TO_CONNECT' });
  }],
  ['default ticks = the old dashboard, limited to this car', async () => {
    const { pids } = await readSupportedPids(fakeElm(PT_CRUISER));
    const { offered } = pickerChoices(pids);
    assert.equal(defaultKeys(offered).size, 13, '12 gauges + battery');
    assert.equal(defaultKeys(offered).has('iat'), false, 'the PT Cruiser has no 0x0F');
  }],
  ['presets keep what the car has and name what it skipped', async () => {
    const { pids } = await readSupportedPids(fakeElm(PT_CRUISER));
    const { offered } = pickerChoices(pids);
    const preset = (id) => presetKeys(PRESETS.find((p) => p.id === id), offered);
    assert.deepEqual([...preset('basics').keys].sort(), ['battery', 'coolant', 'rpm', 'speed', 'throttle']);
    assert.deepEqual(preset('basics').skipped, []);
    assert.deepEqual(preset('fuel').skipped, ['Intake air temp']);
    assert.equal(preset('fuel').keys.size, 8);
    assert.equal(preset('all').keys.size, offered.length);
  }],
  ['refresh estimate follows the live loop', () => {
    const { offered } = pickerChoices(null);
    const pick = (...keys) => offered.filter((d) => keys.includes(d.key));
    // 2 fast PIDs at 150 ms: one round = 300 + pause.
    assert.deepEqual(estimateRefresh(pick('rpm', 'speed'), 150), { fastMs: 300 + ROUND_PAUSE_MS, slowMs: null });
    // Adding a slow PID costs 1/SLOW_EVERY of a request per round.
    const round = 300 + 150 / SLOW_EVERY + ROUND_PAUSE_MS;
    assert.deepEqual(estimateRefresh(pick('rpm', 'speed', 'coolant'), 150), { fastMs: round, slowMs: round * SLOW_EVERY });
    // Fewer gauges really is faster.
    assert.ok(estimateRefresh(pick('rpm'), 150).fastMs < estimateRefresh(offered, 150).fastMs / 5);
  }],
];

let failed = 0;
const rows = [];
for (const [name, test] of cases) {
  try {
    await test();
    rows.push({ case: name, result: 'pass' });
  } catch (err) {
    failed++;
    rows.push({ case: name, result: `FAIL: ${err.message}` });
  }
}
console.table(rows);
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
