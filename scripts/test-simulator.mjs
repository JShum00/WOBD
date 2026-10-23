// Tests for the car simulator: which protocol a year/make/model gets, and that
// the pretend adapter only connects when the chosen protocol matches the car.
// Run: node scripts/test-simulator.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { DemoTransport } from '../js/demo.js';
import { ELM327 } from '../js/elm327.js';
import * as obd from '../js/obd.js';
import { TrafficLog } from '../js/traffic.js';
import { pickProtocol, vehicleProfile } from '../js/vehicles.js';

// Connects the way the app does. override is a protocol number, or null for automatic.
async function connect(car, override = null, options = {}) {
  const transport = new DemoTransport({ ...vehicleProfile({ ...car, ...options }), initMs: 0, latency: 1, mismatchMs: 1 });
  await transport.open();
  const elm = new ELM327(transport);
  await elm.reset();
  await elm.configure(override ?? '0');
  const supported = await obd.readSupportedPids(elm);
  const protocol = await obd.readProtocol(elm);
  const vin = await obd.readVin(elm);
  const codes = await obd.readStoredCodes(elm, protocol.isCan);
  return { supported, protocol, vin, codes, transport };
}

// The PT Cruiser case from the field: automatic works (ATSP0 then A2), a forced CAN protocol does not.
const PT_CRUISER = { year: '2001', make: 'Chrysler', model: 'PT Cruiser' };

const RANGER = { year: '2001', make: 'Ford', model: 'Ranger' };

