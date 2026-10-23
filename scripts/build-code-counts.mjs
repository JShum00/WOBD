// Writes data/code-counts.json, the totals shown on the Code Search page.
// Run after refreshing code data: node scripts/build-code-counts.mjs
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

async function countEntries(dir, files) {
  let total = 0;
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(`${dir}/${file}`, root), 'utf8'));
    total += Object.keys(data).length;
  }
  return total;
}

export async function buildCounts() {
  const jsonFiles = async (dir) => (await readdir(fileURLToPath(new URL(`${dir}/`, root))))
    .filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  const generic = await countEntries('data/generic', await jsonFiles('data/generic'));
  const manufacturer = await countEntries('data/manufacturer', await jsonFiles('data/manufacturer'));
  return { generic, manufacturer, total: generic + manufacturer };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = await buildCounts();
  await writeFile(new URL('data/code-counts.json', root), `${JSON.stringify(counts, null, 2)}\n`);
  console.log(counts);
}
