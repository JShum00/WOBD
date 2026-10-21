// Tests for baud rate detection. Run: node scripts/test-smartbauder.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import { detectBaud, abortOnUnplug, BASE_RATES } from '../js/smartbauder.js';
import { ELM327, ElmError } from '../js/elm327.js';
import { SerialTransport } from '../js/serial.js';
import { DemoBaudTransport } from '../js/demo.js';

// ---------- Fakes ----------

// Pretend localStorage that counts every access.
const store = new Map();
let storageCalls = 0;
const workingStorage = {
  getItem: (k) => { storageCalls++; return store.get(k) ?? null; },
  setItem: (k, v) => { storageCalls++; store.set(k, String(v)); },
};
const brokenStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};
function resetStorage(initial = {}) {
  store.clear();
  for (const [k, v] of Object.entries(initial)) store.set(k, v);
  storageCalls = 0;
  globalThis.localStorage = workingStorage;
}

// A transport-level adapter that only answers at `rate`.
class FakeTransport {
  constructor({ rate, info = {}, wrong = 'silent', questionFirst = false }) {
    Object.assign(this, { rate, info, wrong, questionFirst });
    this.opens = [];
    this.commands = [];
    this.resets = 0;
    this.asked = 0;
    this.isOpen = false;
    this.onData = () => {};
  }

  async open(rate) {
    if (this.isOpen) throw new Error('already open');
    this.isOpen = true;
    this.cur = rate;
    this.opens.push(rate);
  }

  async close() { this.isOpen = false; }

  async write(text) {
    const command = text.trim();
    this.commands.push(command);
    if (this.cur !== this.rate) {
      if (this.wrong === 'garbage') setTimeout(() => this.onData('\u00ff\u00fe\u0000>\u00c3>'), 5);
      return;
    }
    if (command === 'ATI') {
      this.asked++;
      const reply = this.questionFirst && this.asked === 1 ? '?\r\r>' : 'ATI\rELM327 v1.5\r\r>';
      setTimeout(() => this.onData(reply), 5);
    } else if (command === 'ATZ') {
      this.resets++;
      setTimeout(() => this.onData('\r\rELM327 v1.5\r\r>'), 5);
    } else {
      setTimeout(() => this.onData('OK\r\r>'), 5);
    }
  }
}

// A SerialPort with real streams, so SerialTransport's read loop and lock handling run for real.
class FakePort extends EventTarget {
  constructor({ rate, info = {} }) {
    super();
    Object.assign(this, { rate, info, opened: false, readable: null, writable: null, opens: [] });
  }

  getInfo() { return this.info; }

  async open({ baudRate }) {
    if (this.opened) throw new DOMException('Port is already open.', 'InvalidStateError');
    this.opened = true;
    this.cur = baudRate;
    this.opens.push(baudRate);
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    this.writable = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk).trim();
        if (this.cur !== this.rate || text !== 'ATI') return;
        setTimeout(() => this.controller.enqueue(new TextEncoder().encode('ELM327 v1.5\r\r>')), 5);
      },
    });
  }

  // Like the real thing, refuses to close while a stream is still locked.
  async close() {
    if (this.readable?.locked || this.writable?.locked) throw new TypeError('A stream is still locked.');
    this.opened = false;
    this.readable = null;
    this.writable = null;
  }

  // Cable pulled: pending read rejects with NetworkError and readable goes away.
  failRead() {
    const { controller } = this;
    this.readable = null;
    this.writable = null;
    controller.error(new DOMException('The device has been lost.', 'NetworkError'));
  }

  disconnectEvent() {
    this.readable = null;
    this.writable = null;
    this.dispatchEvent(new Event('disconnect'));
  }
}

// ---------- Harness ----------

const rows = [];
const failures = [];

