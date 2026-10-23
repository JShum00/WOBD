// Tests for connection troubleshooting (js/troubleshoot.js).
// Run: node scripts/test-troubleshoot.mjs
import assert from 'node:assert/strict';
import { ElmError } from '../js/elm327.js';
import { categorize, diagnoseConnection, protocolSearchUrl } from '../js/troubleshoot.js';

const PT = { year: '2001', make: 'Chrysler', model: 'PT Cruiser' };
const cases = [
  ['each failure type maps to its own category', () => {
    const expected = {
      NOT_ELM: 'adapter', TIMEOUT: 'adapter-timeout', UNABLE_TO_CONNECT: 'car-silent', NO_DATA: 'no-data',
      BUS_ERROR: 'bus-error', MALFORMED_RESPONSE: 'unreadable', COMMAND_ERROR: 'adapter-command',
    };
    for (const [code, category] of Object.entries(expected)) assert.equal(categorize(new ElmError(code, 'x')), category);
    assert.equal(categorize(Object.assign(new Error('x'), { name: 'NetworkError' })), 'adapter');
    assert.equal(categorize(new Error('boom')), 'unknown');
    assert.equal(categorize(undefined), 'unknown');
  }],
  ['adapter silence, car silence, and bus errors get different messages', () => {
    const texts = ['NOT_ELM', 'TIMEOUT', 'UNABLE_TO_CONNECT', 'NO_DATA', 'BUS_ERROR', 'MALFORMED_RESPONSE']
      .map((code) => diagnoseConnection(new ElmError(code, 'x')).text);
    assert.equal(new Set(texts).size, texts.length);
  }],
  ['a CAN ERROR under a forced protocol names it and recommends automatic first', () => {
    const err = new ElmError('BUS_ERROR', 'x', 'CAN ERROR');
    const result = diagnoseConnection(err, { protocol: '6', car: PT });
    assert.equal(result.category, 'bus-error');
    assert.equal(result.adapterReply, 'CAN ERROR');
    assert.equal(result.suggestAutomatic, true);
    assert.ok(result.text.includes('CAN 11-bit 500k'));
    assert.ok(result.text.indexOf('Uncheck') < result.text.indexOf('search'), 'automatic comes before research');
  }],
  ['automatic selection never tells the user to uncheck the override', () => {
    for (const protocol of [null, undefined, '', '0']) {
      const result = diagnoseConnection(new ElmError('UNABLE_TO_CONNECT', 'x'), { protocol, car: PT });
      assert.equal(result.suggestAutomatic, false);
      assert.ok(!result.text.includes('Uncheck'));
    }
  }],
  ['a silent adapter does not blame the protocol or offer a protocol search', () => {
    const result = diagnoseConnection(new ElmError('TIMEOUT', 'x'), { protocol: '6', car: PT });
    assert.equal(result.suggestAutomatic, false);
    assert.equal(result.searchUrl, null);
  }],
  ['search link: encoded, includes the car and failure, only when the car is known', () => {
    const result = diagnoseConnection(new ElmError('UNABLE_TO_CONNECT', 'x'), { car: PT });
    const q = new URL(result.searchUrl).searchParams.get('q');
    assert.equal(q, '2001 Chrysler PT Cruiser OBD-II diagnostic protocol unable to connect');
    assert.equal(diagnoseConnection(new ElmError('UNABLE_TO_CONNECT', 'x'), { car: {} }).searchUrl, null);
    const tricky = protocolSearchUrl({ make: 'A&B', model: 'C D#' });
    assert.ok(tricky.includes(encodeURIComponent('A&B C D#')));
    assert.equal(new URL(tricky).searchParams.size, 1);
  }],
  ['the result is advice, not a protocol verdict', () => {
    const result = diagnoseConnection(new ElmError('UNABLE_TO_CONNECT', 'x'), { car: PT });
    assert.ok(/hint, not a verdict/.test(result.text));
  }],
  ['an unreadable reply is told apart from a silent car', () => {
    const unreadable = diagnoseConnection(new ElmError('MALFORMED_RESPONSE', 'x'));
    const silent = diagnoseConnection(new ElmError('NO_DATA', 'x'));
    assert.notEqual(unreadable.category, silent.category);
    assert.ok(unreadable.text.includes("couldn't make sense"));
  }],
  ['ElmError carries the adapter reply and still works without one', () => {
    assert.equal(new ElmError('BUS_ERROR', 'x', 'CAN ERROR').reply, 'CAN ERROR');
    assert.equal(new ElmError('NO_DATA', 'x').reply, null);
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
