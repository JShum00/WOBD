// Tests for localization. Run: node scripts/test-i18n.mjs [--require-all]
// Checks the engine, then every bundle against English: same keys, same {placeholders},
// plural forms, safe inline tags, and that the pages and scripts only use keys that exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  LANGUAGES, format, has, loadLanguage, matchLanguage, savedLanguage, setBundles, suggestLanguage, t, validateBundle,
} from '../js/i18n.js';

const requireAll = process.argv.includes('--require-all');
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const atest = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

test('matchLanguage maps browser tags and refuses Traditional Chinese', () => {
  assert.equal(matchLanguage('fr-CA'), 'fr');
  assert.equal(matchLanguage('de'), 'de');
  assert.equal(matchLanguage('zh-CN'), 'zh-Hans');
  assert.equal(matchLanguage('zh-Hans-SG'), 'zh-Hans');
  assert.equal(matchLanguage('zh-TW'), null);
  assert.equal(matchLanguage('zh-Hant'), null);
  assert.equal(matchLanguage('pt-BR'), null);
  assert.equal(matchLanguage(''), null);
});

test('suggestLanguage takes the first supported non-English preference', () => {
  assert.equal(suggestLanguage(['en-US', 'fr']), null);
  assert.equal(suggestLanguage(['pt', 'ja-JP', 'en']), 'ja');
  assert.equal(suggestLanguage([]), null);
});

test('format fills placeholders and leaves unknown ones visible', () => {
  assert.equal(format('Hi {name}, {n} codes', { name: 'Bob', n: 2 }), 'Hi Bob, 2 codes');
  assert.equal(format('Hi {who}', { name: 'x' }), 'Hi {who}');
  assert.equal(format('plain'), 'plain');
});

test('t falls back to English, then to the key, and picks plural forms', () => {
  setBundles({ code: 'fr', main: { a: 'A fr', 'n_one': '{count} code', 'n_other': '{count} codes' }, base: { a: 'A', b: 'B', 'n_one': '{count} code', 'n_other': '{count} codes' } });
  assert.equal(t('a'), 'A fr');
  assert.equal(t('b'), 'B');
  assert.equal(t('missing.key'), 'missing.key');
  assert.equal(t('n', { count: 1 }), '1 code');
  assert.equal(t('n', { count: 3 }), '3 codes');
  assert.ok(has('b') && !has('zzz'));
});

test('plural rules use the chosen language (Japanese has one form)', () => {
  setBundles({ code: 'ja', main: { n_other: '{count}件' }, base: { n_one: '{count} code', n_other: '{count} codes' } });
  assert.equal(t('n', { count: 1 }), '1件');
});

test('validateBundle rejects anything but a flat object of strings', () => {
  assert.ok(validateBundle({ a: 'x' }));
  for (const bad of [null, [], {}, { a: 1 }, { a: { b: 'x' } }, 'str']) assert.ok(!validateBundle(bad));
});

test('savedLanguage only returns supported codes and survives blocked storage', () => {
  assert.equal(savedLanguage({ getItem: () => 'de' }), 'de');
  assert.equal(savedLanguage({ getItem: () => 'xx' }), null);
  assert.equal(savedLanguage({ getItem: () => { throw new Error('blocked'); } }), null);
});

await atest('a corrupt or missing bundle falls back to English', async () => {
  const en = { hi: 'Hello' };
  const files = { 'data/i18n/en.json': JSON.stringify(en), 'data/i18n/de.json': '{not json', 'data/i18n/fr.json': '[1,2]', 'data/i18n/es.json': JSON.stringify({ hi: 'Hola' }) };
  const fetcher = async (url) => (url in files ? { ok: true, text: async () => files[url] } : { ok: false, status: 404 });
  setBundles({ code: 'en', main: {}, base: {} });
  let r = await loadLanguage('de', { fetcher });
  assert.deepEqual(r, { code: 'en', fellBack: true });
  assert.equal(t('hi'), 'Hello');
  r = await loadLanguage('fr', { fetcher });
  assert.equal(r.code, 'en');
  r = await loadLanguage('ja', { fetcher });
  assert.equal(r.code, 'en');
  r = await loadLanguage('es', { fetcher });
  assert.deepEqual(r, { code: 'es', fellBack: false });
  assert.equal(t('hi'), 'Hola');
});

