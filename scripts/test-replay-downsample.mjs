// Tests for the Replay graph downsampling. Run: node scripts/test-replay-downsample.mjs
// Prints a table and exits non-zero if any case fails.
import assert from 'node:assert/strict';
import {
  GAP_MIN_MS, bucketIndex, countAtOrBefore, createDownsampleCache, downsample, extent,
  gapThreshold, medianPositiveInterval, playedParts, prepareSeries,
} from '../js/replay-downsample.js';
import { parseRecording } from '../js/replay-data.js';

// Frozen arrays: any write to the raw readings throws in these (strict-mode) modules.
const freeze = (times, values) => ({ times: Object.freeze([...times]), values: Object.freeze([...values]) });
let seed = 7;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const regular = (n, stepMs, valueAt) => freeze(Array.from({ length: n }, (_, i) => i * stepMs), Array.from({ length: n }, (_, i) => valueAt(i)));
const win = (series, buckets) => ({ t0: 0, t1: series.times.at(-1), buckets });
const view = (series, buckets) => downsample(prepareSeries(series), win(series, buckets));
const joined = (v) => v.times.map((t, i) => [t, v.values[i], v.gapBefore[i]]);

// Points grouped into the lines that would actually be drawn.
const segments = (v) => {
  const out = [];
  v.times.forEach((t, i) => {
    if (i === 0 || v.gapBefore[i]) out.push([]);
    out.at(-1).push(i);
  });
  return out;
};

