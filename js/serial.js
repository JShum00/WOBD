// Web Serial transport: opens the USB adapter and streams text in and out.
// elm327.js only relies on open/close/write plus the onData and onDisconnect
// callbacks, so demo.js can stand in for this class.

export function isSerialSupported() {
  return 'serial' in navigator;
}

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.closing = false;
    port.addEventListener('disconnect', () => {
      if (!this.closing) this.onDisconnect(new Error('The adapter was unplugged.'));
    });
  }

  // Must be called from a click handler: Web Serial needs a user gesture.
  static async request() {
    const port = await navigator.serial.requestPort();
    return new SerialTransport(port);
  }

  async open(baudRate) {
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.readLoop = this.#read();
  }

  async #read() {
    const decoder = new TextDecoder();
    // A framing or parity error breaks the current reader but leaves the port
    // readable, so keep going until the port itself goes away.
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.onData(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Non-fatal read error; loop around and get a new reader.
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  async write(text) {
    await this.writer.write(new TextEncoder().encode(text));
  }

  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
      await this.readLoop;
      this.writer?.releaseLock();
      await this.port.close();
    } catch {
      // Already closed or unplugged.
    } finally {
      this.reader = null;
      this.writer = null;
      this.closing = false;
    }
  }
}
