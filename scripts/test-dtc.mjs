// Tests stored, pending, and permanent DTC decoding and service handling.
// Run: node scripts/test-dtc.mjs
import assert from 'node:assert/strict';
import { ElmError, ELM327 } from '../js/elm327.js';
import { DemoTransport } from '../js/demo.js';
import { clearCodes, decodeDtcEntries, decodeDtcs, decodeStatus, readDtcServices, toMessages } from '../js/obd.js';

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
    assert.deepEqual(decodeStatus(toMessages(['410100040000', '41018507E5E5'])), { milOn: true, count: 5 });
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