async function test(name, fn) {
  const row = { case: name, detected: '-', opens: '-', ATZ: '-', port: '-' };
  const t0 = Date.now();
  try {
    await fn(row);
    row.result = 'PASS';
  } catch (err) {
    row.result = 'FAIL';
    failures.push({ name, err });
  }
  row.time = `${Date.now() - t0} ms`;
  rows.push(row);
}

const FTDI = { usbVendorId: 0x0403, usbProductId: 0x6001 };
const CH340 = { usbVendorId: 0x1a86, usbProductId: 0x7523 };
const FTDI_KEY = 'wobd.baud.0403:6001';
const CH340_KEY = 'wobd.baud.1a86:7523';

// Detects, then (on success) resets and configures like openAdapter() does.
async function detectCase(row, transport, expected, detectOptions = {}) {
  const rate = await detectBaud(transport, detectOptions);
  row.detected = rate ?? 'null';
  row.opens = transport.opens.join(',');
  row.port = transport.isOpen ? 'open' : 'closed';

  assert.equal(rate, expected.rate, 'detected rate');
  assert.deepEqual(transport.opens, expected.opens, 'rates opened, in order');
  if (rate === null) {
    assert.equal(transport.isOpen, false, 'port closed after failure');
    assert.equal(transport.resets, 0, 'no ATZ after failure');
  } else {
    assert.equal(transport.isOpen, true, 'port open after success');
    const elm = new ELM327(transport);
    await elm.reset();
    await elm.configure(expected.protocol ?? '0');
    row.ATZ = transport.resets;
    assert.equal(transport.resets, 1, 'ATZ sent exactly once');
    assert.ok(transport.commands.includes(`ATSP${expected.protocol ?? '0'}`), 'selected protocol configured');
    assert.equal(transport.commands.some((command) => /^ATSP[1-9A-C]$/.test(command)), Boolean(expected.protocol),
      'automatic selection remains default unless overridden');
  }
  if (expected.cache) assert.deepEqual(Object.fromEntries(store), expected.cache, 'cache contents');
}

assert.deepEqual(BASE_RATES, [115200, 38400, 9600, 57600, 230400], 'base rate order');

// ---------- Detection ----------

await test('CH340 at 38400 (vendor order)', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 38400, info: CH340 }),
    { rate: 38400, opens: [38400], cache: { [CH340_KEY]: '38400' } });
});

await test('FTDI at 115200 (first attempt)', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 115200, info: FTDI }),
    { rate: 115200, opens: [115200], cache: { [FTDI_KEY]: '115200' } });
});

await test('No USB info, 9600, silent', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 9600 }),
    { rate: 9600, opens: [115200, 38400, 9600], cache: {} });
});

await test('Garbage with ">" at wrong rates', async (row) => {
  resetStorage();
  const t0 = Date.now();
  await detectCase(row, new FakeTransport({ rate: 9600, wrong: 'garbage' }),
    { rate: 9600, opens: [115200, 38400, 9600], cache: {} });
  assert.ok(Date.now() - t0 < 600, 'garbage is rejected without waiting out the silence timeout');
});

await test('"?" on first ATI at the right rate', async (row) => {
  resetStorage();
  const t = new FakeTransport({ rate: 38400, questionFirst: true });
  await detectCase(row, t, { rate: 38400, opens: [115200, 38400], cache: {} });
  assert.equal(t.asked, 2, 'ATI was retried once');
});

await test('FTDI at 9600, first run fills cache', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 9600, info: FTDI }),
    { rate: 9600, opens: [115200, 38400, 9600], cache: { [FTDI_KEY]: '9600' } });
});

await test('FTDI at 9600, cached run opens only 9600', async (row) => {
  resetStorage({ [FTDI_KEY]: '9600' });
  await detectCase(row, new FakeTransport({ rate: 9600, info: FTDI }),
    { rate: 9600, opens: [9600], cache: { [FTDI_KEY]: '9600' } });
});

