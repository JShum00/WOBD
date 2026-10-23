// Offline localization. English is built into the pages; other languages are static JSON
// bundles in data/i18n/ (flat key -> text, {name} placeholders, key_one/key_other plurals).
// A missing key or a bad bundle falls back to English, never to a blank. Raw codes, recorded
// values and user notes are never translated. No DOM is touched at import time, so
// scripts/test-i18n.mjs can check this file in Node.

export const STORAGE_KEY = 'wobd.lang';
export const DISMISS_KEY = 'wobd.lang.suggest';
export const MAX_BUNDLE_BYTES = 512 * 1024;

// `machine` marks translations drafted by software and not yet reviewed by a native speaker.
export const LANGUAGES = [
  { code: 'en', name: 'English', machine: false },
  { code: 'fr', name: 'Français', machine: true },
  { code: 'de', name: 'Deutsch', machine: true },
  { code: 'es', name: 'Español', machine: true },
  { code: 'ja', name: '日本語', machine: true },
  { code: 'zh-Hans', name: '简体中文', machine: true },
];

// Short, hard-coded prompts so a suggestion can be shown in the visitor's language with no download.
export const SUGGESTIONS = {
  fr: { text: 'WOBD est disponible en français.', yes: 'Passer en français', no: 'Non merci' },
  de: { text: 'WOBD ist auf Deutsch verfügbar.', yes: 'Auf Deutsch wechseln', no: 'Nein danke' },
  es: { text: 'WOBD está disponible en español.', yes: 'Cambiar a español', no: 'No, gracias' },
  ja: { text: 'WOBD は日本語で利用できます。', yes: '日本語に切り替える', no: '今はしない' },
  'zh-Hans': { text: 'WOBD 提供简体中文版本。', yes: '切换到简体中文', no: '不用了' },
};

const CODES = new Set(LANGUAGES.map((l) => l.code));

let current = 'en';
let bundle = {};
let english = {};
let rules = new Intl.PluralRules('en');
const warned = new Set();

// In Node (the test scripts) there is no page to load English, so read it from disk.
if (globalThis.process?.versions?.node && !globalThis.document) {
  try {
    const { readFileSync } = await import('node:fs');
    english = JSON.parse(readFileSync(new URL('../data/i18n/en.json', import.meta.url), 'utf8'));
  } catch { english = {}; }
}
const listeners = new Set();

