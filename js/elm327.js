// ELM327 command queue. The adapter chokes on overlapping commands, so every
// command waits for the previous reply (ending in the ">" prompt) first.

export class ElmError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ERROR_REPLIES = [
  [/^NO DATA/, 'NO_DATA', 'The car had no answer for that request.'],
  [/^UNABLE TO CONNECT|^BUS INIT:.*ERROR/, 'UNABLE_TO_CONNECT',
    "The adapter couldn't talk to the car. Is the ignition on?"],
  [/^(CAN ERROR|BUS ERROR|BUS BUSY|FB ERROR|DATA ERROR|<RX ERROR|BUFFER FULL|LV RESET)/, 'BUS_ERROR',
    'The adapter reported a communication error with the car.'],
  [/^(\?|ERROR|STOPPED)$/, 'COMMAND_ERROR', 'The adapter did not understand a command.'],
];

export class ELM327 {
  constructor(transport, { timeout = 5000 } = {}) {
    this.transport = transport;
    this.timeout = timeout;
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    transport.onData = (chunk) => this.#onData(chunk);
  }

  #onData(chunk) {
    this.buffer += chunk;
    const end = this.buffer.indexOf('>');
    if (end === -1 || !this.pending) return;
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    const pending = this.pending;
    this.pending = null;
    pending.resolve(raw);
  }

  // Sends one command and resolves with the reply lines, minus echo and noise.
  send(command, timeout = this.timeout) {
    const run = () => new Promise((resolve, reject) => {
      this.buffer = '';
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new ElmError('TIMEOUT', `The adapter didn't answer "${command}" in time.`));
      }, timeout);
      this.pending = {
        resolve: (raw) => {
          clearTimeout(timer);
          try {
            resolve(cleanReply(raw, command));
          } catch (err) {
            reject(err);
          }
        },
      };
      this.transport.write(`${command}\r`).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      });
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  // Resets the adapter. Resolves with its ID (like "ELM327 v1.5") or throws
  // if nothing that looks like an ELM327 answered, which usually means the
  // baud rate is wrong.
  async reset() {
    const lines = await this.send('ATZ', 2500);
    const id = lines.find((line) => /ELM|OBD/i.test(line));
    if (!id) throw new ElmError('NOT_ELM', 'No ELM327 answered at this speed.');
    return id;
  }

  // Echo off, linefeeds off, spaces off, headers off, automatic protocol.
  async configure() {
    for (const command of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) {
      await this.send(command);
    }
  }
}

function cleanReply(raw, command) {
  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => line.replace(/^BUS INIT:\s*\.*\s*OK/i, '').trim())
    .filter((line) => line && line.toUpperCase() !== command.toUpperCase() && !/^SEARCHING/i.test(line));

  for (const line of lines) {
    for (const [pattern, code, message] of ERROR_REPLIES) {
      if (pattern.test(line.toUpperCase())) throw new ElmError(code, message);
    }
  }
  return lines;
}
