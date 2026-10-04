// A running log of what goes to and from the adapter, for finding where a
// connection stops answering. Transports call transport.tap(direction, text):
// 'tx' for a command sent, 'rx' for raw text received, 'note' for events.

const MAX_ENTRIES = 1000;
const RX_IDLE_MS = 300;  // flush received text that never reached a ">" prompt

// Makes control and non-ASCII bytes visible, so a wrong baud rate shows up as \xFF noise.
function printable(text) {
  return text.replace(/[^\x20-\x7E]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export class TrafficLog {
  constructor({ onChange = () => {} } = {}) {
    this.entries = [];
    this.onChange = onChange;
    this.startedAt = performance.now();
    this.rx = '';
    this.rxTimer = null;
  }

  attach(transport) {
    transport.tap = (direction, text) => this.#tap(direction, text);
  }

  // Starts a new section so a retry can be compared with the attempt before it.
  begin(label) {
    this.#flushRx();
    this.startedAt = performance.now();
    this.add('note', label);
  }

  add(direction, text) {
    this.entries.push({ at: performance.now() - this.startedAt, direction, text });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.onChange();
  }

  clear() {
    this.#flushRx();
    this.entries = [];
    this.onChange();
  }

  #tap(direction, text) {
    if (direction !== 'rx') {
      this.#flushRx();
      this.add(direction, direction === 'tx' ? printable(text.replace(/[\r\n]+$/, '')) : text);
      return;
    }
    this.rx += text;
    clearTimeout(this.rxTimer);
    let end;
    while ((end = this.rx.indexOf('>')) !== -1) {
      const reply = this.rx.slice(0, end);
      this.rx = this.rx.slice(end + 1);
      this.add('rx', this.#formatReply(reply));
    }
    if (this.rx) this.rxTimer = setTimeout(() => this.#flushRx(), RX_IDLE_MS);
  }

  #flushRx() {
    clearTimeout(this.rxTimer);
    if (!this.rx) return;
    const partial = this.rx;
    this.rx = '';
    this.add('rx', `${this.#formatReply(partial)} (no ">" prompt)`);
  }

  #formatReply(raw) {
    const lines = raw.split(/[\r\n]+/).filter((line) => line.trim()).map(printable);
    return lines.length ? lines.join(' | ') : '(empty)';
  }

  // One line per entry: "  1.234s → 0100". With maskVin, the reply to a VIN
  // request (mode 09 PID 02) keeps its shape but loses its digits.
  toText({ maskVin = false } = {}) {
    let inVin = false;
    return this.entries.map(({ at, direction, text }) => {
      if (direction === 'tx') inVin = text.replace(/\s+/g, '').toUpperCase() === '0902';
      const shown = maskVin && inVin && direction === 'rx' ? maskHexLines(text) : text;
      const arrow = { tx: '→', rx: '←', note: '·' }[direction];
      return `${(at / 1000).toFixed(3).padStart(8)}s ${arrow} ${shown}`;
    }).join('\n');
  }
}

// "014 | 0: 4902015744 | 1: 4D" becomes "XXX | X: XXXXXXXXXX | X: XX". Error replies like NO DATA pass through.
function maskHexLines(text) {
  return text.split(' | ').map((line) => (/^[0-9A-F: ]+$/i.test(line) ? line.replace(/[0-9A-F]/gi, 'X') : line)).join(' | ');
}

const RENDER_MS = 250;

// A log shown in `pre`. Live data sends many commands a second, so redraws are
// throttled, and skipped while the log is collapsed (details closed).
// header: () => text put above the log when it is copied. mask: a checkbox that hides the VIN in copies.
export function createTrafficView({ pre, details = null, copy = null, clear = null, mask = null, header = null, onFirstEntry = () => {} }) {
  let timer = null;
  const draw = () => {
    timer = null;
    if (details && !details.open) return;
    const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    pre.textContent = log.toText();
    if (stick) pre.scrollTop = pre.scrollHeight;
  };
  const log = new TrafficLog({
    onChange: () => {
      if (log.entries.length === 1) onFirstEntry();
      timer ??= setTimeout(draw, RENDER_MS);
    },
  });
  details?.addEventListener('toggle', draw);
  clear?.addEventListener('click', () => log.clear());
  copy?.addEventListener('click', async () => {
    const label = copy.textContent;
    try {
      const body = log.toText({ maskVin: mask ? mask.checked : true });
      await navigator.clipboard.writeText(header ? `${header()}\n\n${body}` : body);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => { copy.textContent = label; }, 1500);
  });
  return log;
}
