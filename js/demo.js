// A pretend ELM327 for trying WOBD without a car. Open the site with ?demo
// (a CAN car with codes), ?demo=iso (an older ISO 9141 car, like a 2001
// PT Cruiser, with no VIN support), or ?demo=clear (no codes).
// ?demo=slowbaud and ?demo=nobaud go through baud rate detection (see DemoBaudTransport).
import { BASE_RATES } from './smartbauder.js';

const SCENARIOS = {
  can: { protocol: '6', vin: '1HGCM82633A004352', codes: ['P0301', 'P0171', 'P0442'] },
  iso: { protocol: '3', vin: null, codes: ['P0420', 'P1491'] },
  clear: { protocol: '6', vin: '1HGCM82633A004352', codes: [] },
};

const hex2 = (n) => Math.round(n).toString(16).toUpperCase().padStart(2, '0');

function dtcBytes(code) {
  const a = ('PCBU'.indexOf(code[0]) << 6) | (Number(code[1]) << 4) | parseInt(code[2], 16);
  return [a, parseInt(code.slice(3), 16)];
}

// Splits a long CAN reply into the ELM327's numbered multi-frame format.
function canLines(bytes) {
  if (bytes.length <= 7) return [bytes.map(hex2).join('')];
  const lines = [bytes.length.toString(16).toUpperCase().padStart(3, '0')];
  let rest = bytes;
  for (let i = 0; rest.length; i++) {
    const size = i === 0 ? 6 : 7;
    const chunk = rest.slice(0, size);
    rest = rest.slice(size);
    while (chunk.length < size) chunk.push(0);
    lines.push(`${(i % 16).toString(16).toUpperCase()}:${chunk.map(hex2).join('')}`);
  }
  return lines;
}

export class DemoTransport {
  constructor(name) {
    this.scenario = SCENARIOS[name] ?? SCENARIOS.can;
    this.codes = [...this.scenario.codes];
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.searched = false;
    this.startedAt = performance.now();
    this.engine = { rpm: 760, coolant: 150, load: 21, throttle: 14 };
  }

  get isCan() { return this.scenario.protocol === '6'; }

  async open() {}
  async close() {}

  async write(text) {
    const command = text.trim().toUpperCase().replace(/\s+/g, '');
    const lines = this.#reply(command);
    const delay = command === '0100' && !this.searched ? 1400 : 40 + Math.random() * 60;
    if (command === '0100') this.searched = true;
    setTimeout(() => this.onData(`${lines.join('\r')}\r\r>`), delay);
  }

  #reply(cmd) {
    if (cmd === 'ATZ') return ['', 'ELM327 v1.5'];
    if (cmd === 'ATDPN') return [`A${this.scenario.protocol}`];
    if (cmd === 'ATI') return ['ELM327 v1.5'];
    if (cmd === 'ATDP') return [this.isCan ? 'AUTO, ISO 15765-4 (CAN 11/500)' : 'AUTO, ISO 9141-2'];
    if (cmd === 'ATRV') return [`${(13.9 + Math.random() * 0.3).toFixed(1)}V`];
    if (cmd.startsWith('AT')) return ['OK'];

