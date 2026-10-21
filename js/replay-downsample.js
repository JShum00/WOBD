// Render-time downsampling for the Replay graphs. No DOM, so scripts/test-replay-downsample.mjs
// can check it in Node.
//
// The raw { times, values } arrays are never changed or dropped; this builds a small drawing
// view of them. Each pixel-wide bucket keeps its first, lowest, highest and last reading,
// in time order, so a one-sample spike always survives. Finding the extremes means looking at
// every reading once, so building a view costs O(readings); bucket and window edges are found
// by binary search. A view is cached and reused until the series or the drawing size changes.
//
// A "visual gap" is only a place where the graph does not draw a line, because readings are
// further apart than max(GAP_MIN_MS, GAP_FACTOR x the usual interval). It says nothing about
// why readings stopped: engine, ignition and adapter state cannot be told from it.

export const GAP_MIN_MS = 10000;
export const GAP_FACTOR = 5;
const MEDIAN_SAMPLE = 4096;

// Lowest and highest value of a non-empty array, without spreading it into Math.min/max
// (which throws a RangeError on arrays of a few hundred thousand entries).
export function extent(values) {
  if (!values.length) return { min: NaN, max: NaN };
  let min = values[0];
  let max = min;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// Median of the positive gaps between consecutive times, from at most MEDIAN_SAMPLE evenly
// strided differences, so the cost stays bounded. The median ignores a few long interruptions.
// Returns 0 when no two readings differ in time.
export function medianPositiveInterval(times) {
  const stride = Math.max(1, Math.ceil((times.length - 1) / MEDIAN_SAMPLE));
  const diffs = [];
  for (let i = 1; i < times.length; i += stride) {
    const d = times[i] - times[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  const mid = diffs.length >> 1;
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

export function gapThreshold(times) {
  return Math.max(GAP_MIN_MS, GAP_FACTOR * medianPositiveInterval(times));
}

// Series are cached by identity; a series that is already in time order is used as is.
// Otherwise a stable sorted copy is made and the original is left alone.
const prepared = new WeakMap();

export function prepareSeries(series) {
  let prep = prepared.get(series);
  if (prep) return prep;
  const { times, values } = series;
  let sorted = true;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) { sorted = false; break; }
  }
  let t = times;
  let v = values;
  if (!sorted) {
    const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b);
    t = order.map((i) => times[i]);
    v = order.map((i) => values[i]);
  }
  prep = { times: t, values: v, gapMs: gapThreshold(t), sortedCopy: !sorted };
  prepared.set(series, prep);
  return prep;
}

export function bucketIndex(t, t0, t1, buckets) {
  if (!(t1 > t0)) return 0;
  const b = Math.floor(((t - t0) / (t1 - t0)) * buckets);
  return b < 0 ? 0 : b >= buckets ? buckets - 1 : b;
}

// Number of readings at or before t.
export function countAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Downsamples readings [from, to) of a prepared series over the window t0..t1 split into
// `buckets` columns. Returns parallel arrays: times, values, index (position in the prepared
// series), bucket, and gapBefore (1 when no line may join this point to the one before it).
export function downsample(prep, { t0, t1, buckets, from = 0, to = prep.times.length }) {
  const { times, values, gapMs } = prep;
  const out = { times: [], values: [], index: [], bucket: [], gapBefore: [] };
  let i = from;
  while (i < to) {
    const b = bucketIndex(times[i], t0, t1, buckets);
    const gap = i > 0 && times[i] - times[i - 1] > gapMs ? 1 : 0;
    let minI = i;
    let maxI = i;
    let last = i;
    let j = i + 1;
    // A bucket also ends at a gap, so a gap inside a wide bucket still breaks the line.
    for (; j < to; j++) {
      const t = times[j];
      if (t - times[j - 1] > gapMs || bucketIndex(t, t0, t1, buckets) !== b) break;
      const v = values[j];
      if (v < values[minI]) minI = j;
      if (v > values[maxI]) maxI = j;
      last = j;
    }
    const keep = [i];
    for (const k of [minI, maxI, last].sort((a, c) => a - c)) if (k !== keep[keep.length - 1]) keep.push(k);
    keep.forEach((k, n) => {
      out.times.push(times[k]);
      out.values.push(values[k]);
      out.index.push(k);
      out.bucket.push(b);
      out.gapBefore.push(n === 0 ? gap : 0);
    });
    i = j;
  }
  return out;
}

// Remembers the last full view of each series and hands it back while the series, window
// and bucket count are unchanged. stats counts real builds against reuse.
export function createDownsampleCache() {
  const entries = new WeakMap();
  const stats = { computes: 0, hits: 0 };
  return {
    stats,
    get(prep, { t0, t1, buckets }) {
      const hit = entries.get(prep);
      if (hit && hit.t0 === t0 && hit.t1 === t1 && hit.buckets === buckets) {
        stats.hits++;
        return hit.view;
      }
      stats.computes++;
      const view = downsample(prep, { t0, t1, buckets });
      entries.set(prep, { t0, t1, buckets, view });
      return view;
    },
  };
}

// What to draw up to the playhead at time t, as parts to draw in order: the cached view's
// buckets that finished before the playhead, then the bucket the playhead is in rebuilt from
// the raw readings up to t alone, so nothing after the playhead shows. The rebuilt part only
// looks at one bucket's readings. Each part is { view, count }: draw view's first `count` points.
export function playedParts(prep, view, t, { t0, t1, buckets }) {
  const end = countAtOrBefore(prep.times, t);
  if (end === 0) return [];
  const b = bucketIndex(t, t0, t1, buckets);
  let cut = 0;
  let hi = view.bucket.length;
  while (cut < hi) {
    const mid = (cut + hi) >> 1;
    if (view.bucket[mid] < b) cut = mid + 1; else hi = mid;
  }
  // First reading that falls in the playhead's bucket (times are sorted, so buckets only rise).
  let lo = 0;
  hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bucketIndex(prep.times[mid], t0, t1, buckets) < b) lo = mid + 1; else hi = mid;
  }
  const parts = [];
  if (cut) parts.push({ view, count: cut });
  if (lo < end) {
    const tail = downsample(prep, { t0, t1, buckets, from: lo, to: end });
    parts.push({ view: tail, count: tail.times.length });
  }
  return parts;
}
