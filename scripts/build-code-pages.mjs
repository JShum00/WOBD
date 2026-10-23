// Generates the static, search-engine-friendly trouble code pages
// (codes/<code>.html), sitemap.xml, and the code list inside codes.html from
// data/codes.json. Run it after editing data/codes.json:
//   node scripts/build-code-pages.mjs
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://wobd.app';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const URGENCY = {
  low: { label: 'Low', says: "Safe to drive. Get it looked at when it's convenient." },
  medium: { label: 'Medium', says: 'Drive gently and get it checked soon.' },
  high: { label: 'High', says: "Pull over when it's safe. Driving on this could damage the engine." },
};
const DIFFICULTY = {
  diy: 'Easy DIY',
  moderate: "DIY if you're handy",
  shop: 'Shop job',
};
const SYSTEMS = {
  P: 'engine or transmission',
  C: 'chassis (brakes, steering, or suspension)',
  B: 'body (airbags, locks, or lighting)',
  U: 'vehicle network (modules talking to each other)',
};

export const STATIC_PAGES = ['/', '/codes', '/replay', '/guide', '/tested-adapters', '/simulator', '/contact', '/changelog'];

export const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const jsonLd = (obj) => JSON.stringify(obj).replaceAll('<', '\\u003c');

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

export function relatedCodes(code, all) {
  const num = (c) => parseInt(c.slice(1), 16);
  return all
    .filter((c) => c !== code && c[0] === code[0])
    .sort((a, b) => Math.abs(num(a) - num(code)) - Math.abs(num(b) - num(code)) || a.localeCompare(b))
    .slice(0, 4)
    .sort();
}

const HEADER = `  <header class="site-header">
    <a class="logo" href="/"><img class="logo-image" src="/Assets/header-logo.png" alt="">WOBD</a>
    <div class="header-right">
      <nav class="site-nav" aria-label="Main navigation">
        <a class="header-link" href="/" data-nav="scanner">Scanner</a>
        <a class="header-link" href="/codes" data-nav="codes">Code Search</a>
        <a class="header-link" href="/replay" data-nav="replay">Replay</a>
        <a class="header-link" href="/#demos" data-nav="demos">Demos</a>
        <a class="header-link" href="/guide" data-nav="guide">How to Use</a>
        <a class="header-link" href="/tested-adapters" data-nav="adapters">Tested Adapters</a>
      </nav>
      <button id="theme-btn" type="button" class="theme-btn" aria-pressed="false" aria-label="Dark mode">
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>
      </button>
    </div>
  </header>`;

export function renderCodePage(code, entry, all, titles) {
  const url = `${ORIGIN}/codes/${code.toLowerCase()}`;
  const title = `${code} ${entry.title} · WOBD`;
  const description = clip(`${code} ${entry.title}: ${entry.plain}`, 158);
  const urgency = URGENCY[entry.urgency];
  const system = SYSTEMS[code[0]];
  const related = relatedCodes(code, all);

  const structured = [{
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'WOBD', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Trouble code search', item: `${ORIGIN}/codes` },
      { '@type': 'ListItem', position: 3, name: code, item: url },
    ],
  }];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#1F3F8F">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/Assets/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="/img/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="/css/style.css">
  <script src="/js/theme.js"></script>
  <script src="/js/pwa.js" defer></script>
  <script src="/js/site-nav.js" defer></script>
  <script src="/js/version.js" defer></script>
  <script type="application/ld+json">${jsonLd(structured)}</script>
</head>
<body>
${HEADER}

  <main class="guide">
    <p class="breadcrumb"><a href="/codes">Trouble code search</a> › ${esc(code)}</p>
    <h1>${esc(code)}: ${esc(entry.title)}</h1>
    <p class="lede">${esc(entry.plain)}</p>

    <section>
      <h2>How urgent is it?</h2>
      <p><span class="badge" data-level="${esc(entry.urgency)}">${esc(urgency.label)}</span> ${esc(urgency.says)}</p>
      <p><strong>DIY or shop:</strong> ${esc(DIFFICULTY[entry.difficulty])}</p>
      ${system ? `<p><strong>System:</strong> ${esc(system)}</p>` : ''}
    </section>

    <section>
      <h2>Common causes of ${esc(code)}</h2>
      <ul>
${entry.causes.map((c) => `        <li>${esc(c)}</li>`).join('\n')}
      </ul>
    </section>

    <section>
      <h2>What to tell your mechanic</h2>
      <p>“${esc(entry.tellMechanic)}”</p>
    </section>

    <section>
      <h2>Read the code from your own car</h2>
      <p>Plug a USB OBD-II adapter into your car and use the free <a href="/">WOBD scanner</a> in Chrome, Edge, or Opera to see which codes your car has stored. You can also <a href="/codes">look up another code</a>.</p>
    </section>
${related.length ? `
    <section>
      <h2>Related codes</h2>
      <ul>
${related.map((c) => `        <li><a href="/codes/${c.toLowerCase()}">${esc(c)}</a>: ${esc(titles[c])}</li>`).join('\n')}
      </ul>
    </section>
` : ''}  </main>

  <footer class="site-footer">
    <p>WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.</p>
    <p>WOBD is free. If it helped you out, you can <a href="https://buymeacoffee.com/jShumway00" target="_blank" rel="noopener noreferrer">buy me a coffee ☕</a></p>
  </footer>
</body>
</html>
`;
}

export function renderSitemap(codes) {
  const urls = [
    ...STATIC_PAGES.map((p) => `${ORIGIN}${p}`),
    ...codes.map((c) => `${ORIGIN}/codes/${c.toLowerCase()}`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;
}

export function renderCodeList(codes, titles) {
  return `<!-- code-list:start (generated by scripts/build-code-pages.mjs) -->
      <details class="curated-code-pages">
        <summary>Curated generic code pages</summary>
        <section class="code-list" aria-labelledby="code-list-title">
          <h2 id="code-list-title">Codes with dedicated detail pages</h2>
          <ul>
${codes.map((c) => `          <li><a href="/codes/${c.toLowerCase()}">${esc(c)}</a>: ${esc(titles[c])}</li>`).join('\n')}
          </ul>
        </section>
      </details>
      <!-- code-list:end -->`;
}

export function injectCodeList(html, block) {
  const startMarker = '<!-- code-list:start (generated by scripts/build-code-pages.mjs) -->';
  const endMarker = '<!-- code-list:end -->';
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1) throw new Error('codes.html is missing the code-list markers');
  return html.slice(0, start) + block + html.slice(end + endMarker.length);
}

async function main() {
  const data = JSON.parse(await readFile(join(root, 'data/codes.json'), 'utf8'));
  const codes = Object.keys(data).sort();
  const titles = Object.fromEntries(codes.map((c) => [c, data[c].title]));

  const dir = join(root, 'codes');
  await mkdir(dir, { recursive: true });
  const wanted = new Set(codes.map((c) => `${c.toLowerCase()}.html`));
  for (const file of await readdir(dir)) {
    if (file.endsWith('.html') && !wanted.has(file)) await unlink(join(dir, file));
  }
  for (const code of codes) {
    await writeFile(join(dir, `${code.toLowerCase()}.html`), renderCodePage(code, data[code], codes, titles));
  }

  await writeFile(join(root, 'sitemap.xml'), renderSitemap(codes));

  const codesPath = join(root, 'codes.html');
  const html = await readFile(codesPath, 'utf8');
  await writeFile(codesPath, injectCodeList(html, renderCodeList(codes, titles)));
  console.log(`Wrote ${codes.length} code pages, sitemap.xml, and the codes.html list.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
