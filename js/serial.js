// Web Serial transport: opens the USB adapter and streams text in and out.
// elm327.js only relies on open/close/write plus the onData and onDisconnect
// callbacks, so demo.js can stand in for this class.

export function isSerialSupported() {
  return 'serial' in navigator;
}

function detectBrowser() {
  const ua = navigator.userAgent;
  // iPads report a Mac user agent, so touch support gives them away.
  const mobile = Boolean(navigator.userAgentData?.mobile)
    || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let name = 'This browser';
  if (/Firefox\/|FxiOS/.test(ua)) name = 'Firefox';
  else if (/Edg/.test(ua)) name = 'Edge';
  else if (/OPR\//.test(ua)) name = 'Opera';
  else if (/SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (navigator.brave) name = 'Brave';
  else if (/Chrome\/|CriOS/.test(ua)) name = 'Chrome';
  else if (/Safari\//.test(ua)) name = 'Safari';
  return { name, mobile };
}

// Says whether this browser can reach a USB adapter and, if not, why and what
// to do instead. Phones are ruled out even when they expose Web Serial,
// because they can't use USB OBD adapters.
export function checkBrowser() {
  const { name, mobile } = detectBrowser();
  if (mobile) {
    return {
      supported: false,
      name,
      reason: "Phones and tablets can't connect to a USB car adapter.",
      fix: 'Open wobd.app on a laptop or Chromebook in Chrome, Edge, or Opera.',
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      name,
      reason: 'This page needs a secure (https) connection to reach the adapter.',
      fix: 'Open https://wobd.app instead.',
    };
  }
  if (!isSerialSupported()) {
    return {
      supported: false,
      name,
      reason: name === 'Brave'
        ? 'Brave turns off Web Serial, the feature WOBD uses to talk to the adapter.'
        : `${name} doesn't support Web Serial, the feature WOBD uses to talk to the adapter.`,
      fix: 'Open wobd.app in Chrome, Edge, or Opera on a computer.',
    };
  }
  return { supported: true, name };
}

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.tap = null;  // (direction, text) => void, see traffic.js
    this.closing = false;
    this.lost = false;
    port.addEventListener('disconnect', () => this.#adapterLost());
  }

  // Fires onDisconnect once per open, whether the disconnect event or a read error arrives first.
  #adapterLost() {
    if (this.closing || this.lost) return;
    this.lost = true;
    this.tap?.('note', 'The adapter was unplugged');
    this.onDisconnect(new Error('The adapter was unplugged.'));
  }

  // Must be called from a click handler: Web Serial needs a user gesture.
  static async request() {
    const port = await navigator.serial.requestPort();
    return new SerialTransport(port);
  }

  // { usbVendorId, usbProductId } for USB adapters, empty otherwise.
  get info() {
    return this.port.getInfo?.() ?? {};
  }

  async open(baudRate) {
    this.tap?.('note', `Opening the port at ${baudRate} baud`);
    await this.port.open({ baudRate });
    this.lost = false;
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
          const text = decoder.decode(value, { stream: true });
          this.tap?.('rx', text);
          this.onData(text);
        }
      } catch (err) {
        // NetworkError means the device is gone. Other read errors are recoverable: get a new reader.
        if (err?.name === 'NetworkError') this.#adapterLost();
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  async write(text) {
    this.tap?.('tx', text);
    await this.writer.write(new TextEncoder().encode(text));
  }

  async close() {
    this.closing = true;
    this.tap?.('note', 'Closing the port');
    // Each step is guarded on its own so one failure can't leave the port open and locked.
    await this.reader?.cancel().catch(() => {});
    await this.readLoop?.catch(() => {});
    try {
      this.writer?.releaseLock();
    } catch {
      // Still has a pending write; closing the port below drops it.
    }
    await this.port.close().catch(() => {});  // already closed or unplugged
    this.reader = null;
    this.writer = null;
    this.closing = false;
  }
}
