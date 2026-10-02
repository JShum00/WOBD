// Builds data/generic/*.json from OBDex's generic DTC list (CC0).
// Run: node scripts/update-generic-codes.mjs   (needs `npm install` first)
// Only the English text is kept. If anything changed, CACHE_VERSION in sw.js is bumped.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const SOURCE = 'https://raw.githubusercontent.com/foerbsnavi/OBDex/main/data/generic';
const FAMILIES = ['P0', 'P2', 'P3', 'U0', 'U3', 'B0', 'C0'];
const LIKELIHOOD = { high: 0, medium: 1, low: 2 };
const DIFFICULTY = { easy: 'diy', medium: 'moderate', hard: 'shop', shop_only: 'shop' };
const MAX_CAUSES = 4;

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Same keys as data/codes.json so Bob can use either.
function convert(entry) {
  const causes = [...(entry.common_causes ?? [])]
    .sort((a, b) => (LIKELIHOOD[a.likelihood] ?? 3) - (LIKELIHOOD[b.likelihood] ?? 3))
    .slice(0, MAX_CAUSES)
    .map((cause) => cause.label?.en)
    .filter(Boolean);
  const out = { title: entry.title.en.trim() };
  if (entry.description?.en) out.plain = entry.description.en.replace(/\s+/g, ' ').trim();
  if (causes.length) out.causes = causes;
  const difficulty = DIFFICULTY[entry.repair?.difficulty];
  if (difficulty) out.difficulty = difficulty;
  return out;
}

await mkdir(new URL('data/generic/', root), { recursive: true });
let changed = false;
let total = 0;

for (const family of FAMILIES) {
  const entries = parse(await fetchText(`${SOURCE}/${family}xxx_enriched.yaml`));
  const out = {};
  for (const entry of entries) {
    if (!/^[PBCU][0-3][0-9A-F]{3}$/.test(entry.code) || !entry.title?.en) continue;
    out[entry.code] = convert(entry);
  }
  if (Object.keys(out).length === 0) throw new Error(`${family}: no codes parsed`);
  total += Object.keys(out).length;

  const file = new URL(`data/generic/${family}.json`, root);
  const text = JSON.stringify(out);
  if (text !== await readFile(file, 'utf8').catch(() => '')) {
    await writeFile(file, text);
    changed = true;
  }
}

if (changed) {
  const swUrl = new URL('sw.js', root);
  const sw = await readFile(swUrl, 'utf8');
  await writeFile(swUrl, sw.replace(/(CACHE_VERSION = 'v)(\d+)'/, (_, p, n) => `${p}${Number(n) + 1}'`));
}
console.log(`${total} codes. ${changed ? 'Updated data/generic/ and bumped CACHE_VERSION.' : 'No changes.'}`);
