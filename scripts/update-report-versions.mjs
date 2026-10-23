// Reads the WOBD version out of each test's report files and records it in
// data/tested-adapters.json as reports.versions. CSV recordings start with
// "# WOBD v1.71"; adapter traffic logs start with "WOBD v1.71". Files that don't say
// (older exports, PDFs) are skipped; set "wobdVersion" by hand for those, because a
// hand-set value always wins.
// Run: node scripts/update-report-versions.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersionLine } from '../js/version-info.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'data/tested-adapters.json');

export async function fileVersion(path) {
  try {
    const text = await readFile(join(root, path), 'utf8');
    return parseVersionLine(text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function extractVersions(reports) {
  const versions = {};
  for (const key of ['csv', 'traffic']) {
    const version = reports?.[key] ? await fileVersion(reports[key]) : null;
    if (version) versions[key] = version;
  }
  return versions;
}

async function main() {
  const results = JSON.parse(await readFile(jsonPath, 'utf8'));
  let changed = 0;
  for (const result of results) {
    if (!result.reports) continue;
    const versions = await extractVersions(result.reports);
    const before = JSON.stringify(result.reports.versions ?? null);
    if (Object.keys(versions).length) result.reports.versions = versions;
    else delete result.reports.versions;
    if (JSON.stringify(result.reports.versions ?? null) !== before) changed++;
    console.log(`${result.id}: ${JSON.stringify(versions)}${result.wobdVersion ? ` (manual override ${result.wobdVersion} wins)` : ''}`);
  }
  await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${changed} entr${changed === 1 ? 'y' : 'ies'} updated.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
