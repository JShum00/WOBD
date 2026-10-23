// Merges scripts/i18n-src/*.json into data/i18n/en.json (sorted, duplicate keys rejected).
// Run: node scripts/build-i18n.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dir = new URL('scripts/i18n-src/', root);
const merged = {};
const owner = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const data = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') throw new Error(`${file}: ${key} is not a string`);
    if (key in merged) throw new Error(`Duplicate key ${key} in ${file} and ${owner[key]}`);
    merged[key] = value;
    owner[key] = file;
  }
}
const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
mkdirSync(new URL('data/i18n/', root), { recursive: true });
writeFileSync(new URL('data/i18n/en.json', root), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} keys -> data/i18n/en.json`);