    const prefix = this.searched ? [] : [this.isCan ? 'SEARCHING...' : 'BUS INIT: ...OK'];
    switch (cmd) {
      case '0100': return [...prefix, '4100BE3FB811'];
      case '0101': {
        const a = (this.codes.length ? 0x80 : 0) | this.codes.length;
        return [`4101${hex2(a)}076500`];
      }
      case '03': return this.#storedCodes();
      case '04':
        this.codes = [];
        return ['44'];
      case '0902':
        if (!this.scenario.vin) return ['NO DATA'];
        return canLines([0x49, 0x02, 0x01, ...[...this.scenario.vin].map((c) => c.charCodeAt(0))]);
      default:
        return this.#livePid(cmd) ?? ['NO DATA'];
    }
  }

  #storedCodes() {
    const bytes = this.codes.flatMap(dtcBytes);
    if (this.isCan) return canLines([0x43, this.codes.length, ...bytes]);
    // Older protocols: three codes per line, padded with 0000.
    const lines = [];
    for (let i = 0; i === 0 || i < bytes.length; i += 6) {
      const chunk = bytes.slice(i, i + 6);
      while (chunk.length < 6) chunk.push(0);
      lines.push(['43', ...chunk.map(hex2)].join(''));
    }
    return lines;
  }

  #livePid(cmd) {
    const e = this.engine;
    const wobble = (value, amount, min, max) => Math.min(max, Math.max(min, value + (Math.random() - 0.5) * amount));
    const minutes = (performance.now() - this.startedAt) / 60000;
    switch (cmd) {
      case '010C':
        e.rpm = wobble(e.rpm, 40, 700, 820);
        return [`410C${hex2((e.rpm * 4) >> 8)}${hex2((e.rpm * 4) & 0xFF)}`];
      case '010D':
        return ['410D00'];
      case '0105':
        e.coolant = Math.min(203, 150 + minutes * 25) + (Math.random() - 0.5);
        return [`4105${hex2((e.coolant - 32) * 5 / 9 + 40)}`];
      case '0104':
        e.load = wobble(e.load, 3, 17, 26);
        return [`4104${hex2(e.load * 255 / 100)}`];
      case '0111':
        e.throttle = wobble(e.throttle, 0.8, 13, 16);
        return [`4111${hex2(e.throttle * 255 / 100)}`];
      case '0103':
        // 01 = open loop while warming up, 02 = closed loop.
        return [`4103${e.coolant < 160 ? '01' : '02'}00`];
      case '0106':
        return [`4106${hex2(128 + wobble(0, 8, -6, 6) * 128 / 100)}`];
      case '0107': {
        const lean = this.scenario.codes.includes('P0171') ? 12 : 2;
        return [`4107${hex2(128 + lean * 128 / 100)}`];
      }
      case '010B':
        return [`410B${hex2(wobble(32, 4, 28, 36))}`];
      case '010E':
        return [`410E${hex2((wobble(12, 3, 9, 15) + 64) * 2)}`];
      case '010F':
        return [`410F${hex2(30 + 40)}`];
      case '0110': {
        const maf = Math.round(wobble(3.6, 0.4, 3.2, 4) * 100);
        return [`4110${hex2(maf >> 8)}${hex2(maf & 0xFF)}`];
      }
      case '0114': {
        // Upstream sensor swings between lean and rich while in closed loop.
        const volts = 0.45 + 0.4 * Math.sin((performance.now() - this.startedAt) / 700);
        return [`4114${hex2(volts * 200)}FF`];
      }
      case '0115':
        return [`4115${hex2(wobble(0.7, 0.04, 0.68, 0.72) * 200)}FF`];
      default:
        return null;
    }
  }
}

export const BAUD_DEMOS = ['slowbaud', 'nobaud'];

// Demo adapters that, unlike DemoTransport, make WOBD run baud rate detection.
// No `info`, so detectBaud never touches the real baud cache.
//   slowbaud: silent until the fourth rate it tries, then acts like the normal demo car.
//   nobaud:   silent through the whole automatic sweep; any rate picked in the Retry form answers.
export class DemoBaudTransport extends DemoTransport {
  constructor(name) {
    super('can');
    this.mode = name;
    this.baudRate = null;
    this.opens = 0;
  }

  async open(baudRate) {
    this.baudRate = baudRate;
    this.opens++;
  }

  #answers() {
    return this.mode === 'slowbaud' ? this.baudRate === BASE_RATES[3] : this.opens > BASE_RATES.length;
  }

  async write(text) {
    if (!this.#answers()) return;
    if (text.trim().toUpperCase() === 'ATI') {
      setTimeout(() => this.onData('ELM327 v1.5\r\r>'), 40);
      return;
    }
    await super.write(text);
  }
}
