// Builds data/manufacturer/*.json from the MIT-licensed OBD Dashboard DTC database.
// Run: node scripts/update-manufacturer-codes.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isManufacturerCode, manufacturerMakeKey } from '../js/dtc.js';

const root = new URL('../', import.meta.url);
const REPO = 'https://api.github.com/repos/kierandrewett/obd';
const BRANCH = 'main';
const DATA_DIR = new URL('data/manufacturer/', root);

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

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${url}: invalid JSON (${err.message})`);
  }
}

const tree = await fetchJson(`${REPO}/git/trees/${BRANCH}?recursive=1`);
if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('The upstream repository tree is incomplete.');

const files = tree.tree
  .filter((item) => item.type === 'blob' && /^dtc_codes\/[^/]+\.json$/.test(item.path)
    && !item.path.endsWith('/_generic.json'))
  .map((item) => {
    const filename = item.path.slice('dtc_codes/'.length, -'.json'.length);
    const key = manufacturerMakeKey(filename);
    if (!key) throw new Error(`Invalid make filename: ${item.path}`);
    return { key, path: item.path };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

if (!files.length || new Set(files.map(({ key }) => key)).size !== files.length) {
  throw new Error('No manufacturer files found or make filenames collide after normalization.');
}

const books = await Promise.all(files.map(async ({ key, path }) => {
  const url = `https://raw.githubusercontent.com/kierandrewett/obd/${BRANCH}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const source = await fetchJson(url);
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${path}: expected an object mapping DTCs to descriptions.`);
  }

  const entries = {};
  for (const [code, description] of Object.entries(source)) {
    if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(code)) throw new Error(`${path}: invalid DTC ${code}`);
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error(`${path}: ${code} has no description.`);
    }
    if (isManufacturerCode(code)) entries[code] = description.trim();
  }
  if (!Object.keys(entries).length) throw new Error(`${path}: no manufacturer-specific DTCs found.`);
  return { key, entries };
}));

const license = await fetchText(`https://raw.githubusercontent.com/kierandrewett/obd/${BRANCH}/LICENSE`);
if (!license.includes('MIT License') || !license.includes('Copyright (c)')) {
  throw new Error('The upstream license is missing or is not the expected MIT license.');
}

await mkdir(DATA_DIR, { recursive: true });
let changed = false;
let total = 0;
const uniqueCodes = new Set();
const appShellEntries = ["'data/manufacturer/index.json',", "'data/manufacturer/LICENSE',"];
const index = [];

for (const { filename, key, entries } of books) {
  const text = JSON.stringify(entries);
  const file = new URL(`${key}.json`, DATA_DIR);
  if (text !== await readFile(file, 'utf8').catch(() => '')) {
    await writeFile(file, text);
    changed = true;
  }
  total += Object.keys(entries).length;
  Object.keys(entries).forEach((code) => uniqueCodes.add(code));
  index.push(key);
  appShellEntries.push(`'data/manufacturer/${key}.json',`);
}

const indexText = JSON.stringify(index);
if (indexText !== await readFile(new URL('index.json', DATA_DIR), 'utf8').catch(() => '')) {
  await writeFile(new URL('index.json', DATA_DIR), indexText);
  changed = true;
}
if (license !== await readFile(new URL('LICENSE', DATA_DIR), 'utf8').catch(() => '')) {
  await writeFile(new URL('LICENSE', DATA_DIR), license);
  changed = true;
}

const swUrl = new URL('sw.js', root);
const sw = await readFile(swUrl, 'utf8');
const shellBlock = `  // manufacturer-codes:start\n${appShellEntries.map((entry) => `  ${entry}`).join('\n')}\n  // manufacturer-codes:end`;
const marker = /  \/\/ manufacturer-codes:start[\s\S]*?  \/\/ manufacturer-codes:end/;
if (!marker.test(sw)) throw new Error('sw.js is missing the manufacturer-code cache markers.');
const nextSw = sw.replace(marker, shellBlock);
if (nextSw !== sw) {
  const bumpedSw = nextSw.replace(/(const CACHE_VERSION = 'v)(\d+)'/, (_, prefix, version) => `${prefix}${Number(version) + 1}'`);
  if (bumpedSw === nextSw) throw new Error('Could not bump CACHE_VERSION in sw.js.');
  await writeFile(swUrl, bumpedSw);
  changed = true;
}

console.log(`${total} manufacturer-specific make/code entries across ${books.length} makes (${uniqueCodes.size} distinct code numbers). ${changed ? 'Updated data/manufacturer/ and bumped CACHE_VERSION.' : 'No changes.'}`);
