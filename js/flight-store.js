// Browser backup of a live recording, so a crash or closed tab doesn't lose a drive.
// Rows are written in small checked chunks (IndexedDB). The in-memory Recording stays the
// source for a normal save; this copy is only read back to recover an interrupted session
// or to re-download a recent one. Nothing is ever invented: a damaged chunk and everything
// after it is left out and reported, never repaired or filled in.
// The storage backend is injected so scripts/test-flight-store.mjs runs without a browser.
import { formatNumber, t } from './i18n.js';

export const RETENTION_DAYS = 30;
export const BATCH_MS = 5000;        // write a chunk at least this often...
export const BATCH_ROWS = 250;       // ...or as soon as this many rows are waiting
export const MAX_WAITING_ROWS = 5000;  // if writes keep failing, stop buffering instead of growing forever
export const WARN_AT = 0.7;
export const CRITICAL_AT = 0.9;
export const MIN_FREE_BYTES = 50 * 1024 * 1024;
const DAY_MS = 86400000;

const DB_NAME = 'wobd-flight';

// FNV-1a over the chunk text: catches a torn or edited chunk, not tampering.
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const newSessionId = (startedAt) => `s${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

export function makeChunk(session, seq, rows) {
  const body = JSON.stringify(rows);
  return { session, seq, count: rows.length, sum: checksum(body), body };
}

// Reads a chunk back. Returns the rows, or null if it doesn't check out.
export function readChunk(chunk) {
  try {
    if (typeof chunk?.body !== 'string' || checksum(chunk.body) !== chunk.sum) return null;
    const rows = JSON.parse(chunk.body);
    const ok = Array.isArray(rows) && rows.length === chunk.count
      && rows.every((r) => Array.isArray(r) && r.length === 8 && Number.isFinite(r[0]));
    return ok ? rows : null;
  } catch {
    return null;
  }
}

// Chunks must run 0, 1, 2... with no hole. The first bad or missing one ends the usable data.
export function validateSession(meta, chunks) {
  const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
  const rows = [];
  let good = 0;
  for (const chunk of sorted) {
    if (chunk.seq !== good) break;
    const part = readChunk(chunk);
    if (!part) break;
    rows.push(...part);
    good += 1;
  }
  const dropped = sorted.length - good;
  const problems = [];
  if (dropped) problems.push(t('replay.load.corruptChunks', { count: dropped, formattedCount: formatNumber(dropped) }));
  if (!dropped && meta.chunks > good) problems.push(t('replay.load.missingChunks', { count: meta.chunks - good, formattedCount: formatNumber(meta.chunks - good) }));
  return { rows, goodChunks: good, droppedChunks: dropped, problems, complete: problems.length === 0 };
}

// ---------- Writer ----------

export class BackupWriter {
  constructor(backend, { startedAt, protocol, baud, version }, now = startedAt) {
    this.backend = backend;
    this.meta = {
      id: newSessionId(startedAt), startedAt, protocol, baud, version: version ?? null,
      status: 'open', chunks: 0, rows: 0, bytes: 0, updatedAt: now,
    };
    this.waiting = [];
    this.lastWrite = now;
    this.failure = null;     // the error that stopped the backup, if any
    this.stopped = false;
    this.inFlight = Promise.resolve();
  }

  add(storedRow, now) {
    if (this.stopped) return;
    this.waiting.push(storedRow);
    if (this.waiting.length > MAX_WAITING_ROWS) {
      this.stopped = true;
      this.failure ??= new Error('The backup fell too far behind');
      this.waiting = [];
      return;
    }
    if (this.waiting.length >= BATCH_ROWS || now - this.lastWrite >= BATCH_MS) this.flush(now);
  }

  // One chunk and the session record are committed together, so a crash leaves either both or neither.
  flush(now = Date.now()) {
    if (this.stopped || !this.waiting.length) return this.inFlight;
    const rows = this.waiting;
    this.waiting = [];
    this.lastWrite = now;
    this.inFlight = this.inFlight.then(async () => {
      if (this.stopped) return;
      const chunk = makeChunk(this.meta.id, this.meta.chunks, rows);
      const meta = {
        ...this.meta, chunks: this.meta.chunks + 1, rows: this.meta.rows + rows.length,
        bytes: this.meta.bytes + chunk.body.length, updatedAt: now,
      };
      try {
        await this.backend.commit(meta, chunk);
        this.meta = meta;
      } catch (err) {
        // Keep what's already stored; the in-memory recording is unaffected.
        this.failure = err;
        this.stopped = true;
      }
    });
    return this.inFlight;
  }

  // The recording ended normally (saved by the user). The copy stays for RETENTION_DAYS.
  async finish(now = Date.now()) {
    await this.flush(now);
    await this.inFlight;
    if (this.failure && !this.meta.chunks) return;
    try {
      await this.backend.commit({ ...this.meta, status: 'saved', updatedAt: now }, null);
      this.meta = { ...this.meta, status: 'saved', updatedAt: now };
    } catch (err) {
      this.failure ??= err;
    }
  }

  async discard() {
    this.stopped = true;
    await this.inFlight;
    try { await this.backend.remove(this.meta.id); } catch { /* nothing to clean up */ }
  }
}

// ---------- Sessions ----------

export async function listSessions(backend) {
  return (await backend.list()).sort((a, b) => b.startedAt - a.startedAt);
}

// Interrupted sessions are never deleted automatically: only the user decides what happens to them.
export async function purgeExpired(backend, now = Date.now(), days = RETENTION_DAYS) {
  const gone = [];
  for (const meta of await backend.list()) {
    if (meta.status === 'saved' && now - meta.updatedAt > days * DAY_MS) {
      await backend.remove(meta.id);
      gone.push(meta.id);
    }
  }
  return gone;
}

export async function loadSession(backend, id) {
  const meta = (await backend.list()).find((m) => m.id === id);
  if (!meta) return null;
  return { meta, ...validateSession(meta, await backend.chunks(id)) };
}

// ---------- Storage health ----------

export function quotaLevel(usage, quota) {
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return 'unknown';
  const free = quota - usage;
  if (usage / quota >= CRITICAL_AT || free < MIN_FREE_BYTES / 5) return 'critical';
  if (usage / quota >= WARN_AT || free < MIN_FREE_BYTES) return 'warn';
  return 'ok';
}

// Rough hours of recording left at this session's rate, from what it has stored so far.
export function projectedHours(freeBytes, meta) {
  const seconds = (meta.updatedAt - meta.startedAt) / 1000;
  if (!(seconds >= 30) || !(meta.bytes > 0) || !Number.isFinite(freeBytes)) return null;
  return freeBytes / (meta.bytes / seconds) / 3600;
}

export async function storageStatus(nav = globalThis.navigator) {
  const out = { usage: null, quota: null, persisted: null, level: 'unknown' };
  try {
    if (nav?.storage?.estimate) {
      const { usage, quota } = await nav.storage.estimate();
      Object.assign(out, { usage, quota, level: quotaLevel(usage, quota) });
    }
    if (nav?.storage?.persisted) out.persisted = await nav.storage.persisted();
  } catch { /* leave as unknown */ }
  return out;
}

// Only ever called from a user action, with the reason shown next to the checkbox.
export async function requestPersistence(nav = globalThis.navigator) {
  try { return (await nav?.storage?.persist?.()) ?? false; } catch { return false; }
}

// ---------- Backends ----------

// Resolves to null when IndexedDB is missing or blocked (private mode, policy), so callers can say so.
export function openIndexedDb(idb = globalThis.indexedDB) {
  return new Promise((resolve) => {
    if (!idb) { resolve(null); return; }
    let req;
    try { req = idb.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      req.result.createObjectStore('sessions', { keyPath: 'id' });
      req.result.createObjectStore('chunks', { keyPath: ['session', 'seq'] });
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => resolve(idbBackend(req.result));
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
});

function idbBackend(db) {
  return {
    async commit(meta, chunk) {
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').put(meta);
      if (chunk) tx.objectStore('chunks').put(chunk);
      await done(tx);
    },
    async list() {
      return wrap(db.transaction('sessions').objectStore('sessions').getAll());
    },
    async chunks(id) {
      return wrap(db.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
    },
    async remove(id) {
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').delete(id);
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      await done(tx);
    },
  };
}

// For tests: same contract as the IndexedDB backend, with optional failure injection.
export function memoryBackend() {
  const sessions = new Map();
  const chunks = new Map();
  const backend = {
    sessions, store: chunks, failNext: null,
    async commit(meta, chunk) {
      if (backend.failNext) { const err = backend.failNext; backend.failNext = null; throw err; }
      sessions.set(meta.id, structuredClone(meta));
      if (chunk) chunks.set(`${chunk.session}:${chunk.seq}`, structuredClone(chunk));
    },
    async list() { return [...sessions.values()].map((m) => structuredClone(m)); },
    async chunks(id) { return [...chunks.values()].filter((c) => c.session === id).map((c) => structuredClone(c)); },
    async remove(id) {
      sessions.delete(id);
      for (const key of [...chunks.keys()]) if (key.startsWith(`${id}:`)) chunks.delete(key);
    },
  };
  return backend;
}
