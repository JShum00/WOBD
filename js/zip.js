// A small, strict ZIP reader and writer for .wobd files (see Docs/WOBD-Format-Spec.md).
// Only the ZIP features WOBD needs: stored or deflate, no zip64, encryption, data descriptors,
// or split archives. Every file read here is treated as hostile.
// Deflate uses the browser's CompressionStream('deflate-raw'); where that is missing the
// writer stores entries uncompressed and the reader refuses deflated ones with a clear message.

import { t } from './i18n.js';

export const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxEntries: 20000,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};
export const RATIO_WARNING = 200;

export class ZipError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canDeflate() {
  try {
    new CompressionStream('deflate-raw');
    return typeof DecompressionStream === 'function';
  } catch {
    return false;
  }
}

async function throughStream(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// Inflates raw deflate data, giving up as soon as it passes `limit` bytes (zip-bomb guard).
async function inflate(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new ZipError(t('replay.zip.entryTooLargeForHeader')); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;  // 1980-01-01, so equal input gives equal bytes

// entries: [{ name, data: Uint8Array, store?: true }]. Returns the archive bytes.
export async function writeZip(entries, { compress = true } = {}) {
  const deflate = compress && canDeflate();
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const crc = crc32(entry.data);
    let body = entry.data;
    let method = 0;
    if (deflate && !entry.store && entry.data.length > 64) {
      const packed = await throughStream(entry.data, new CompressionStream('deflate-raw'));
      if (packed.length < entry.data.length) { body = packed; method = 8; }
    }
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(8, method, true);
    head.setUint16(10, DOS_TIME, true);
    head.setUint16(12, DOS_DATE, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, entry.data.length, true);
    head.setUint16(26, name.length, true);
    central.push({ name, crc, method, size: body.length, rawSize: entry.data.length, offset });
    push(new Uint8Array(head.buffer));
    push(name);
    push(body);
  }
  const dirStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 20, true);
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, c.method, true);
    h.setUint16(12, DOS_TIME, true);
    h.setUint16(14, DOS_DATE, true);
    h.setUint32(16, c.crc, true);
    h.setUint32(20, c.size, true);
    h.setUint32(24, c.rawSize, true);
    h.setUint16(28, c.name.length, true);
    h.setUint32(42, c.offset, true);
    push(new Uint8Array(h.buffer));
    push(c.name);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, offset - dirStart, true);
  end.setUint32(16, dirStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of chunks) { out.set(part, at); at += part.length; }
  return out;
}

// Reads and verifies an archive. `allowed(name)` is the caller's whitelist of entry names.
// Returns { entries: Map(name -> Uint8Array), warnings }.
export async function readZip(bytes, { allowed = () => true, limits = LIMITS } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new ZipError(t('replay.zip.notReadable'));
  if (bytes.length > limits.maxFileBytes) throw new ZipError(t('replay.zip.fileTooLarge'));
  if (bytes.length < 22) throw new ZipError(t('replay.zip.notWobd'));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError(t('replay.zip.damagedWobd'));
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirStart = view.getUint32(eocd + 16, true);
  const commentLen = view.getUint16(eocd + 20, true);
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || view.getUint16(eocd + 8, true) !== count) {
    throw new ZipError(t('replay.zip.splitArchive'));
  }
  if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) throw new ZipError(t('replay.zip.zip64'));
  if (eocd + 22 + commentLen !== bytes.length) throw new ZipError(t('replay.zip.extraData'));
  if (count > limits.maxEntries) throw new ZipError(t('replay.zip.tooManyEntries'));
  if (dirStart + dirSize !== eocd) throw new ZipError(t('replay.zip.directoryDamaged'));

  const names = new Set();
  const spans = [];
  const found = [];
  let pos = dirStart;
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || view.getUint32(pos, true) !== 0x02014b50) throw new ZipError(t('replay.zip.directoryDamaged'));
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const rawSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const noteLen = view.getUint16(pos + 32, true);
    const disk = view.getUint16(pos + 34, true);
    const localAt = view.getUint32(pos + 42, true);
    if (pos + 46 + nameLen + extraLen + noteLen > eocd) throw new ZipError(t('replay.zip.directoryDamaged'));
    let name;
    try { name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)); } catch { throw new ZipError(t('replay.zip.unreadableName')); }
    pos += 46 + nameLen + extraLen + noteLen;

    if (flags & 0x1 || flags & 0x8) throw new ZipError(t('replay.zip.encryptedOrStreamed'));
    if (disk) throw new ZipError(t('replay.zip.splitArchive'));
    if (size === 0xffffffff || rawSize === 0xffffffff || localAt === 0xffffffff) throw new ZipError(t('replay.zip.zip64'));
    if (method !== 0 && method !== 8) throw new ZipError(t('replay.zip.unsupportedCompression'));
    if (names.has(name)) throw new ZipError(t('replay.zip.duplicateEntry'));
    names.add(name);
    if (!allowed(name)) throw new ZipError(t('replay.zip.unknownEntry', { name: name.slice(0, 60) }));
    if (rawSize > limits.maxEntryBytes) throw new ZipError(t('replay.zip.entryTooLarge'));
    declaredTotal += rawSize;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError(t('replay.zip.archiveTooLarge'));
    if (method === 0 && size !== rawSize) throw new ZipError(t('replay.zip.entryDamaged'));
    found.push({ name, method, crc, size, rawSize, localAt });
  }
  if (pos !== eocd) throw new ZipError(t('replay.zip.directoryDamaged'));

  const entries = new Map();
  const warnings = [];
  for (const e of found) {
    if (e.localAt + 30 > dirStart || view.getUint32(e.localAt, true) !== 0x04034b50) throw new ZipError(t('replay.zip.headerDamaged'));
    const nameLen = view.getUint16(e.localAt + 26, true);
    const extraLen = view.getUint16(e.localAt + 28, true);
    const dataAt = e.localAt + 30 + nameLen + extraLen;
    const same = view.getUint16(e.localAt + 8, true) === e.method
      && view.getUint32(e.localAt + 14, true) === e.crc
      && view.getUint32(e.localAt + 18, true) === e.size
      && view.getUint32(e.localAt + 22, true) === e.rawSize
      && nameLen === enc.encode(e.name).length
      && !(view.getUint16(e.localAt + 6, true) & 0x9);
    if (!same || dataAt + e.size > dirStart) throw new ZipError(t('replay.zip.headerMismatch'));
    if (new TextDecoder().decode(bytes.subarray(e.localAt + 30, e.localAt + 30 + nameLen)) !== e.name) throw new ZipError(t('replay.zip.headerMismatch'));
    spans.push([e.localAt, dataAt + e.size]);

    const packed = bytes.subarray(dataAt, dataAt + e.size);
    let data;
    if (e.method === 0) data = packed;
    else {
      if (!canDeflate()) throw new ZipError(t('replay.zip.browserCannotDecompress'));
      try { data = await inflate(packed, e.rawSize); } catch (err) {
        if (err instanceof ZipError) throw err;
        throw new ZipError(t('replay.zip.unpackFailed'));
      }
      if (e.size > 0 && e.rawSize / e.size > RATIO_WARNING) warnings.push(t('replay.zip.highCompressionRatio', { name: e.name }));
    }
    if (data.length !== e.rawSize) throw new ZipError(t('replay.zip.entryDamaged'));
    if (crc32(data) !== e.crc) throw new ZipError(t('replay.zip.checksumFailed', { name: e.name.slice(0, 60) }));
    entries.set(e.name, data);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw new ZipError(t('replay.zip.overlappingEntries'));
  return { entries, warnings };
}
