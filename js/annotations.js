// Notes a person adds to a recording after the drive. They live beside the recording, never
// in it: the CSV is not changed, and a note is keyed to session-relative time (ms from the
// first reading) and to a fingerprint of the recording's content. No DOM here, so
// scripts/test-annotations.mjs can check it in Node.
import { t as translate } from './i18n.js';

export const NOTE_TYPES = [
  { id: 'hesitation', get label() { return translate('replay.notes.typeHesitation'); } },
  { id: 'stop-sign', get label() { return translate('replay.notes.typeStopSign'); } },
  { id: 'ignition-off', get label() { return translate('replay.notes.typeIgnitionOff'); } },
  { id: 'refueling', get label() { return translate('replay.notes.typeRefueling'); } },
  { id: 'road', get label() { return translate('replay.notes.typeRoad'); } },
  { id: 'custom', get label() { return translate('replay.notes.typeCustom'); } },
];
const TYPE_IDS = new Set(NOTE_TYPES.map((t) => t.id));

// How a viewer can mark an automatically detected event. The event and its evidence stay as they were.
export const REVIEW_STATUSES = [
  { id: 'dismissed', get label() { return translate('replay.events.reviewDismissed'); } },
  { id: 'normal', get label() { return translate('replay.events.reviewNormal'); } },
  { id: 'known', get label() { return translate('replay.events.reviewKnown'); } },
  { id: 'real', get label() { return translate('replay.events.reviewReal'); } },
];
const REVIEW_IDS = new Set(REVIEW_STATUSES.map((s) => s.id));
export const reviewLabel = (id) => REVIEW_STATUSES.find((s) => s.id === id)?.label ?? '';

// Keeps only well-formed { eventId: status } pairs.
function cleanReviews(reviews) {
  const out = {};
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) return out;
  for (const [id, status] of Object.entries(reviews).slice(0, MAX_NOTES * 4)) {
    if (/^[\w-]+@\d+$/.test(id) && REVIEW_IDS.has(status)) out[id] = status;
  }
  return out;
}

export const STORAGE_KEY = 'wobd.annotations.v1';
export const MAX_NOTES = 500;
export const MAX_LABEL = 60;
export const MAX_COMMENT = 500;
export const MAX_IMPORT_BYTES = 1024 * 1024;
const FORMAT = 'wobd-annotations';

export class AnnotationError extends Error {}

export const typeLabel = (id) => NOTE_TYPES.find((t) => t.id === id)?.label ?? translate('replay.notes.typeFallback');

const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// A note is { id, t, type, label, comment, createdAt }. label is the custom title (custom
// type only); comment is optional. t is clamped to the recording.
export function makeNote({ t, type, label = '', comment = '' }, durationMs, now = Date.now()) {
  if (!Number.isFinite(t)) throw new AnnotationError(translate('replay.notes.errorTime'));
  if (!TYPE_IDS.has(type)) throw new AnnotationError(translate('replay.notes.errorType'));
  const note = {
    id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    t: Math.round(Math.min(Math.max(0, t), durationMs)),
    type,
    label: type === 'custom' ? clean(label, MAX_LABEL) : '',
    comment: clean(comment, MAX_COMMENT),
    createdAt: new Date(now).toISOString(),
  };
  if (type === 'custom' && !note.label) throw new AnnotationError(translate('replay.notes.errorCustomLabel'));
  return note;
}

export const noteTitle = (note) => (note.type === 'custom' ? note.label : typeLabel(note.type));
export const sortNotes = (notes) => [...notes].sort((a, b) => a.t - b.t || a.createdAt.localeCompare(b.createdAt));

export const sameRecording = (a, b) =>
  Boolean(a && b) && a.hash === b.hash && a.readings === b.readings && a.durationMs === b.durationMs;

// ---------- Saving in this browser ----------

function read(storage) {
  try {
    const data = JSON.parse(storage.getItem(STORAGE_KEY));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function loadNotes(storage, fingerprint) {
  const entry = read(storage)[fingerprint.hash];
  if (!entry || !sameRecording(entry.fingerprint, fingerprint)) return [];
  return Array.isArray(entry.notes) ? entry.notes.filter(isNote) : [];
}

// Returns true when saved. Storage that is blocked or full returns false and loses nothing in memory.
export function loadReviews(storage, fingerprint) {
  const entry = read(storage)[fingerprint.hash];
  return entry && sameRecording(entry.fingerprint, fingerprint) ? cleanReviews(entry.reviews) : {};
}

export function saveNotes(storage, fingerprint, name, notes, reviews = {}) {
  try {
    const all = read(storage);
    if (notes.length || Object.keys(reviews).length) all[fingerprint.hash] = { fingerprint, name, notes: sortNotes(notes), reviews: cleanReviews(reviews) };
    else delete all[fingerprint.hash];
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
}

function isNote(n) {
  return n && typeof n === 'object' && typeof n.id === 'string' && Number.isFinite(n.t) && n.t >= 0
    && TYPE_IDS.has(n.type) && typeof n.createdAt === 'string';
}

// ---------- Files you can keep or share ----------

export function exportNotes(fingerprint, name, notes, reviews = {}) {
  return JSON.stringify({ format: FORMAT, version: 1, recording: { name, ...fingerprint }, notes: sortNotes(notes), reviews: cleanReviews(reviews) }, null, 2);
}

// Returns { notes, fingerprint, name, matches }. Notes from another recording are returned with
// matches false so the caller can warn and ask, never silently applying them.
export function parseImport(text, fingerprint) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new AnnotationError(translate('replay.notes.errorFileUnreadable'));
  let data;
  try { data = JSON.parse(text); } catch { throw new AnnotationError(translate('replay.notes.errorNotNotesFile')); }
  if (data?.format !== FORMAT || !Array.isArray(data.notes) || !data.recording) throw new AnnotationError(translate('replay.notes.errorNotNotesFile'));
  if (data.notes.length > MAX_NOTES) throw new AnnotationError(translate('replay.notes.errorTooMany'));
  const notes = data.notes.map((n) => ({
    id: String(n?.id ?? ''), t: Number(n?.t), type: n?.type,
    label: clean(n?.label, MAX_LABEL), comment: clean(n?.comment, MAX_COMMENT), createdAt: String(n?.createdAt ?? ''),
  })).filter(isNote);
  const { name, ...rest } = data.recording;
  return { notes, reviews: cleanReviews(data.reviews), name: clean(name, 120), fingerprint: rest, matches: sameRecording(rest, fingerprint) };
}

// Adds imported notes to the current ones. A note already present (same id) is kept once.
export function mergeNotes(current, incoming, durationMs) {
  const seen = new Set(current.map((n) => n.id));
  const merged = [...current];
  for (const n of incoming) {
    if (seen.has(n.id) || merged.length >= MAX_NOTES) continue;
    merged.push({ ...n, t: Math.min(Math.max(0, n.t), durationMs) });
  }
  return sortNotes(merged);
}
