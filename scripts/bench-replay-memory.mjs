// Memory benchmark for streaming CSV import. Not part of the regression suite.
// Run: node scripts/bench-replay-memory.mjs [hours=7] [readingsPerSecond=30] [--keep]
//
// Builds a deterministic synthetic recording by repeating the real PT Cruiser file's
// rows with seeded noise, then imports it in a fresh child process and reports the
// peak resident memory above that process's own baseline. The readings are synthetic;
// only the row shape and PID mix come from the real recording.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, statSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const SAMPLE = new URL('../reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv', import.meta.url);
const BUDGET_MB = 150;

if (process.argv[2] === '--child') {
  const { parseRecordingStream } = await import('../js/replay-data.js');
  const baseline = process.resourceUsage().maxRSS;
  const started = performance.now();
  const rec = await parseRecordingStream(Readable.toWeb(createReadStream(process.argv[3])));
  const ms = performance.now() - started;
  const peak = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({ readings: rec.readingCount, series: rec.series.length, ms, baselineMb: baseline / 1024, peakMb: peak / 1024 }));
  process.exit(0);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const hours = Number(args[0] ?? 7);
const rate = Number(args[1] ?? 30);
const keep = process.argv.includes('--keep');
const rowCount = Math.round(hours * 3600 * rate);
const stepMs = 1000 / rate;

const [header, ...template] = readFileSync(SAMPLE, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => line.split(','));
let seed = 1;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const startMs = Date.parse('2026-10-02T12:00:00Z');

const file = join(tmpdir(), `wobd-bench-${hours}h-${rate}hz.csv`);
const out = createWriteStream(file);
out.write(`${header.join(',')}\n`);
let batch = [];
for (let i = 0; i < rowCount; i++) {
  const row = template[i % template.length].slice();
  const elapsed = Math.round(i * stepMs);
  row[0] = new Date(startMs + elapsed).toISOString();
  row[1] = String(elapsed);
  const value = Number(row[4]);
  if (Number.isFinite(value) && row[4] !== '') row[4] = (value * (1 + (rnd() - 0.5) * 0.02)).toFixed(2);
  batch.push(row.join(','));
  if (batch.length === 5000) {
    if (!out.write(`${batch.join('\n')}\n`)) await once(out, 'drain');
    batch = [];
  }
}
out.write(batch.length ? `${batch.join('\n')}\n` : '');
out.end();
await once(out, 'finish');
const bytes = statSync(file).size;

const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--child', file], { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = '';
child.stdout.on('data', (d) => { stdout += d; });
const [code] = await once(child, 'close');
if (!keep) unlinkSync(file);
if (code !== 0) { console.error('child failed'); process.exit(1); }

const r = JSON.parse(stdout);
const above = r.peakMb - r.baselineMb;
console.log(`fixture: ${hours} h at ${rate} readings/s, ${rowCount.toLocaleString()} rows, ${(bytes / 1024 / 1024).toFixed(1)} MiB (synthetic)`);
console.log(`parsed: ${r.readings.toLocaleString()} readings, ${r.series} series in ${(r.ms / 1000).toFixed(2)} s`);
console.log(`peak memory above baseline: ${above.toFixed(1)} MB (baseline ${r.baselineMb.toFixed(0)} MB, budget ${BUDGET_MB} MB)`);
console.log(above <= BUDGET_MB ? 'within budget' : 'OVER BUDGET');
process.exit(above <= BUDGET_MB ? 0 : 1);