const cases = [
  ['protocol: older Ford is J1850 PWM, newer Ford is CAN', () => {
    assert.equal(pickProtocol(RANGER).protocol, '1');
    assert.equal(pickProtocol({ ...RANGER, year: '2012' }).protocol, '6');
  }],
  ['protocol: GM is VPW before 2008', () => {
    assert.equal(pickProtocol({ year: '2003', make: 'Chevrolet', model: 'Silverado 1500' }).protocol, '2');
  }],
  ['protocol: the PT Cruiser rule beats the Chrysler default', () => {
    assert.equal(pickProtocol({ year: '2001', make: 'Chrysler', model: 'PT Cruiser' }).protocol, '2');
    assert.equal(pickProtocol({ year: '2001', make: 'Chrysler', model: 'Sebring' }).protocol, '3');
  }],
  ['protocol: Toyota switches to CAN in 2004, Nissan starts on KWP fast', () => {
    assert.equal(pickProtocol({ year: '2002', make: 'Toyota' }).protocol, '3');
    assert.equal(pickProtocol({ year: '2005', make: 'Toyota' }).protocol, '6');
    assert.equal(pickProtocol({ year: '2001', make: 'Nissan' }).protocol, '5');
  }],
  ['protocol: unknown and missing cars fall back sensibly, matching is case-blind', () => {
    assert.equal(pickProtocol({ year: '2000', make: 'Zastava' }).protocol, '3');
    assert.equal(pickProtocol({ year: '2015', make: 'Zastava' }).protocol, '6');
    assert.equal(pickProtocol({}).protocol, '6');
    assert.equal(pickProtocol({ year: '2001', make: 'FORD' }).protocol, '1');
  }],
  ['automatic search finds the Ranger on PWM', async () => {
    const { protocol, supported } = await connect(RANGER);
    assert.equal(protocol.number, '1');
    assert.equal(protocol.isCan, false);
    assert.ok(supported.pids.size > 0);
  }],
  ['the right override connects, and ATDPN drops the automatic "A"', async () => {
    const { protocol, transport } = await connect(RANGER, '1');
    assert.equal(protocol.number, '1');
    assert.equal(transport.selected, '1');
  }],
  ['a wrong override cannot connect', async () => {
    for (const wrong of ['2', '3']) {
      await assert.rejects(connect(RANGER, wrong), { code: 'UNABLE_TO_CONNECT' }, `override ${wrong}`);
    }
    await assert.rejects(connect(RANGER, '6'), { code: 'BUS_ERROR', reply: 'CAN ERROR' });
  }],
  ['PT Cruiser: automatic search connects and ATDPN reports A2', async () => {
    const { protocol, transport } = await connect(PT_CRUISER);
    assert.equal(protocol.number, '2');
    assert.equal(transport.selected, '0');
    assert.deepEqual(await new ELM327(transport).send('ATDPN'), ['A2']);
  }],
  ['PT Cruiser: forcing ATSP6 gives CAN ERROR, and the app can explain it', async () => {
    const err = await connect(PT_CRUISER, '6').catch((e) => e);
    assert.equal(err.code, 'BUS_ERROR');
    assert.equal(err.reply, 'CAN ERROR');
    const { diagnoseConnection } = await import('../js/troubleshoot.js');
    const advice = diagnoseConnection(err, { protocol: '6', car: PT_CRUISER });
    assert.match(advice.text, /automatic/i);
    assert.equal(advice.suggestAutomatic, true);
    assert.match(advice.text, /CAN 11-bit 500k/);
  }],
  ['a definitive CAN ERROR on the first request ends connecting with no more requests', async () => {
    const transport = new DemoTransport({ ...vehicleProfile(PT_CRUISER), initMs: 0, latency: 1, mismatchMs: 1 });
    await transport.open();
    const elm = new ELM327(transport);
    await elm.reset();
    await elm.configure('6');
    const sent = [];
    const send = elm.send.bind(elm);
    elm.send = (command, ...rest) => { sent.push(command); return send(command, ...rest); };
    await assert.rejects(obd.readSupportedPids(elm, { headers: true }), { code: 'BUS_ERROR' });
    assert.deepEqual(sent.filter((c) => /^01/.test(c)), ['0100']);
    assert.ok(!sent.includes('ATDP') && !sent.includes('ATDPN'), 'no protocol queries after a definitive failure');
    assert.ok(sent.includes('ATH0') && sent.includes('ATS0'), 'temporary header settings are put back');
  }],
  ['transient bus trouble (BUS BUSY) on the first request still falls back, not fails', async () => {
    const elm = { send: async () => { const { ElmError } = await import('../js/elm327.js'); throw new ElmError('BUS_ERROR', 'busy', 'BUS BUSY'); } };
    assert.equal(await obd.readSupportedPids(elm), null);
  }],
  ['a CAN car rejects a legacy override', async () => {
    await assert.rejects(connect({ year: '2015', make: 'Honda', model: 'Civic' }, '3'), { code: 'UNABLE_TO_CONNECT' });
  }],
  ['"automatic search fails" only connects with the right override', async () => {
    await assert.rejects(connect(RANGER, null, { autoFails: true }), { code: 'UNABLE_TO_CONNECT' });
    const { protocol } = await connect(RANGER, '1', { autoFails: true });
    assert.equal(protocol.number, '1');
  }],
  ['ATDP and ATDPN describe the selection', async () => {
    const t = new DemoTransport({ ...vehicleProfile(RANGER), initMs: 0, latency: 1 });
    const elm = new ELM327(t);
    assert.deepEqual(await elm.send('ATDPN'), ['A0']);
    await elm.send('ATSP1');
    assert.deepEqual(await elm.send('ATDPN'), ['1']);
    assert.deepEqual(await elm.send('ATDP'), ['SAE J1850 PWM']);
    await elm.send('0100');
    await elm.send('ATSP0');
    await elm.send('0100');
    assert.deepEqual(await elm.send('ATDPN'), ['A1']);
    assert.deepEqual(await elm.send('ATDP'), ['AUTO, SAE J1850 PWM']);
  }],
  ['VIN and codes follow the car and the code set', async () => {
    const old = await connect(RANGER, null, { codeSet: 'brand' });
    assert.equal(old.vin, null);
    assert.deepEqual(old.codes, ['P0420', 'P1491']);
    const modern = await connect({ year: '2015', make: 'Honda', model: 'Civic' }, null, { codeSet: 'none' });
    assert.equal(modern.vin, 'SMLTD000000000001');
    assert.deepEqual(modern.codes, []);
  }],
  ['every legacy protocol connects automatically and with its own override', async () => {
    for (const make of ['Ford', 'Chevrolet', 'Honda', 'Volkswagen', 'Nissan']) {
      const car = { year: '2000', make, model: '' };
      const { protocol } = await connect(car);
      assert.equal((await connect(car, protocol.number)).protocol.number, protocol.number, make);
    }
  }],
  ['an invalid ATSP gets a question mark', async () => {
    const elm = new ELM327(new DemoTransport('can'));
    await assert.rejects(elm.send('ATSPZ'), { code: 'COMMAND_ERROR' });
  }],
  ['traffic log: pairs commands with replies and shows every line of a reply', async () => {
    const log = new TrafficLog();
    const t = new DemoTransport({ ...vehicleProfile(RANGER), initMs: 0, latency: 1 });
    log.attach(t);
    const elm = new ELM327(t);
    await elm.send('ATSP0');
    await elm.send('0100');
    const text = log.toText();
    assert.match(text, /→ ATSP0\n.*← OK\n.*→ 0100\n.*← SEARCHING\.\.\. \| 4100BE3C9810/);
  }],
  ['traffic log: unanswered commands are noted, garbage is made visible, no-prompt text is flushed', async () => {
    const log = new TrafficLog();
    const t = { onData() {}, tap: null, write: async (text) => t.tap('tx', text) };
    log.attach(t);
    const elm = new ELM327(t, { timeout: 20 });
    await assert.rejects(elm.send('ATZ'), { code: 'TIMEOUT' });
    t.tap('rx', '\u00ff\u00fe');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const text = log.toText();
    assert.match(text, /→ ATZ/);
    assert.match(text, /· No reply to "ATZ" after 20 ms/);
    assert.match(text, /← \\xFF\\xFE \(no ">" prompt\)/);
  }],
  ['traffic log: millisecond stamps, and the VIN reply is masked only when asked', async () => {
    const log = new TrafficLog();
    const t = {};
    log.attach(t);
    t.tap('tx', '0902\r');
    t.tap('rx', '014\r0: 490201574\r1: 44\r\r>');
    t.tap('tx', '0100\r');
    t.tap('rx', '4100BE3C9810\r\r>');
    t.tap('tx', '0902\r');
    t.tap('rx', 'NO DATA\r\r>');
    assert.match(log.toText(), /^ *\d+\.\d{3}s → 0902\n.*← 014 \| 0: 490201574 \| 1: 44/);
    const masked = log.toText({ maskVin: true });
    assert.match(masked, /← XXX \| X: XXXXXXXXX \| X: XX\n/);
    assert.match(masked, /← 4100BE3C9810\n/);
    assert.match(masked, /← NO DATA$/);
  }],
  ['traffic log: replies split across chunks join up, and the log is capped', () => {
    const log = new TrafficLog();
    log.add('note', 'start');
    log.tap = null;
    const t = {};
    log.attach(t);
    t.tap('rx', '4100BE');
    t.tap('rx', '3C9810\r\r>');
    assert.match(log.toText(), /← 4100BE3C9810$/);
    for (let i = 0; i < 1200; i++) log.add('tx', `0${i}`);
    assert.equal(log.entries.length, 1000);
  }],
];

let failed = 0;
const rows = [];
for (const [name, run] of cases) {
  try {
    await run();
    rows.push({ case: name, result: 'PASS' });
  } catch (err) {
    failed++;
    rows.push({ case: name, result: 'FAIL' });
    console.error(`FAIL ${name}\n${err.stack}`);
  }
}
console.table(rows);
if (failed) {
  console.error(`${failed} of ${cases.length} failed.`);
  process.exit(1);
}
console.log(`All ${cases.length} cases passed.`);
