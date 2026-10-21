import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const expectedLinks = [
  ['./', 'scanner', 'Scanner'],
  ['codes.html', 'codes', 'Code Search'],
  ['replay.html', 'replay', 'Replay'],
  ['./#demos', 'demos', 'Demos'],
  ['guide.html', 'guide', 'How to Use'],
  ['tested-adapters.html', 'adapters', 'Tested Adapters'],
];
const pages = [
  'index.html',
  'codes.html',
  'replay.html',
  'guide.html',
  'tested-adapters.html',
  'report.html',
  'simulator.html',
  'contact.html',
];

for (const page of pages) {
  const html = await readFile(new URL(page, root), 'utf8');
  const nav = html.match(/<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav, `${page} has the shared navigation`);
  const links = [...nav.matchAll(/<a class="header-link" href="([^"]+)" data-nav="([^"]+)">([^<]+)<\/a>/g)]
    .map(([, href, key, label]) => [href, key, label]);
  assert.deepEqual(links, expectedLinks, `${page} has the canonical destinations in order`);
  assert.match(html, /js\/site-nav\.js/, `${page} loads active-page behavior`);
}

const scenarios = [
  ['/', '', 'scanner'],
  ['/', '#demos', 'demos'],
  ['/index.html', '', 'scanner'],
  ['/codes.html', '', 'codes'],
  ['/replay.html', '', 'replay'],
  ['/guide.html', '', 'guide'],
  ['/tested-adapters.html', '', 'adapters'],
  ['/report.html', '?id=sample', 'adapters'],
  ['/simulator.html', '', 'demos'],
  ['/contact.html', '', null],
];

for (const [index, [pathname, hash, expected]] of scenarios.entries()) {
  const links = expectedLinks.map(([, key]) => ({
    dataset: { nav: key },
    current: null,
    removeAttribute(name) {
      if (name === 'aria-current') this.current = null;
    },
    setAttribute(name, value) {
      if (name === 'aria-current') this.current = value;
    },
  }));
  globalThis.location = { pathname, hash };
  globalThis.document = { querySelectorAll: () => links };
  let onHashChange;
  globalThis.window = {
    addEventListener(event, callback) {
      if (event === 'hashchange') onHashChange = callback;
    },
  };

  await import(`../js/site-nav.js?scenario=${index}`);
  const current = links.filter((link) => link.current === 'page');
  assert.deepEqual(current.map((link) => link.dataset.nav), expected ? [expected] : [], `${pathname}${hash} active state`);

  if (pathname === '/' && hash === '') {
    location.hash = '#demos';
    onHashChange();
    assert.equal(links.find((link) => link.dataset.nav === 'demos').current, 'page', 'hash navigation activates Demos');
    location.hash = '';
    onHashChange();
    assert.equal(links.find((link) => link.dataset.nav === 'scanner').current, 'page', 'back navigation restores Scanner');
  }
}

const home = await readFile(fileURLToPath(new URL('index.html', root)), 'utf8');
assert.equal([...home.matchAll(/data-demo="[^"]+"/g)].length, 6, 'all six app demo actions remain available');
assert.match(home, /id="demos"/, 'the demos destination exists on Scanner');
const demoSection = home.match(/<ul class="demo-list">([\s\S]*?)<\/ul>/)?.[1];
const demoTargets = [...(demoSection ?? '').matchAll(/<a href="([^"]+)"/g)].map(([, href]) => href);
assert.deepEqual(demoTargets, ['?demo', '?demo=pending', '?demo=twomodules', '?demo=iso', '?demo=clear', 'simulator.html', '?demo=drive']);

console.log('Navigation and demo destination checks passed.');
