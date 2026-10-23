// Tests for recording notes. Run: node scripts/test-annotations.mjs
import assert from 'node:assert/strict';
import {
  AnnotationError, MAX_COMMENT, MAX_LABEL, STORAGE_KEY, exportNotes, loadNotes, makeNote, mergeNotes,
  noteTitle, parseImport, saveNotes, sameRecording, sortNotes, loadReviews,
} from '../js/annotations.js';
import { parseRecording } from '../js/replay-data.js';

const csv = (value = 10) => `timestamp,elapsed_ms,pid,name,value,unit\n2026-10-02T12:00:01.000Z,1000,0x0D,Speed,${value},mph\n2026-10-02T12:00:02.000Z,2000,0x0D,Speed,12,mph\n`;
const FP = parseRecording(csv()).fingerprint;
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
const note = (over = {}) => makeNote({ t: 1500, type: 'hesitation', ...over }, 2000, 1000);

const cases = [
  ['a preset note gets its type title and a clamped time', () => {
    const n = makeNote({ t: 99999, type: 'stop-sign' }, 2000);
    assert.equal(n.t, 2000);
    assert.equal(noteTitle(n), 'Stop sign');
    assert.equal(makeNote({ t: -5, type: 'road' }, 2000).t, 0);
  }],
  ['custom notes need a label; presets ignore one', () => {
    assert.throws(() => note({ type: 'custom', label: '  ' }), AnnotationError);
    assert.equal(noteTitle(note({ type: 'custom', label: 'Pothole' })), 'Pothole');
    assert.equal(note({ label: 'ignored' }).label, '');
  }],
  ['bad type or time is rejected', () => {
    assert.throws(() => note({ type: 'nope' }), AnnotationError);
    assert.throws(() => note({ t: NaN }), AnnotationError);
  }],
  ['text is trimmed, stripped of control characters, and capped', () => {
    const n = note({ type: 'custom', label: `x${'a'.repeat(200)}`, comment: `hi\u0000there${'b'.repeat(900)}` });
    assert.equal(n.label.length, MAX_LABEL);
    assert.ok(n.comment.startsWith('hi there'));
    assert.equal(n.comment.length, MAX_COMMENT);
  }],
  ['the fingerprint follows content, not the file name, and changes when a value changes', () => {
    assert.ok(sameRecording(FP, parseRecording(csv()).fingerprint));
    assert.ok(!sameRecording(FP, parseRecording(csv(11)).fingerprint));
  }],
  ['notes save and reload for the same recording only', () => {
    const s = memory();
    const n = note();
    assert.equal(saveNotes(s, FP, 'a.csv', [n]), true);
    assert.deepEqual(loadNotes(s, FP), [n]);
    assert.deepEqual(loadNotes(s, parseRecording(csv(11)).fingerprint), []);
  }],
  ['saving no notes removes the entry', () => {
    const s = memory();
    saveNotes(s, FP, 'a.csv', [note()]);
    saveNotes(s, FP, 'a.csv', []);
    assert.deepEqual(JSON.parse(s.m.get(STORAGE_KEY)), {});
  }],
  ['blocked, full, or corrupt storage never throws', () => {
    const blocked = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    assert.equal(saveNotes(blocked, FP, 'a', [note()]), false);
    assert.deepEqual(loadNotes(blocked, FP), []);
    const bad = memory(); bad.setItem(STORAGE_KEY, '{oops');
    assert.deepEqual(loadNotes(bad, FP), []);
    assert.equal(saveNotes(bad, FP, 'a', [note()]), true);
  }],
  ['export then import round-trips and matches the recording', () => {
    const notes = [note({ t: 1800 }), note({ t: 200, type: 'custom', label: 'Bump', comment: 'rough road' })];
    const back = parseImport(exportNotes(FP, 'a.csv', notes), FP);
    assert.equal(back.matches, true);
    assert.deepEqual(back.notes, sortNotes(notes));
    assert.equal(back.name, 'a.csv');
  }],
  ['a file for a different recording is flagged as a mismatch, not applied silently', () => {
    const other = parseRecording(csv(11)).fingerprint;
    assert.equal(parseImport(exportNotes(other, 'b.csv', [note()]), FP).matches, false);
  }],
  ['bad import files give friendly errors; bad notes inside are dropped', () => {
    assert.throws(() => parseImport('nope', FP), AnnotationError);
    assert.throws(() => parseImport('{"format":"other"}', FP), AnnotationError);
    const text = exportNotes(FP, 'a', [note()]).replace('"hesitation"', '"<script>"');
    assert.deepEqual(parseImport(text, FP).notes, []);
    assert.throws(() => parseImport('x'.repeat(2 * 1024 * 1024), FP), AnnotationError);
  }],
  ['merging keeps each note once and clamps times', () => {
    const a = note({ t: 100 });
    const merged = mergeNotes([a], [a, { ...note({ t: 50 }), id: 'z', t: 99999 }], 2000);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((n) => n.t), [100, 2000]);
  }],
  ['reviews of detected events save, reload, and ignore junk', () => {
    const s = memory();
    saveNotes(s, FP, 'a.csv', [], { 'rpm-swing@5000': 'dismissed', 'bad id': 'real', 'comm-loss@10': 'nonsense' });
    assert.deepEqual(loadReviews(s, FP), { 'rpm-swing@5000': 'dismissed' });
    assert.deepEqual(loadReviews(s, parseRecording(csv(11)).fingerprint), {});
  }],
  ['reviews travel in the notes file, and old files without them still import', () => {
    const back = parseImport(exportNotes(FP, 'a.csv', [note()], { 'comm-loss@10': 'normal' }), FP);
    assert.deepEqual(back.reviews, { 'comm-loss@10': 'normal' });
    const old = JSON.stringify({ format: 'wobd-annotations', version: 1, recording: { name: 'a', ...FP }, notes: [note()] });
    assert.deepEqual(parseImport(old, FP).reviews, {});
  }],
  ['annotations never change the recording they describe', () => {
    const rec = parseRecording(csv());
    const before = JSON.stringify(rec.series.map((s) => [s.times, s.values]));
    makeNote({ t: 1000, type: 'road' }, rec.durationMs);
    assert.equal(JSON.stringify(rec.series.map((s) => [s.times, s.values])), before);
  }],
];

let failed = 0;
const rows = cases.map(([name, test]) => {
  try { test(); return { case: name, result: 'pass' }; } catch (err) { failed++; return { case: name, result: `FAIL: ${err.message}` }; }
});
console.table(rows);
if (failed) { console.error(`${failed} of ${cases.length} failed.`); process.exit(1); }
console.log(`All ${cases.length} passed`);
