// A pretend ELM327 for trying WOBD without a car. Open the site with ?demo
// (a CAN car with codes), ?demo=iso (an older ISO 9141 car, like a 2001
// PT Cruiser, with no VIN support), or ?demo=clear (no codes).
// ?demo=slowbaud and ?demo=nobaud go through baud rate detection (see DemoBaudTransport).
// For testing Live data recording without driving: ?demo=drive loops a short
// trip (see TRIP) with occasional dropped replies, ?demo=nospeed has no speed
// or RPM PIDs, and ?demo=unplug is the drive car with its cable pulled 40s in.
// For the gauge picker: ?demo=ptcruiser is a slow J1850 VPW car reporting the
// PT Cruiser's PIDs, ?demo=multiecu has two ECUs whose supported-PID lists
// chain past 0x20, and ?demo=nopids answers NO DATA when asked what it supports.
//
// Like a real ELM327, the pretend adapter only talks to the car when the
// protocol it was told to use (ATSPn) matches the car's, or is 0 for automatic.
// Anything else answers UNABLE TO CONNECT. ?demo=sim builds the car from the
// year, make, and model (see vehicles.js); the Simulator page does the same.
import { BASE_RATES } from './smartbauder.js';

const SCENARIOS = {
  can: { protocol: '6', vin: '1HGCM82633A004352', codes: ['P0301', 'P0171', 'P0442'] },
  iso: { protocol: '3', vin: null, codes: ['P0420', 'P1491'] },
  clear: { protocol: '6', vin: '1HGCM82633A004352', codes: [] },
  drive: { protocol: '6', vin: '1HGCM82633A004352', codes: [], trip: true },
  nospeed: { protocol: '6', vin: '1HGCM82633A004352', codes: [], pids: '27' },
  unplug: { protocol: '6', vin: '1HGCM82633A004352', codes: [], trip: true, unplugAfter: 40000 },
  // 0x01, 0x03-07, 0x0B-0E, 0x11, 0x14, 0x15, 0x1C; about 150 ms per request, like the real car.
  ptcruiser: { protocol: '2', vin: null, codes: ['P0340', 'P0601', 'P0352', 'P0351', 'P0551', 'P1391'], latency: 150,
    supported: { '0100': ['4100BE3C9810'] } },
  // Engine ECU and transmission ECU. Only the engine sets the "more" bit, so the
  // chain continues to 0120 and 0140 (0x21, 0x2F, 0x33, 0x42, 0x46, 0x51, 0x5C).
  multiecu: { protocol: '6', vin: '1HGCM82633A004352', codes: [],
    supported: { '0100': ['4100BE3FB811', '410080180000'], '0120': ['412080022001', '412000000000'], '0140': ['414044008010'] } },
  nopids: { protocol: '6', vin: '1HGCM82633A004352', codes: ['P0171'], supported: { '0100': ['NO DATA'] } },
};

// What ATDP calls each protocol.
const DESCRIBE_PROTOCOL = {
  1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2', 4: 'ISO 14230-4 (KWP 5BAUD)',
  5: 'ISO 14230-4 (KWP FAST)', 6: 'ISO 15765-4 (CAN 11/500)', 7: 'ISO 15765-4 (CAN 29/500)',
  8: 'ISO 15765-4 (CAN 11/250)', 9: 'ISO 15765-4 (CAN 29/250)', A: 'SAE J1939 (CAN 29/250)',
};

const isCanProtocol = (protocol) => /^[6-9A-C]$/.test(protocol);
// Protocols that wake the car with a "BUS INIT" handshake.
const BUS_INIT = new Set(['3', '4', '5']);
const MISMATCH_MS = 1500;  // default time a wrong protocol takes to give up

// The ?demo=drive trip, repeating: [seconds into the loop, mph]. Speed is
// interpolated between points. The 35 s stop lets the driving lock unlock.
const TRIP = [[0, 0], [10, 0], [20, 35], [45, 38], [55, 0], [90, 0]];
const TRIP_DROPOUT = 0.1;  // share of speed and RPM replies that come back NO DATA

