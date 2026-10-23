// Checks the generated trouble code pages, sitemap, and canonical links.
// Run: node scripts/test-code-pages.mjs   (after: node scripts/build-code-pages.mjs)
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  ORIGIN, STATIC_PAGES, esc, relatedCodes, renderCodePage, renderSitemap,
  renderCodeList, injectCodeList,
} from './build-code-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(join(root, 'data/codes.json'), 'utf8'));
const codes = Object.keys(data).sort();
const titles = Object.fromEntries(codes.map((c) => [c, data[c].title]));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n`, err); process.exitCode = 1; }
}

const files = (await readdir(join(root, 'codes'))).filter((f) => f.endsWith('.html')).sort();
const pages = Object.fromEntries(await Promise.all(
  files.map(async (f) => [f, await readFile(join(root, 'codes', f), 'utf8')]),
));

await test('one page per curated code, no strays', () => {
  assert.deepEqual(files, codes.map((c) => `${c.toLowerCase()}.html`).sort());
});

await test('generated files are up to date (deterministic)', async () => {
  for (const code of codes) {
    assert.equal(pages[`${code.toLowerCase()}.html`], renderCodePage(code, data[code], codes, titles), code);
  }
  assert.equal(await readFile(join(root, 'sitemap.xml'), 'utf8'), renderSitemap(codes));
  const html = await readFile(join(root, 'codes.html'), 'utf8');
  assert.equal(html, injectCodeList(html, renderCodeList(codes, titles)));
});

await test('titles, descriptions and canonicals are unique and correct', () => {
  const titlesSeen = new Set();
  const descs = new Set();
  for (const code of codes) {
    const html = pages[`${code.toLowerCase()}.html`];
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const desc = html.match(/<meta name="description" content="(.*?)">/)[1];
    assert.ok(title.includes(code));
    const descLength = desc.replace(/&#?\w+;/g, 'x').length;
    assert.ok(descLength > 40 && descLength <= 160, `${code} description length ${descLength}`);
    assert.ok(!titlesSeen.has(title) && !descs.has(desc), `${code} duplicates`);
    titlesSeen.add(title); descs.add(desc);
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/codes/${code.toLowerCase()}">`));
    assert.equal(html.match(/<h1>/g).length, 1);
  }
});

await test('JSON-LD parses', async () => {
  for (const html of Object.values(pages)) {
    const json = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
    assert.equal(JSON.parse(json)[0]['@type'], 'BreadcrumbList');
  }
  const home = await readFile(join(root, 'index.html'), 'utf8');
  const homeJson = JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.deepEqual(homeJson['@graph'].map((n) => n['@type']), ['WebApplication', 'FAQPage']);
});

await test('HTML is escaped', () => {
  const entry = { title: 'A <b>&"x"</b>', plain: "It's <script>", urgency: 'low', causes: ['<i>'], difficulty: 'diy', tellMechanic: '"&"' };
  const html = renderCodePage('P9999', entry, ['P9999'], { P9999: entry.title });
  assert.ok(!html.includes('<script>alert') && !html.includes('<b>') && !html.includes('<i>'));
  assert.ok(!/<h1>[^<]*<b>/.test(html));
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});

await test('internal links resolve to real files', () => {
  const targets = new Set(STATIC_PAGES);
  for (const html of Object.values(pages)) {
    for (const [, href] of html.matchAll(/href="(\/[^"#]*)"/g)) {
      if (href.startsWith('/codes/')) {
        assert.ok(existsSync(join(root, `${href.slice(1)}.html`)), href);
      } else if (!/\.\w+$/.test(href)) {
        assert.ok(targets.has(href), href);
      } else {
        assert.ok(existsSync(join(root, href.slice(1))), href);
      }
    }
  }
});

await test('sitemap lists every page and canonical pages exist', async () => {
  const xml = await readFile(join(root, 'sitemap.xml'), 'utf8');
  for (const c of codes) assert.ok(xml.includes(`<loc>${ORIGIN}/codes/${c.toLowerCase()}</loc>`));
  for (const p of STATIC_PAGES) {
    assert.ok(xml.includes(`<loc>${ORIGIN}${p}</loc>`));
    const file = p === '/' ? 'index.html' : `${p.slice(1)}.html`;
    const html = await readFile(join(root, file), 'utf8');
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${p}">`), file);
  }
  const robots = await readFile(join(root, 'robots.txt'), 'utf8');
  assert.ok(robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
});

await test('related codes are valid and exclude self', () => {
  for (const c of codes) {
    const rel = relatedCodes(c, codes);
    assert.ok(rel.length > 0 && rel.length <= 4 && !rel.includes(c));
  }
});

await test('version links to a changelog entry', async () => {
  const v = (await readFile(join(root, 'js/version.js'), 'utf8')).match(/WOBD_VERSION = '([^']+)'/)[1];
  const log = await readFile(join(root, 'changelog.html'), 'utf8');
  assert.ok(log.includes(`<h2>v${v} `));
});

console.log(`${passed} tests passed`);
