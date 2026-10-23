// Tests for the supported-PID query (0100 and its chain) and the gauge picker's
// logic, with a fake adapter that answers from canned replies.
// Run: node scripts/test-supported-pids.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { ElmError } from '../js/elm327.js';
import {
  BATTERY, LIVE_PIDS, MODE01_DECODERS, PRESETS, ROUND_PAUSE_MS, SLOW_EVERY,
  buildPidCatalog, pollingInterval, readPid, readSupportedPids, decodeSupportedPids, toMessages,
} from '../js/obd.js';
import { automaticKeys, defaultKeys, estimateRefresh, pickerChoices, presetKeys } from '../js/gauge-picker.js';

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
      if (reply === undefined && ['ATS1', 'ATH1', 'ATH0', 'ATS0'].includes(command)) return ['OK'];
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
  ['header-aware parser preserves 11-bit CAN ECU source and strips PCI length', () => {
    const [message] = toMessages(['7E8 06 41 00 BE 3C 98 10']);
    assert.deepEqual([...message], [0x41, 0x00, 0xBE, 0x3C, 0x98, 0x10]);
    assert.equal(message.ecuSource, '7E8');
  }],
  ['automatic mode selects every supported monitorable decoder and keeps legacy defaults', async () => {
    const { pids } = await readSupportedPids(fakeElm({
      '0100': ['4100BE3FB811'],
      '0120': ['412080022001'],
      '0140': ['414044008010'],
    }));
    const { offered } = pickerChoices(pids);
    const selected = automaticKeys(offered);
    assert.equal(selected.size, offered.length);
    assert.equal(selected.has('battery'), true);
    assert.equal(defaultKeys(offered).has('modulevoltage'), false);
    assert.equal(defaultKeys(offered).has('speed'), true);
  }],
  ['automatic polling staggers priority while manual keeps the existing cadence', () => {
    const def = (key) => LIVE_PIDS.find((item) => item.key === key);
    assert.equal(pollingInterval(def('rpm'), 'automatic'), 1);
    assert.equal(pollingInterval(def('stft'), 'automatic'), 3);
    assert.equal(pollingInterval(def('coolant'), 'automatic'), 8);
    assert.equal(pollingInterval(def('rpm'), 'manual'), 1);
    assert.equal(pollingInterval(def('coolant'), 'manual'), SLOW_EVERY);
  }],
  ['header-aware parser preserves 29-bit and legacy ECU source', () => {
    const [can, legacy] = toMessages([
      '18DAF110 06 41 00 BE 3C 98 10',
      '48 6B 10 41 00 BE 3C 98 10 F9',
    ]);
    assert.equal(can.ecuSource, '18DAF110');
    assert.equal(legacy.ecuSource, '486B10');
    assert.equal(decodeSupportedPids([can]).valid, true);
    assert.equal(decodeSupportedPids([legacy]).valid, true);
  }],
  ['supported PID page rejects extra payload bytes', () => {
    const page = decodeSupportedPids(toMessages(['4100BE3C981000']));
    assert.equal(page.valid, false);
    assert.equal(page.pids.size, 0);
  }],
  ['header-enabled discovery keeps per-ECU maps and restores adapter formatting', async () => {
    const elm = fakeElm({
      '0100': [
        '7E8 06 41 00 BE 3F B8 11',
        '7E9 06 41 00 80 18 00 00',
      ],
      '0120': [
        '7E8 06 41 20 80 02 20 01',
        '7E9 06 41 20 00 00 00 00',
      ],
      '0140': ['7E8 06 41 40 44 00 80 10'],
    });
    const result = await readSupportedPids(elm, { headers: true });
    assert.equal(result.ecus.length, 2);
    assert.equal(result.ecus.find((ecu) => ecu.source === '7E8').pids.has(0x21), true);
    assert.equal(result.ecus.find((ecu) => ecu.source === '7E9').pids.has(0x21), false);
    assert.equal(result.ecus.find((ecu) => ecu.source === '7E8').pids.has(0x5C), true);
    assert.deepEqual(elm.sent, ['ATS1', 'ATH1', '0100', '0120', '0140', 'ATH0', 'ATS0']);
  }],
  ['header-mode discovery restores adapter formatting when a range errors', async () => {
    const elm = fakeElm({ '0100': ['NO DATA'] });
    assert.equal(await readSupportedPids(elm, { headers: true }), null);
    assert.deepEqual(elm.sent, ['ATS1', 'ATH1', '0100', 'ATH0', 'ATS0']);
  }],
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
    assert.deepEqual(undecoded, [], 'the supported OBD standard PID has a decoder but is not a gauge');
    assert.equal(MODE01_DECODERS.has(0x1C), true);
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
    assert.deepEqual(undecoded.map((u) => u.pid), [0x13, 0x33, 0x51]);
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
    assert.equal(offered.length, LIVE_PIDS.length + 1, 'every live decoder plus battery');
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
  ['new PID formulas decode exact verified payload shapes', async () => {
    const data = [
      [0x21, '41210102', 258],
      [0x31, '41310102', 258],
      [0x23, '41230064', 1000],
      [0x3C, '413C01F4', 50],
      [0x42, '414236B0', 14],
      [0x44, '41448000', 1],
      [0x24, '412480004000', 1],
      [0x34, '413480004000', 1],
      [0x53, '415303E8', 5],
      [0x46, '414650', 104],
      [0x5C, '415C50', 104],
    ];
    for (const [pid, reply, expected] of data) {
      const def = MODE01_DECODERS.get(pid);
      assert.equal(await readPid(fakeElm({ [`01${pid.toString(16).toUpperCase().padStart(2, '0')}`]: [reply] }), def), expected);
    }
  }],
  ['readPidDetailed keeps raw bytes, second values, and says why a read failed', async () => {
    const { readPidDetailed, FAILURE_REASONS } = await import('../js/obd.js');
    const wide = await readPidDetailed(fakeElm({ '0124': ['412480004000'] }), MODE01_DECODERS.get(0x24));
    assert.equal(wide.value, 1);
    assert.equal(wide.raw, '80004000');
    assert.deepEqual(wide.extras.map((e) => [e.def.key, e.value]), [['wideband1v_volts', 2]]);
    const short = await readPidDetailed(fakeElm({ '0124': ['41248000'] }), MODE01_DECODERS.get(0x24));
    assert.deepEqual([short.value, short.raw, short.failure], [null, '8000', 'malformed']);
    const none = await readPidDetailed(fakeElm({ '0124': ['NO DATA'] }), MODE01_DECODERS.get(0x24)).catch((err) => ({ failure: 'no-response', err }));
    assert.equal(none.failure, 'no-response');
    const bare = await readPidDetailed(fakeElm({ '0155': ['41551A2B'] }), { pid: 0x55 });
    assert.deepEqual([bare.value, bare.raw, bare.failure], [null, '1A2B', null]);
    assert.ok(Object.values(FAILURE_REASONS).every((reason) => reason.short && reason.text));
  }],
  ['PID reads reject malformed lengths instead of decoding partial bytes', async () => {
    const def = MODE01_DECODERS.get(0x42);
    await assert.rejects(readPid(fakeElm({ '0142': ['414236'] }), def), { code: 'MALFORMED_RESPONSE' });
    await assert.rejects(readPid(fakeElm({ '0142': ['414236B000'] }), def), { code: 'MALFORMED_RESPONSE' });
  }],
  ['dynamic catalog reports decoder, status, units, and ECU sources', () => {
    const catalog = buildPidCatalog(new Set([0x1C, 0x21, 0x55]), [
      { source: '7E8', pids: new Set([0x1C, 0x21]) },
      { source: '7E9', pids: new Set([0x21]) },
    ]);
    assert.deepEqual(catalog.map(({ pid }) => pid), [0x1C, 0x21, 0x55]);
    assert.deepEqual(catalog[0].ecuSources, ['7E8']);
    assert.equal(catalog[0].decoderAvailable, true);
    assert.equal(catalog[0].monitorable, false);
    assert.equal(catalog[1].unit, 'km');
    assert.deepEqual(catalog[1].ecuSources, ['7E8', '7E9']);
    assert.equal(catalog[2].decoderAvailable, false);
  }],
  ['fuel level 0x2F decodes 0, mid-scale and full, and rejects bad lengths', async () => {
    const def = LIVE_PIDS.find((d) => d.pid === 0x2F);
    assert.equal(def.unit, '%');
    assert.equal(await readPid(fakeElm({ '012F': ['412F00'] }), def), 0);
    assert.equal(await readPid(fakeElm({ '012F': ['412FFF'] }), def), 100);
    assert.ok(Math.abs(await readPid(fakeElm({ '012F': ['412F80'] }), def) - 50.196) < 0.01);
    await assert.rejects(readPid(fakeElm({ '012F': ['412F8080'] }), def), { code: 'MALFORMED_RESPONSE' });
    await assert.rejects(readPid(fakeElm({ '012F': ['412F'] }), def), { code: 'MALFORMED_RESPONSE' });
    assert.equal(await readPid(fakeElm({ '012F': ['NO DATA'] }), def), null);
  }],
  ['fuel level is only offered when the car advertises it', () => {
    const withFuel = pickerChoices(new Set([0x0C, 0x2F]));
    assert.ok(withFuel.offered.some((d) => d.key === 'fuellevel'));
    assert.ok(!withFuel.undecoded.some((u) => u.pid === 0x2F));
    const without = pickerChoices(new Set([0x0C]));
    assert.ok(!without.offered.some((d) => d.key === 'fuellevel'));
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
