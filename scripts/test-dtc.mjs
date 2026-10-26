// Tests stored, pending, and permanent DTC decoding and service handling.
// Run: node scripts/test-dtc.mjs
import assert from 'node:assert/strict';
import { ElmError, ELM327 } from '../js/elm327.js';
import { DemoTransport } from '../js/demo.js';
import { cleanManufacturerDescription } from '../js/dtc.js';
import { clearCodes, decodeDtcEntries, decodeDtcs, decodeStatus, ecuIdentity, readDtcServices, readScan, toMessages } from '../js/obd.js';

function fakeElm(replies) {
  const sent = [];
  return {
    sent,
    async send(command) {
      sent.push(command);
      const reply = replies[command];
      if (reply === undefined && ['ATS1', 'ATH1', 'ATH0', 'ATS0'].includes(command)) return ['OK'];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new ElmError('NO_DATA', 'NO DATA');
      return reply;
    },
  };
}

const cases = [
  ['manufacturer descriptions drop the fault-type byte, stray letter, and code echoes', () => {
    assert.equal(cleanManufacturerDescription('87: Display: Missing Message O:\u00a0THE\u00a0DISPLAY\u00a0UNIT\u00a0IS\u00a0INOPERATIVE\u00a0(Information and Entertainment System)'),
      'Display: Missing Message — THE DISPLAY UNIT IS INOPERATIVE (Information and Entertainment System)');
    assert.equal(cleanManufacturerDescription('87: PATS Transponder: Missing Message E:\u00a0B10D9:87\u00a0(Passive Anti-Theft System (PATS))'),
      'PATS Transponder: Missing Message (Passive Anti-Theft System (PATS))');
    assert.equal(cleanManufacturerDescription('15: License Plate Light: Circuit Short To Battery '), 'License Plate Light: Circuit Short To Battery');
    assert.equal(cleanManufacturerDescription('Ignition Coil D Secondary Circuit Malfunction'), 'Ignition Coil D Secondary Circuit Malfunction');
  }],
  ['CAN DTCs preserve the ECU source for all supported services', () => {
    for (const [service, reply, code] of [
      [0x03, '7E8 04 43 01 01 30', 'P0130'],
      [0x07, '7E9 04 47 01 01 30', 'P0130'],
      [0x0A, '18DAF110 04 4A 01 04 42', 'P0442'],
    ]) {
      const messages = toMessages([reply]);
      const [entry] = decodeDtcEntries(messages, true, service);
      assert.equal(entry.code, code);
      assert.equal(entry.ecuSource, reply.slice(0, reply.indexOf(' ')));
    }
  }],
  ['headered multi-frame DTC replies are reassembled per ECU', () => {
    const messages = toMessages([
      '7E8 10 08 47 03 01 30 04 42',
      '7E9 04 47 01 01 30',
      '7E8 21 05 10 00 00',
    ]);
    assert.equal(messages.length, 2);
    assert.deepEqual(decodeDtcEntries(messages, true, 0x07), [
      { code: 'P0130', ecuSource: '7E9' },
      { code: 'P0130', ecuSource: '7E8' },
      { code: 'P0442', ecuSource: '7E8' },
      { code: 'P0510', ecuSource: '7E8' },
    ]);
  }],
  ['duplicate codes are deduplicated per ECU but retained across ECUs', () => {
    const messages = toMessages([
      '7E8 06 47 02 01 30 01 30',
      '7E9 04 47 01 01 30',
    ]);
    assert.deepEqual(decodeDtcEntries(messages, true, 0x07), [
      { code: 'P0130', ecuSource: '7E8' },
      { code: 'P0130', ecuSource: '7E9' },
    ]);
  }],
  ['legacy DTC replies decode padded pairs without requiring a CAN count', () => {
    const messages = toMessages(['486B10 47 01 30 00 00 00 00 AB']);
    assert.deepEqual(decodeDtcs(messages, false, 0x07), ['P0130']);
  }],
  ['multi-frame J1850 replies and multi-ECU status come from a real vehicle capture', () => {
    const stored = toMessages(['48 6B 10 43 03 40 06 01 03 51 14', '48 6B 10 43 05 51 13 91 00 00 20']);
    assert.deepEqual(decodeDtcs(stored, false), ['P0340', 'P0601', 'P0351', 'P0551', 'P1391']);
    const status = decodeStatus(toMessages(['410100040000', '41018507E5E5']));
    assert.equal(status.milOn, true);
    assert.equal(status.count, 5);
    assert.ok(status.ecus.every((ecu) => ecu.source === null), 'headerless replies are never assigned to a module');
  }],
  ['module identity is inferred from known addresses and falls back to the raw address', () => {
    assert.deepEqual(ecuIdentity('486B10'), { source: '486B10', name: 'Engine (ECM)', confidence: 'inferred' });
    assert.equal(ecuIdentity('486B18').name, 'Transmission (TCM)');
    assert.equal(ecuIdentity('7E8').name, 'Engine (ECM)');
    assert.equal(ecuIdentity('7EA').confidence, 'unknown');
    assert.equal(ecuIdentity('18DAF140').name, 'Module 40');
  }],
  ['one header-enabled scan attributes status to each module by its header', async () => {
    const elm = fakeElm({
      '0101': ['48 6B 10 41 01 85 07 E5 E5 AA', '48 6B 18 41 01 00 04 00 00 AA'],
      '03': ['48 6B 10 43 03 40 00 00 00 00 AB'],
      '07': ['48 6B 10 47 00 00 00 00 00 00 AB'],
    });
    const { status, services } = await readScan(elm, false);
    assert.deepEqual(elm.sent, ['ATS1', 'ATH1', '0101', '03', '07', '0A', 'ATH0', 'ATS0']);
    assert.deepEqual(status.ecus, [
      { source: '486B10', milOn: true, count: 5 },
      { source: '486B18', milOn: false, count: 0 },
    ]);
    assert.equal(services[2].available, false);
  }],
  ['CAN DTC count and payload length are validated', () => {
    assert.throws(
      () => decodeDtcEntries(toMessages(['47 02 01 30']), true, 0x07),
      { code: 'MALFORMED_RESPONSE' },
    );
  }],
  ['each service is queried and unavailable services stay explicit', async () => {
    const elm = fakeElm({
      '03': ['43010000'],
      '07': ['47010130'],
    });
    const services = await readDtcServices(elm, true);
    assert.deepEqual(elm.sent, ['ATS1', 'ATH1', '03', '07', '0A', 'ATH0', 'ATS0']);
    assert.deepEqual(services.map(({ label, available }) => [label, available]), [
      ['Stored', true],
      ['Pending', true],
      ['Permanent', false],
    ]);
    assert.deepEqual(services[1].codes.map(({ code }) => code), ['P0130']);
    assert.deepEqual(services[0].codes, [], 'a positive empty response is not unsupported');
  }],
  ['unsupported header controls fall back to source-unknown scans and restore spacing', async () => {
    const elm = fakeElm({
      ATH1: new ElmError('COMMAND_ERROR', 'ERROR'),
      '03': ['43010000'],
      '07': ['47010000'],
      '0A': ['4A010000'],
    });
    const services = await readDtcServices(elm, true);
    assert.deepEqual(elm.sent, ['ATS1', 'ATH1', 'ATS0', '03', '07', '0A']);
    assert.ok(services.every((service) => service.available));
  }],
  ['Mode 04 clears stored and pending codes while permanent codes remain', async () => {
    const transport = new DemoTransport('pending');
    await transport.open();
    try {
      const elm = new ELM327(transport);
      await clearCodes(elm);
      const services = await readDtcServices(elm, true);
      assert.deepEqual(services.map((service) => [service.label, service.codes.map(({ code }) => code)]), [
        ['Stored', []],
        ['Pending', []],
        ['Permanent', ['P0442']],
      ]);
    } finally {
      await transport.close();
    }
  }],
  ['unexpected positive response and communication failures are surfaced', async () => {
    await assert.rejects(readDtcServices(fakeElm({
      '03': ['43010000'],
      '07': ['43010000'],
    }), true), { code: 'MALFORMED_RESPONSE' });
    await assert.rejects(readDtcServices(fakeElm({
      '03': new ElmError('BUS_ERROR', 'BUS ERROR'),
    }), true), { code: 'BUS_ERROR' });
  }],
];

let failed = 0;
const results = [];
for (const [name, test] of cases) {
  try {
    await test();
    results.push({ case: name, result: 'pass' });
  } catch (err) {
    failed++;
    results.push({ case: name, result: `FAIL: ${err.message}` });
  }
}
console.table(results);
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
