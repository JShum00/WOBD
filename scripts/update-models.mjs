// Refreshes data/models.json from NHTSA's vPIC API. Run: node scripts/update-models.mjs
// If the list changed, it also bumps CACHE_VERSION in sw.js so returning users get it.
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const API = 'https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make';
// vPIC splits passenger vehicles across these types; motorcycles and ATVs are left out.
const TYPES = ['car', 'truck', 'mpv'];

const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function modelsFor(make) {
  const names = new Set();
  for (const type of TYPES) {
    const { Results } = await fetchJson(`${API}/${encodeURIComponent(make)}/vehicleType/${type}?format=json`);
    for (const { Model_Name: name } of Results) if (/^[A-Za-z0-9]/.test(name?.trim() ?? '')) names.add(name.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const makes = await readJson('data/makes.json');
const previous = await readJson('data/models.json').catch(() => ({}));
const next = {};
let failures = 0;

for (const make of makes) {
  try {
    const models = await modelsFor(make);
    // An empty answer is more likely an API hiccup than a make with no models.
    if (models.length === 0 && previous[make]?.length) throw new Error('empty result');
    if (models.length) next[make] = models;
  } catch (err) {
    failures++;
    console.warn(`Keeping the old ${make} list: ${err.message}`);
    if (previous[make]) next[make] = previous[make];
  }
}

const text = `${JSON.stringify(next, null, 1)}\n`;
const old = await readFile(new URL('data/models.json', root), 'utf8').catch(() => '');
if (text === old) {
  console.log('No changes to data/models.json.');
} else {
  await writeFile(new URL('data/models.json', root), text);
  const swUrl = new URL('sw.js', root);
  const sw = await readFile(swUrl, 'utf8');
  await writeFile(swUrl, sw.replace(/(CACHE_VERSION = 'v)(\d+)'/, (_, p, n) => `${p}${Number(n) + 1}'`));
  console.log(`Updated data/models.json (${Object.keys(next).length} makes) and bumped CACHE_VERSION.`);
}
if (failures === makes.length) process.exit(1);