function tripSpeed(seconds) {
  const t = seconds % TRIP.at(-1)[0];
  const i = TRIP.findIndex(([at]) => at > t);
  const [[t0, v0], [t1, v1]] = [TRIP[i - 1], TRIP[i]];
  return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
}

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
  // scenario: the name of a SCENARIOS entry, or a vehicle profile from vehicles.js.
  constructor(scenario) {
    this.scenario = typeof scenario === 'object' ? scenario : SCENARIOS[scenario] ?? SCENARIOS.can;
    this.codes = [...this.scenario.codes];
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.tap = null;  // (direction, text) => void, to watch the traffic ('tx' or 'rx')
    this.selected = '0';  // what ATSP asked for; 0 is automatic
    this.linked = false;  // true once a request has reached the car
    this.startedAt = performance.now();
    this.engine = { rpm: 760, coolant: 150, load: 21, throttle: 14 };
  }

  get isCan() { return isCanProtocol(this.scenario.protocol); }

  async open() {
    if (this.scenario.unplugAfter) {
      this.unplugTimer = setTimeout(() => {
        this.unplugged = true;
        this.onDisconnect(new Error('The adapter was unplugged.'));
      }, this.scenario.unplugAfter);
    }
  }

  async close() {
    clearTimeout(this.unplugTimer);
  }

  async write(text) {
    if (this.unplugged) return;
    const command = text.trim().toUpperCase().replace(/\s+/g, '');
    this.tap?.('tx', command);
    const { lines, delay } = this.#respond(command);
    setTimeout(() => {
      const reply = `${lines.join('\r')}\r\r>`;
      this.tap?.('rx', reply);
      this.onData(reply);
    }, delay);
  }

  #latency() {
    const { latency } = this.scenario;
    return latency ? latency * (0.85 + Math.random() * 0.3) : 40 + Math.random() * 60;
  }

  // Talking to the car: finds the protocol first, as the ELM327 does on the first request.
  #respond(cmd) {
    if (!/^0[1-9A]/.test(cmd)) {
      return { lines: this.#reply(cmd), delay: this.#latency() };
    }
    if (!this.linked) {
      const link = this.#connect();
      if (!link.ok) return { lines: link.lines, delay: this.scenario.mismatchMs ?? MISMATCH_MS };
      this.linked = true;
      return { lines: [...link.lines, ...this.#reply(cmd)], delay: link.delay };
    }
    return { lines: this.#reply(cmd), delay: this.#latency() };
  }

  #connect() {
    const { protocol, autoFails } = this.scenario;
    const initMs = this.scenario.initMs ?? (this.isCan ? 1400 : 2000);
    const fixed = this.selected !== '0';
    if (fixed && this.selected === protocol) {
      return { ok: true, lines: BUS_INIT.has(protocol) ? ['BUS INIT: ...OK'] : [], delay: initMs };
    }
    if (!fixed && !autoFails) {
      return { ok: true, lines: ['SEARCHING...', ...(BUS_INIT.has(protocol) ? ['BUS INIT: ...OK'] : [])], delay: initMs + 800 };
    }
    return { ok: false, lines: [...(BUS_INIT.has(this.selected) ? ['BUS INIT: ...ERROR'] : []), 'UNABLE TO CONNECT'] };
  }

  #reply(cmd) {
    if (cmd === 'ATZ') {
      this.linked = false;
      return ['', 'ELM327 v1.5'];
    }
    if (cmd === 'ATI') return ['ELM327 v1.5'];
    if (cmd === 'ATRV') return [`${(13.9 + Math.random() * 0.3).toFixed(1)}V`];
    if (cmd.startsWith('ATSP')) {
      const protocol = cmd.slice(4);
      if (!/^(?:0|[1-9A-C])$/.test(protocol)) return ['?'];
      this.selected = protocol;
      this.linked = false;
      return ['OK'];
    }
    if (cmd === 'ATDPN' || cmd === 'ATDP') {
      const auto = this.selected === '0';
      const active = this.linked ? this.scenario.protocol : this.selected;
      if (cmd === 'ATDPN') return [auto ? `A${active}` : active];
      return [active === '0' ? 'AUTO' : `${auto ? 'AUTO, ' : ''}${DESCRIBE_PROTOCOL[active] ?? 'USER1'}`];
    }
    if (cmd.startsWith('AT')) return ['OK'];

    const supported = this.scenario.supported?.[cmd];
    if (supported) return supported;
    switch (cmd) {
      case '0100': return [`4100BE${this.scenario.pids ?? '3F'}B811`];
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
    const mph = tripSpeed((performance.now() - this.startedAt) / 1000);
    if (this.scenario.trip && (cmd === '010C' || cmd === '010D') && Math.random() < TRIP_DROPOUT) return ['NO DATA'];
    switch (cmd) {
      case '010C':
        e.rpm = this.scenario.trip && mph > 0.5 ? wobble(1100 + mph * 45, 60, 900, 3500) : wobble(e.rpm, 40, 700, 820);
        return [`410C${hex2((e.rpm * 4) >> 8)}${hex2((e.rpm * 4) & 0xFF)}`];
      case '010D':
        return [`410D${hex2(this.scenario.trip ? mph / 0.621371 : 0)}`];
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
    if (!this.#answers()) {
      this.tap?.('tx', text.trim());
      return;
    }
    if (text.trim().toUpperCase() === 'ATI') {
      this.tap?.('tx', 'ATI');
      setTimeout(() => {
        this.tap?.('rx', 'ELM327 v1.5\r\r>');
        this.onData('ELM327 v1.5\r\r>');
      }, 40);
      return;
    }
    await super.write(text);
  }
}