await test('Stale cache (38400) is tried first, then replaced', async (row) => {
  resetStorage({ [FTDI_KEY]: '38400' });
  await detectCase(row, new FakeTransport({ rate: 9600, info: FTDI }),
    { rate: 9600, opens: [38400, 115200, 9600], cache: { [FTDI_KEY]: '9600' } });
});

await test('Junk cache value is ignored', async (row) => {
  resetStorage({ [FTDI_KEY]: '12345' });
  await detectCase(row, new FakeTransport({ rate: 115200, info: FTDI }),
    { rate: 115200, opens: [115200], cache: { [FTDI_KEY]: '115200' } });
});

await test('No rate answers', async (row) => {
  resetStorage();
  const t0 = Date.now();
  await detectCase(row, new FakeTransport({ rate: 460800, info: CH340 }),
    { rate: null, opens: [38400, 115200, 9600, 57600, 230400], cache: {} });
  assert.ok(Date.now() - t0 < 4500, 'five silent rates take about 5 x 700 ms');
});

await test('Manual rate [9600] works and is cached', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 9600, info: CH340 }),
    { rate: 9600, opens: [9600], cache: { [CH340_KEY]: '9600' } }, { rates: [9600] });
});

await test('Explicit CAN protocol configures ATSP6 instead of auto mode', async (row) => {
  resetStorage();
  await detectCase(row, new FakeTransport({ rate: 38400 }), {
    rate: 38400, opens: [115200, 38400], protocol: '6',
  });
});

await test('Storage that throws does not break detection', async (row) => {
  resetStorage();
  globalThis.localStorage = brokenStorage;
  try {
    await detectCase(row, new FakeTransport({ rate: 38400, info: CH340 }), { rate: 38400, opens: [38400] });
  } finally {
    globalThis.localStorage = workingStorage;
  }
});

// ---------- Abort and unplug ----------

await test('Abort mid-detection, then detect again', async (row) => {
  resetStorage();
  const t = new FakeTransport({ rate: 9600 });
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error('CANCELLED')), 200);
  const t0 = Date.now();
  const err = await detectBaud(t, { signal: abort.signal }).then(() => null, (e) => e);
  const ms = Date.now() - t0;
  row.detected = err?.message ?? 'resolved';
  row.opens = t.opens.join(',');
  row.port = t.isOpen ? 'open' : 'closed';

  assert.equal(err?.message, 'CANCELLED', 'rejects with the abort reason');
  assert.ok(ms < 350, `rejected in ${ms} ms`);
  assert.deepEqual(t.opens, [115200], 'stopped after the first rate');
  assert.equal(t.isOpen, false, 'port closed after abort');

  assert.equal(await detectBaud(t, {}), 9600, 'following detect succeeds');
  assert.deepEqual(t.opens, [115200, 115200, 38400, 9600]);
  assert.equal(t.isOpen, true);
  row.ATZ = 'n/a';
});

await test('Already-aborted signal opens nothing', async (row) => {
  resetStorage();
  const t = new FakeTransport({ rate: 9600 });
  const err = await detectBaud(t, { signal: AbortSignal.abort(new Error('CANCELLED')) }).then(() => null, (e) => e);
  row.detected = err?.message ?? 'resolved';
  row.opens = t.opens.join(',') || 'none';
  row.port = t.isOpen ? 'open' : 'closed';
  assert.equal(err?.message, 'CANCELLED');
  assert.deepEqual(t.opens, []);
  assert.equal(t.isOpen, false);
});

