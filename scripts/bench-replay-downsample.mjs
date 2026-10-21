// Benchmark for Replay graph downsampling. Not part of the regression suite.
// Run: node scripts/bench-replay-downsample.mjs
//
// Synthetic series (seeded noise, a few 5-minute gaps); only the Node timings are measured.
// Browser drawing time and frame rate on a ChromeOS device are NOT measured here.
import { createDownsampleCache, playedParts, prepareSeries } from '../js/replay-downsample.js';

let seed = 3;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

function makeSeries(n, stepMs) {
  const times = new Array(n);
  const values = new Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += stepMs * (0.9 + rnd() * 0.2) + (i > 0 && i % Math.floor(n / 4) === 0 ? 300_000 : 0);
    times[i] = t;
    values[i] = 50 + 30 * Math.sin(i / 400) + rnd() * 5;
  }
  return { times, values };
}

const time = (fn) => { const s = performance.now(); const r = fn(); return [performance.now() - s, r]; };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const BUCKETS = 1100;
const FRAMES = 3600;   // one minute of playback at 60 fps

function scenario(name, seriesList) {
  const rows = seriesList.reduce((n, s) => n + s.times.length, 0);
  const cache = createDownsampleCache();
  const [prepMs, preps] = time(() => seriesList.map(prepareSeries));
  const opts = (s) => ({ t0: 0, t1: s.times.at(-1), buckets: BUCKETS });
  const [buildMs] = time(() => preps.forEach((p) => cache.get(p, opts(p))));
  const frameMs = [];
  let points = 0;
  for (let f = 0; f < FRAMES; f++) {
    const [ms, n] = time(() => {
      let drawn = 0;
      for (const p of preps) {
        const o = opts(p);
        const parts = playedParts(p, cache.get(p, o), (f / FRAMES) * o.t1, o);
        for (const part of parts) drawn += part.count;
      }
      return drawn;
    });
    frameMs.push(ms);
    points += n;
  }
  console.log(`${name}: ${seriesList.length} series, ${rows.toLocaleString()} readings, ${BUCKETS} px`);
  console.log(`  preprocessing: prepare+median ${prepMs.toFixed(1)} ms, first downsample ${buildMs.toFixed(1)} ms`);
  console.log(`  per frame (all series): median ${median(frameMs).toFixed(3)} ms, max ${Math.max(...frameMs).toFixed(3)} ms, ~${Math.round(points / FRAMES)} points drawn`);
  console.log(`  cache over ${FRAMES} frames: ${cache.stats.computes} builds, ${cache.stats.hits} reuses`);
}

scenario('7 h at 30 readings/s over 13 PIDs', Array.from({ length: 13 }, () => makeSeries(58_000, 433)));
scenario('one series, 756,000 readings', [makeSeries(756_000, 33)]);
scenario('one series, 2,000,000 readings', [makeSeries(2_000_000, 12)]);