const cases = [
  ['extent handles one million readings where Math.min(...) throws', () => {
    const values = Array.from({ length: 1_000_000 }, (_, i) => (i * 7919) % 10007);
    assert.throws(() => Math.min(...values), RangeError);
    assert.deepEqual(extent(values), { min: 0, max: 10006 });
    assert.deepEqual(extent([3]), { min: 3, max: 3 });
    assert.deepEqual(extent([-2, -9, -4]), { min: -9, max: -2 });
    assert.ok(Number.isNaN(extent([]).min));
  }],
  ['median interval: ignores long interruptions and equal timestamps', () => {
    assert.equal(medianPositiveInterval([0, 100, 200, 300]), 100);
    assert.equal(medianPositiveInterval([0, 100, 100, 200, 90_000, 90_100, 90_200]), 100);
    assert.equal(medianPositiveInterval([5]), 0);
    assert.equal(medianPositiveInterval([5, 5, 5]), 0);
    assert.equal(medianPositiveInterval([0, 100, 300]), 150, 'even count averages the middle two');
  }],
  ['median interval: bounded work on huge series, still right', () => {
    const times = Array.from({ length: 2_000_000 }, (_, i) => i * 33);
    assert.equal(medianPositiveInterval(times), 33);
    const withGaps = times.map((t, i) => t + Math.floor(i / 500_000) * 600_000);
    assert.equal(medianPositiveInterval(withGaps), 33, 'a few long interruptions do not move the median');
  }],
  ['gap threshold is max(10 s, 5 x median)', () => {
    assert.equal(gapThreshold([0, 150, 300, 450]), GAP_MIN_MS);
    assert.equal(gapThreshold([0, 3000, 6000, 9000]), 15000);
    assert.equal(gapThreshold([7]), GAP_MIN_MS);
  }],
  ['an isolated one-sample spike survives at every width', () => {
    const n = 20_000;
    const series = regular(n, 50, (i) => (i === 12_345 ? 5000 : 100));
    for (const buckets of [1, 7, 60, 333, 1200]) {
      const v = view(series, buckets);
      assert.ok(v.values.includes(5000), `spike kept at ${buckets} buckets`);
      assert.ok(v.times[v.values.indexOf(5000)] === 12_345 * 50, 'at its own time');
      assert.ok(v.values.every((x) => x === 100 || x === 5000));
    }
    const dip = regular(n, 50, (i) => (i === 777 ? -40 : 100));
    assert.ok(view(dip, 200).values.includes(-40));
  }],
  ['flat values keep only each bucket\'s first and last reading', () => {
    const series = regular(10_000, 10, () => 42);
    const v = view(series, 100);
    assert.ok(v.times.length <= 200);
    assert.ok(v.values.every((x) => x === 42));
    const perBucket = new Map();
    v.bucket.forEach((b) => perBucket.set(b, (perBucket.get(b) ?? 0) + 1));
    assert.ok([...perBucket.values()].every((c) => c <= 2));
  }],
  ['matches a brute-force first/min/max/last per bucket on random data', () => {
    for (let round = 0; round < 40; round++) {
      const n = 200 + Math.floor(rnd() * 3000);
      const times = [];
      let t = 0;
      for (let i = 0; i < n; i++) { times.push(t); t += Math.floor(rnd() * 80); }   // many equal timestamps
      const series = freeze(times, times.map(() => Math.round(rnd() * 1000) / 10));
      const buckets = 5 + Math.floor(rnd() * 400);
      const w = win(series, buckets);
      const v = downsample(prepareSeries(series), w);
      const groups = new Map();
      series.times.forEach((tt, i) => {
        const b = bucketIndex(tt, w.t0, w.t1, buckets);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(i);
      });
      for (const [b, idx] of groups) {
        const got = v.index.map((k, p) => [k, p]).filter(([, p]) => v.bucket[p] === b).map(([k]) => k);
        const vals = idx.map((i) => series.values[i]);
        const keptVals = got.map((k) => series.values[k]);
        assert.equal(Math.min(...keptVals), Math.min(...vals), `min, bucket ${b}`);
        assert.equal(Math.max(...keptVals), Math.max(...vals), `max, bucket ${b}`);
        assert.ok(got.includes(idx[0]) && got.includes(idx.at(-1)), 'first and last kept');
        assert.deepEqual(got, [...got].sort((a, c) => a - c), 'chronological');
        assert.ok(got.length <= 4);
      }
      for (let p = 1; p < v.times.length; p++) assert.ok(v.index[p] > v.index[p - 1] && v.times[p] >= v.times[p - 1]);
    }
  }],
  ['output never exceeds four points per bucket, whatever the reading count', () => {
    const series = regular(300_000, 7, (i) => Math.sin(i / 50) * 100 + (i % 97));
    for (const buckets of [10, 500, 1200]) assert.ok(view(series, buckets).times.length <= 4 * buckets);
  }],
  ['sparse data (about one reading per bucket or fewer) comes back unchanged', () => {
    const series = regular(300, 1000, (i) => i * 1.5);
    const v = view(series, 1200);
    assert.deepEqual(v.times, [...series.times]);
    assert.deepEqual(v.values, [...series.values]);
    assert.ok(v.gapBefore.every((g) => g === 0));
    const one = freeze([500], [9]);
    assert.deepEqual(joined(downsample(prepareSeries(one), { t0: 0, t1: 500, buckets: 100 })), [[500, 9, 0]]);
  }],
  ['equal timestamps keep every reading\'s extremes and their file order', () => {
    const series = freeze([0, 0, 0, 0, 1000, 1000], [5, 9, 1, 5, 2, 3]);
    const v = downsample(prepareSeries(series), { t0: 0, t1: 1000, buckets: 1 });
    assert.deepEqual(v.index, [0, 1, 2, 5], 'first, highest (9), lowest (1) and last, in file order');
    assert.deepEqual(v.values, [5, 9, 1, 3]);
  }],
  ['a gap breaks the line: no segment spans it', () => {
    const times = [];
    for (let t = 0; t <= 60_000; t += 100) times.push(t);
    for (let t = 330_000; t <= 400_000; t += 100) times.push(t);   // 4.5 minute gap
    const series = freeze(times, times.map((_, i) => i % 50));
    for (const buckets of [20, 100, 1200]) {
      const v = view(series, buckets);
      const gapped = v.times.map((t, i) => i && v.gapBefore[i] ? i : -1).filter((i) => i >= 0);
      assert.equal(gapped.length, 1, `one break at ${buckets} buckets`);
      assert.equal(v.times[gapped[0] - 1], 60_000);
      assert.equal(v.times[gapped[0]], 330_000);
      for (const seg of segments(v)) {
        const ts = seg.map((i) => v.times[i]);
        assert.ok(!(ts[0] < 100_000 && ts.at(-1) > 300_000), 'no segment crosses the gap');
      }
    }
  }],
  ['a line is broken exactly where the raw readings it would skip contain a real gap', () => {
    for (let round = 0; round < 30; round++) {
      const times = [];
      let t = 0;
      for (let i = 0; i < 2000; i++) { t += rnd() < 0.01 ? 15_000 + rnd() * 60_000 : 20 + rnd() * 60; times.push(t); }
      const series = freeze(times, times.map(() => rnd() * 100));
      const prep = prepareSeries(series);
      const v = view(series, 10 + Math.floor(rnd() * 300));
      const gapsUpTo = [0];   // gapsUpTo[k] = real gaps among raw readings 1..k
      for (let k = 1; k < times.length; k++) gapsUpTo.push(gapsUpTo[k - 1] + (times[k] - times[k - 1] > prep.gapMs ? 1 : 0));
      for (let p = 1; p < v.times.length; p++) {
        const skipped = gapsUpTo[v.index[p]] - gapsUpTo[v.index[p - 1]];
        assert.equal(v.gapBefore[p], skipped > 0 ? 1 : 0, `point ${p}`);
      }
    }
  }],
  ['a gap hidden inside one wide bucket still breaks the line', () => {
    const series = freeze([0, 100, 200, 30_000, 30_100, 30_200], [1, 2, 3, 4, 5, 6]);
    const v = downsample(prepareSeries(series), { t0: 0, t1: 30_200, buckets: 1 });
    assert.deepEqual(joined(v).map((p) => p[2]), [0, 0, 1, 0]);
    assert.equal(segments(v).length, 2);
  }],
  ['gaps scale with slow series: 3 s sampling is not a gap at 12 s', () => {
    const slow = freeze([0, 3000, 6000, 9000, 21_000, 24_000], [1, 2, 3, 4, 5, 6]);
    const v = downsample(prepareSeries(slow), { t0: 0, t1: 24_000, buckets: 100 });
    assert.deepEqual(v.gapBefore, [0, 0, 0, 0, 0, 0], '12 s is under 5 x 3 s');
    const wide = freeze([0, 3000, 6000, 9000, 30_000, 33_000], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(downsample(prepareSeries(wide), { t0: 0, t1: 33_000, buckets: 100 }).gapBefore, [0, 0, 0, 0, 1, 0]);
  }],
  ['an isolated reading between two gaps is its own one-point segment', () => {
    const times = [];
    for (let t = 0; t <= 1000; t += 100) times.push(t);
    times.push(100_000);
    for (let t = 200_000; t <= 201_000; t += 100) times.push(t);
    const series = freeze(times, times.map((_, i) => i));
    const v = downsample(prepareSeries(series), { t0: 0, t1: 201_000, buckets: 50 });
    const lengths = segments(v).map((s) => s.length);
    assert.equal(lengths.length, 3);
    assert.equal(lengths[1], 1, 'the lone reading stands on its own');
    assert.ok(v.times.includes(100_000));
  }],
  ['out-of-order input is sorted into a copy and gives the same view as sorted input', () => {
    const times = [300, 100, 500, 200, 100, 400, 900_000];
    const values = [3, 1, 5, 2, 9, 4, 7];
    const messy = freeze(times, values);
    const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b);
    const sorted = freeze(order.map((i) => times[i]), order.map((i) => values[i]));
    const prep = prepareSeries(messy);
    assert.equal(prep.sortedCopy, true);
    assert.deepEqual(prep.times, [...sorted.times]);
    assert.equal(prepareSeries(messy), prep, 'prepared once per series');
    assert.deepEqual(view(messy, 40), view(sorted, 40));
    assert.deepEqual([...messy.times], times, 'raw readings untouched');
    assert.equal(prepareSeries(sorted).sortedCopy, false);
    assert.equal(prepareSeries(sorted).times, sorted.times, 'sorted input is used as is');
  }],
  ['an out-of-order CSV draws the same as the same CSV in order', () => {
    const head = 'timestamp,elapsed_ms,pid,name,value,unit\n';
    const line = (t, v) => `x,${t},0x0D,Speed,${v},mph\n`;
    const a = parseRecording(head + line(300, 3) + line(100, 1) + line(200, 2) + line(200, 9));
    const b = parseRecording(head + line(100, 1) + line(200, 2) + line(200, 9) + line(300, 3));
    assert.deepEqual(view(a.series[0], 10), view(b.series[0], 10));
  }],
  ['nothing writes to the raw readings, however many views are built', () => {
    const series = regular(50_000, 20, (i) => i % 13);
    const cache = createDownsampleCache();
    const prep = prepareSeries(series);
    for (const buckets of [10, 200, 900]) {
      const w = win(series, buckets);
      const v = cache.get(prep, w);
      playedParts(prep, v, 400_000, w);
    }
    assert.equal(series.times.length, 50_000);
    assert.ok(Object.isFrozen(series.times) && Object.isFrozen(series.values));
  }],
  ['a series of more than 500,000 readings downsamples correctly', () => {
    const n = 600_000;
    const series = regular(n, 33, (i) => (i === 431_111 ? 9999 : 50 + (i % 11)));
    const started = performance.now();
    const v = view(series, 1100);
    const ms = performance.now() - started;
    assert.ok(v.times.length <= 4400);
    assert.ok(v.values.includes(9999));
    assert.equal(v.times[0], 0);
    assert.equal(v.times.at(-1), (n - 1) * 33);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
    assert.deepEqual(extent(series.values), { min: 50, max: 9999 });
  }],
  ['cache: same series, window and width reuse the view; any change rebuilds', () => {
    const series = regular(5000, 10, (i) => i);
    const prep = prepareSeries(series);
    const cache = createDownsampleCache();
    const w = win(series, 300);
    const first = cache.get(prep, w);
    assert.equal(cache.get(prep, { ...w }), first, 'same object');
    assert.deepEqual(cache.stats, { computes: 1, hits: 1 });
    cache.get(prep, { ...w, buckets: 301 });
    assert.equal(cache.stats.computes, 2);
    cache.get(prep, { ...w, buckets: 301, t1: w.t1 + 1 });
    assert.equal(cache.stats.computes, 3);
    const other = prepareSeries(regular(10, 10, (i) => i));
    cache.get(other, win({ times: other.times }, 300));
    assert.equal(cache.stats.computes, 4);
  }],
  ['cache: playing a recording from start to end builds the view once', () => {
    const series = regular(100_000, 20, (i) => i % 31);
    const prep = prepareSeries(series);
    const cache = createDownsampleCache();
    const w = win(series, 800);
    for (let frame = 0; frame <= 600; frame++) {
      const t = (frame / 600) * w.t1;
      const view = cache.get(prep, w);
      playedParts(prep, view, t, w);
    }
    assert.equal(cache.stats.computes, 1);
    assert.equal(cache.stats.hits, 600);
  }],
  ['played view up to the playhead equals a fresh downsample of the readings up to it', () => {
    const times = [];
    let t = 0;
    for (let i = 0; i < 6000; i++) { t += rnd() < 0.005 ? 20_000 : 10 + rnd() * 40; times.push(t); }
    const series = freeze(times, times.map(() => rnd() * 100));
    const prep = prepareSeries(series);
    const w = { t0: 0, t1: t, buckets: 250 };
    const full = downsample(prep, w);
    for (let k = 0; k < 120; k++) {
      const at = rnd() * t;
      const end = countAtOrBefore(prep.times, at);
      const expected = downsample(prep, { ...w, from: 0, to: end });
      const got = { times: [], values: [], gapBefore: [], index: [] };
      for (const part of playedParts(prep, full, at, w)) {
        for (let i = 0; i < part.count; i++) for (const key of Object.keys(got)) got[key].push(part.view[key][i]);
      }
      assert.deepEqual(got, { times: expected.times, values: expected.values, gapBefore: expected.gapBefore, index: expected.index }, `playhead ${at}`);
      assert.ok(got.times.every((x) => x <= at), 'no reading after the playhead');
    }
    assert.deepEqual(playedParts(prep, full, -5, w), []);
  }],
  ['an empty series and a zero-length window do not break anything', () => {
    const empty = freeze([], []);
    assert.deepEqual(view({ times: [], values: [] }, 10).times, []);
    const one = freeze([0, 0], [4, 6]);
    const v = downsample(prepareSeries(one), { t0: 0, t1: 0, buckets: 10 });
    assert.deepEqual(v.values, [4, 6]);
    assert.deepEqual(playedParts(prepareSeries(empty), v, 10, { t0: 0, t1: 0, buckets: 10 }), []);
  }],
];

let failed = 0;
const rows = [];
for (const [name, test] of cases) {
  try {
    await test();
    rows.push({ case: name, result: 'pass' });
  } catch (err) {
    failed++;
    rows.push({ case: name, result: `FAIL: ${err.message}` });
  }
}
console.table(rows);
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`All ${cases.length} passed`);