// Real SerialTransport on a fake port: a probe is pending (silent rate) when `inject` runs.
async function unplugCase(row, inject) {
  resetStorage();
  const port = new FakePort({ rate: 9600 });
  const transport = new SerialTransport(port);
  const abort = abortOnUnplug(transport);
  let notifications = 0;
  const notify = transport.onDisconnect;
  transport.onDisconnect = (e) => { notifications++; notify(e); };

  setTimeout(() => inject(port), 200);
  const t0 = Date.now();
  const err = await detectBaud(transport, { signal: abort.signal }).then(() => null, (e) => e);
  const ms = Date.now() - t0;
  row.detected = err?.code ?? 'resolved';
  row.opens = port.opens.join(',');
  row.port = port.opened ? 'open' : 'closed';

  assert.ok(err instanceof ElmError, 'rejects with an ElmError');
  assert.equal(err.code, 'UNPLUGGED');
  assert.match(err.message, /unplugged/);
  assert.ok(ms < 350, `rejected in ${ms} ms`);
  assert.equal(notifications, 1, 'unplug reported exactly once');
  assert.deepEqual(port.opens, [115200], 'stopped after the first rate');
  assert.equal(port.opened, false, 'port closed');

  // The next Connect asks for a port again, so it gets a new SerialPort and a new transport.
  const next = new SerialTransport(new FakePort({ rate: 115200, info: FTDI }));
  assert.equal(await detectBaud(next, {}), 115200, 'a following connect works');
}

await test('Real unplug: read NetworkError mid-probe', (row) => unplugCase(row, (port) => port.failRead()));
await test('Real unplug: disconnect event mid-probe', (row) => unplugCase(row, (port) => port.disconnectEvent()));
await test('Real unplug: read error and event together', (row) => unplugCase(row, (port) => {
  port.failRead();
  port.dispatchEvent(new Event('disconnect'));
}));

await test('Real port: cancel releases locks, same transport reconnects', async (row) => {
  resetStorage();
  const port = new FakePort({ rate: 9600 });
  const transport = new SerialTransport(port);
  const abort = new AbortController();
  setTimeout(() => abort.abort(new ElmError('CANCELLED', 'Cancelled.')), 200);
  const err = await detectBaud(transport, { signal: abort.signal }).then(() => null, (e) => e);
  row.detected = err?.code ?? 'resolved';
  row.opens = port.opens.join(',');
  row.port = port.opened ? 'open' : 'closed';

  assert.equal(err?.code, 'CANCELLED');
  assert.equal(port.opened, false, 'port closed (a leaked lock would leave it open)');
  assert.equal(await detectBaud(transport, {}), 9600, 'same transport detects again');
  assert.equal(port.opened, true);
});

// ---------- Demo variants ----------

await test('slowbaud demo answers on the 4th rate and skips the cache', async (row) => {
  resetStorage();
  const t = new DemoBaudTransport('slowbaud');
  const attempts = [];
  const rate = await detectBaud(t, { onProgress: (p) => attempts.push(`${p.attempt}/${p.total}`) });
  row.detected = rate ?? 'null';
  row.opens = t.opens;
  row.port = 'n/a';
  assert.equal(rate, BASE_RATES[3]);
  assert.equal(t.opens, 4, 'three silent rates, then an answer');
  assert.deepEqual(attempts, ['1/5', '2/5', '3/5', '4/5']);
  assert.match(await new ELM327(t).reset(), /ELM327/, 'then acts like the normal demo adapter');
  assert.equal(storageCalls, 0, 'never touches the baud cache');
});

await test('nobaud demo fails the sweep, then any manual rate works', async (row) => {
  resetStorage();
  const t = new DemoBaudTransport('nobaud');
  assert.equal(await detectBaud(t, {}), null, 'automatic sweep finds nothing');
  assert.equal(t.opens, BASE_RATES.length);
  assert.equal(await detectBaud(t, { rates: [9600] }), 9600, 'manual rate answers');
  row.detected = 9600;
  row.opens = t.opens;
  row.port = 'n/a';
  assert.match(await new ELM327(t).reset(), /ELM327/);
  assert.equal(storageCalls, 0, 'never touches the baud cache');
});

// ---------- Report ----------

console.table(rows);
if (failures.length) {
  console.error(`\n${failures.length} of ${rows.length} cases failed:`);
  for (const { name, err } of failures) console.error(`\n- ${name}\n  ${err.message.split('\n').join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${rows.length} cases passed.`);
}