// ---------- Bundles and sources ----------

const en = JSON.parse(read('data/i18n/en.json'));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;
const baseOf = (key) => key.match(PLURAL)?.[1] ?? key;
const allowedTags = /^(?:[^<]|<\/?(?:strong|em|b|code|br)\s*\/?>|<a href="(?:[\w./#?=&-]+|https:\/\/[^\s"<>]+)">|<\/a>)*$/;

test('English bundle is a valid flat object', () => {
  assert.ok(validateBundle(en));
  for (const [k, v] of Object.entries(en)) assert.ok(allowedTags.test(v), `${k} has tags outside the allowed set`);
});

const plainKeys = (data) => new Set(Object.keys(data).map(baseOf));
for (const lang of LANGUAGES.filter((l) => l.code !== 'en')) {
  const file = `data/i18n/${lang.code}.json`;
  if (!existsSync(new URL(file, root))) {
    if (requireAll) assert.fail(`${file} is missing`);
    console.log(`skip - ${lang.code} has no bundle yet`);
    continue;
  }
  test(`${lang.code}: same keys and placeholders as English`, () => {
    const data = JSON.parse(read(file));
    assert.ok(validateBundle(data));
    const have = plainKeys(data);
    const missing = [...plainKeys(en)].filter((k) => !have.has(k));
    assert.deepEqual(missing, [], `missing in ${lang.code}: ${missing.slice(0, 10).join(', ')}`);
    const extra = [...have].filter((k) => !plainKeys(en).has(k));
    assert.deepEqual(extra, [], `unknown in ${lang.code}: ${extra.slice(0, 10).join(', ')}`);
    for (const [key, value] of Object.entries(data)) {
      assert.ok(allowedTags.test(value), `${lang.code} ${key}: tags outside the allowed set`);
      const reference = en[key] ?? en[`${baseOf(key)}_other`] ?? en[baseOf(key)];
      assert.ok(reference !== undefined, `${lang.code} ${key}: no English source`);
      const want = new Set(placeholders(reference).split(',').filter(Boolean));
      const got = placeholders(value).split(',').filter(Boolean);
      for (const p of got) assert.ok(want.has(p), `${lang.code} ${key}: unexpected {${p}}`);
      if (!PLURAL.test(key)) assert.equal(placeholders(value), placeholders(reference), `${lang.code} ${key}: placeholders differ`);
    }
    for (const key of Object.keys(en).filter((k) => k.endsWith('_other'))) assert.ok(key in data, `${lang.code} needs ${key}`);
  });
}

test('pages only use keys that exist, and the English in the page matches', () => {
  const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
  const used = new Set();
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/data-i18n="([\w.-]+)"[^>]*>([^<]*)</g)) {
      used.add(m[1]);
      assert.ok(m[1] in en, `${page}: unknown key ${m[1]}`);
      assert.equal(m[2].trim(), en[m[1]], `${page}: ${m[1]} English text differs from en.json`);
    }
    for (const m of html.matchAll(/data-i18n-rich="([\w.-]+)"/g)) { used.add(m[1]); assert.ok(m[1] in en, `${page}: unknown key ${m[1]}`); }
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) { const key = pair.split(':')[1]?.trim(); used.add(key); assert.ok(key in en, `${page}: unknown key ${key}`); }
    }
  }
  assert.ok(used.size > 5);
});

test('scripts only call t() with keys that exist', () => {
  const missing = [];
  for (const file of readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js'))) {
    const src = read(`js/${file}`);
    for (const m of src.matchAll(/(?<![\w.$])t\(\s*'([\w.-]+)'/g)) {
      const key = m[1];
      if (!(key in en) && !(`${key}_other` in en)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

console.log(`${passed} passed`);