export const getLanguage = () => current;
export const isMachineTranslated = (code = current) => LANGUAGES.find((l) => l.code === code)?.machine ?? false;
export const onLanguageChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Maps a browser language tag ("fr-CA", "zh-CN", "zh-TW") to a supported code, or null.
// Traditional Chinese is not offered, so zh-TW/zh-HK/zh-Hant return null rather than a wrong script.
export function matchLanguage(tag) {
  const lower = String(tag ?? '').toLowerCase();
  if (!lower) return null;
  if (lower.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(lower) ? null : 'zh-Hans';
  const base = lower.split('-')[0];
  return CODES.has(base) ? base : null;
}

export function suggestLanguage(languages = []) {
  for (const tag of languages) {
    const code = matchLanguage(tag);
    if (code) return code === 'en' ? null : code;
  }
  return null;
}

// A bundle is a plain object of strings. Anything else is rejected whole.
export function validateBundle(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const entries = Object.entries(data);
  return entries.length > 0 && entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string');
}

// Replaces {name} with params.name. Unknown placeholders are left visible so a bug shows up.
export function format(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

function pluralKey(table, key, count) {
  const form = rules.select(count);
  for (const candidate of [`${key}_${form}`, `${key}_other`]) if (candidate in table) return candidate;
  return key in table ? key : null;
}

// Looks a key up in the chosen language, then English, then returns the key itself.
export function t(key, params) {
  const count = params && typeof params.count === 'number' ? params.count : null;
  for (const table of [bundle, english]) {
    const hit = count === null ? (key in table ? key : null) : pluralKey(table, key, count);
    if (hit) return format(table[hit], params);
  }
  if (!warned.has(key)) { warned.add(key); console.warn(`[WOBD] Missing translation key: ${key}`); }
  return key;
}

// A reading's name in the chosen language. The recorded name in the CSV stays English.
export const pidLabel = (def) => (has(`pid.${def.key}`) ? t(`pid.${def.key}`) : def.label);

export const has = (key) => key in bundle || key in english;

// Numbers and dates follow the language; the recorded value itself never changes.
export const formatNumber = (value, options) => new Intl.NumberFormat(current, options).format(value);
export const formatDate = (ms, options) => new Intl.DateTimeFormat(current, options).format(new Date(ms));
export const formatTime = (ms, options = { hour: 'numeric', minute: '2-digit', second: '2-digit' }) => formatDate(ms, options);

// ---------- Loading ----------

async function fetchBundle(code, fetcher) {
  const res = await fetcher(`data/i18n/${code}.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BUNDLE_BYTES) throw new Error('bundle too large');
  const data = JSON.parse(text);
  if (!validateBundle(data)) throw new Error('bundle is not a flat object of strings');
  return data;
}

export function setBundles({ code = 'en', main = {}, base = {} }) {
  current = code;
  bundle = main;
  english = base;
  rules = new Intl.PluralRules(code);
}

export function savedLanguage(storage) {
  try {
    const code = storage?.getItem(STORAGE_KEY);
    return CODES.has(code) ? code : null;
  } catch { return null; }
}

// Loads English plus the wanted language. Returns { code, fellBack } and never throws:
// if the chosen bundle is missing or corrupt, the page stays in English.
export async function loadLanguage(code, { fetcher = fetch } = {}) {
  let base = english;
  if (!Object.keys(base).length) {
    try { base = await fetchBundle('en', fetcher); } catch (err) { console.error('[WOBD] English bundle failed:', err); base = {}; }
  }
  if (code === 'en' || !CODES.has(code)) {
    setBundles({ code: 'en', main: {}, base });
    return { code: 'en', fellBack: code !== 'en' };
  }
  try {
    setBundles({ code, main: await fetchBundle(code, fetcher), base });
    return { code, fellBack: false };
  } catch (err) {
    console.error(`[WOBD] Language ${code} failed, using English:`, err);
    setBundles({ code: 'en', main: {}, base });
    return { code: 'en', fellBack: true };
  }
}

// ---------- DOM ----------

const RICH_TAGS = new Set(['STRONG', 'EM', 'B', 'CODE', 'BR', 'A']);

// Builds text with a few safe tags. Everything else, and any attribute but a safe href, is dropped.
export function richNodes(text, doc = document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = text;
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1 || !RICH_TAGS.has(child.tagName)) { child.replaceWith(doc.createTextNode(child.textContent ?? '')); continue; }
      for (const attr of [...child.attributes]) {
        const safeHref = child.tagName === 'A' && attr.name === 'href' && /^(?:[\w./#?=&-]+|https:\/\/[^\s"<>]+)$/.test(attr.value) && !/^\s*(?:javascript|data):/i.test(attr.value);
        if (!safeHref) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A' && /^https:/.test(child.getAttribute('href') ?? '')) {
        child.setAttribute('rel', 'noopener noreferrer');
        child.setAttribute('target', '_blank');
      }
      clean(child);
    }
  };
  clean(tpl.content);
  return [...tpl.content.childNodes];
}

// data-i18n="key" sets the text, data-i18n-rich="key" allows safe inline tags,
// data-i18n-attr="placeholder:key;aria-label:other" sets attributes. English stays in the HTML.
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-rich]')) el.replaceChildren(...richNodes(t(el.dataset.i18nRich), el.ownerDocument));
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  const doc = root.ownerDocument ?? root;
  doc.documentElement.lang = current;
}

function buildSelector(doc) {
  const select = doc.createElement('select');
  select.id = 'lang-select';
  select.className = 'lang-select';
  for (const lang of LANGUAGES) {
    const option = doc.createElement('option');
    option.value = lang.code;
    option.textContent = lang.machine ? `${lang.name} · AI` : lang.name;
    select.append(option);
  }
  select.value = current;
  return select;
}

function updateNotice(doc) {
  let notice = doc.getElementById('lang-notice');
  if (!isMachineTranslated()) { notice?.remove(); return; }
  if (!notice) {
    notice = doc.createElement('p');
    notice.id = 'lang-notice';
    notice.className = 'lang-notice';
    const footer = doc.querySelector('.site-footer');
    (footer ?? doc.body).prepend(notice);
  }
  notice.textContent = t('lang.machine');
}

export async function changeLanguage(code, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const result = await loadLanguage(code);
  try { storage?.setItem(STORAGE_KEY, result.code); } catch { /* private mode: the choice just isn't remembered */ }
  if (doc) {
    applyTranslations(doc);
    updateNotice(doc);
    const select = doc.getElementById('lang-select');
    if (select) { select.value = result.code; select.setAttribute('aria-label', t('lang.label')); }
  }
  for (const fn of listeners) fn(result.code);
  return result;
}

function suggest(doc, code, onAnswer) {
  const text = SUGGESTIONS[code];
  const bar = doc.createElement('div');
  bar.id = 'lang-suggest';
  bar.className = 'lang-suggest';
  bar.setAttribute('role', 'note');
  bar.lang = code;
  const p = doc.createElement('p');
  p.textContent = text.text;
  const yes = doc.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn-primary';
  yes.textContent = text.yes;
  const no = doc.createElement('button');
  no.type = 'button';
  no.className = 'btn';
  no.textContent = text.no;
  yes.addEventListener('click', () => { bar.remove(); onAnswer(code); });
  no.addEventListener('click', () => { bar.remove(); onAnswer(null); });
  bar.append(p, yes, no);
  doc.body.prepend(bar);
}

// Starts localization on a page. Resolves once the language is loaded and applied.
export async function initI18n({ storage = globalThis.localStorage, doc = globalThis.document, languages = globalThis.navigator?.languages ?? [] } = {}) {
  const saved = savedLanguage(storage);
  await loadLanguage(saved ?? 'en');
  if (!doc) return current;
  const header = doc.querySelector('.header-right');
  if (header && !doc.getElementById('lang-select')) {
    const select = buildSelector(doc);
    header.insertBefore(select, doc.getElementById('theme-btn') ?? header.firstChild);
    select.addEventListener('change', () => changeLanguage(select.value, { storage, doc }));
  }
  applyTranslations(doc);
  updateNotice(doc);
  doc.getElementById('lang-select')?.setAttribute('aria-label', t('lang.label'));
  let dismissed = false;
  try { dismissed = storage?.getItem(DISMISS_KEY) === '1'; } catch { dismissed = false; }
  const suggestion = !saved && !dismissed ? suggestLanguage(languages) : null;
  if (suggestion) {
    suggest(doc, suggestion, (answer) => {
      try { storage?.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
      if (answer) changeLanguage(answer, { storage, doc });
    });
  }
  return current;
}
