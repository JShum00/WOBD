// Bob: looks up codes in the local code book and talks through a speech bubble.
// Everything he says is scripted, so he works offline and never makes things up.
import { h } from './dom.js';
import { getLanguage, isMachineTranslated, t } from './i18n.js';
import { isDtcCode, isManufacturerCode, manufacturerMakeKey } from './dtc.js';

export const URGENCY = {
  low: { get label() { return t('bob.urgency.low'); }, get says() { return t('bob.urgency.lowSays'); } },
  medium: { get label() { return t('bob.urgency.medium'); }, get says() { return t('bob.urgency.mediumSays'); } },
  high: { get label() { return t('bob.urgency.high'); }, get says() { return t('bob.urgency.highSays'); } },
  unknown: { get label() { return t('bob.urgency.unknown'); }, get says() { return t('bob.urgency.unknownSays'); } },
};

export const DIFFICULTY = {
  get diy() { return t('bob.difficulty.diy'); },
  get moderate() { return t('bob.difficulty.moderate'); },
  get shop() { return t('bob.difficulty.shop'); },
};

const MOODS = { check: '✓', warning: '!', question: '?' };

const SYSTEMS = {
  P: () => t('bob.system.powertrain'),
  C: () => t('bob.system.chassis'),
  B: () => t('bob.system.body'),
  U: () => t('bob.system.network'),
};

// Generic P0 groups, keyed by the third character.
const P0_GROUPS = {
  0: () => t('bob.p0Group.0'), 1: () => t('bob.p0Group.1'),
  2: () => t('bob.p0Group.2'), 3: () => t('bob.p0Group.3'),
  4: () => t('bob.p0Group.4'), 5: () => t('bob.p0Group.5'),
  6: () => t('bob.p0Group.6'), 7: () => t('bob.p0Group.7'),
  8: () => t('bob.p0Group.8'), 9: () => t('bob.p0Group.9'),
  A: () => t('bob.p0Group.A'),
};

let codeBook = {};
let englishCodeBook = {};
let translatedCodes = new Set();
let activeCodeBookLanguage = 'en';
let generic = {};  // definitions from data/generic/, filled in by loadGenericCodes()
const genericLoads = new Map();
const genericFamilyLoads = new Map();
const GENERIC_FAMILIES = new Set(['P0', 'P2', 'P3', 'U0', 'U3', 'B0', 'C0']);
const manufacturerCodes = new Map();
const manufacturerLoads = new Map();
let manufacturerIndexLoad = null;

export async function loadCodeBook(url = 'data/codes.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load Bob's code book (${res.status}).`);
  const english = await res.json();
  if (!english || typeof english !== 'object' || Array.isArray(english)) throw new Error('Bob’s code book is invalid.');
  englishCodeBook = english;
  codeBook = { ...englishCodeBook };
  translatedCodes = new Set();
  activeCodeBookLanguage = 'en';
  await reloadCodeBook();
  return codeBook;
}

export async function reloadCodeBook() {
  if (!Object.keys(englishCodeBook).length) return;
  codeBook = { ...englishCodeBook };
  translatedCodes = new Set();
  activeCodeBookLanguage = 'en';
  const language = getLanguage();
  if (language === 'en') return;
  try {
    const res = await fetch(`data/i18n/codes.${language}.json`);
    if (!res.ok || language !== getLanguage()) return;
    const data = await res.json();
    if (language !== getLanguage()) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const merged = new Set();
    for (const [code, overlay] of Object.entries(data)) {
      if (!codeBook[code] || !validCodeOverlay(overlay)) continue;
      const { title, plain, causes, tellMechanic } = overlay;
      codeBook[code] = { ...codeBook[code], title, plain, causes, tellMechanic };
      merged.add(code);
    }
    translatedCodes = merged;
    if (merged.size) activeCodeBookLanguage = language;
  } catch {
    translatedCodes = new Set();
  }
}

function validCodeOverlay(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && ['title', 'plain', 'tellMechanic'].every((key) => typeof entry[key] === 'string')
    && Array.isArray(entry.causes) && entry.causes.every((cause) => typeof cause === 'string');
}

export const codeBookLanguage = () => activeCodeBookLanguage;
export const isTranslatedEntry = (entry) => translatedCodes.has(entry?.code) && isMachineTranslated(getLanguage());

export async function loadGenericFamily(family) {
  if (!GENERIC_FAMILIES.has(family)) throw new Error(`Unsupported generic code family: ${family}`);
  if (!genericFamilyLoads.has(family)) {
    genericFamilyLoads.set(family, fetch(`data/generic/${family}.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || !Object.entries(data).every(([code, entry]) => code.startsWith(family)
            && entry && typeof entry === 'object' && typeof entry.title === 'string')) {
          throw new Error('Invalid generic-code data.');
        }
        Object.assign(generic, data);
        return data;
      })
      .catch((err) => {
        genericFamilyLoads.delete(family);
        throw new Error(`Couldn't load ${family} generic codes (${err.message}).`);
      }));
  }
  return genericFamilyLoads.get(family);
}

// Loads the generic definitions for the code families these codes belong to (P0, U3, ...).
// A failed download just leaves Bob with his own notes.
export async function loadGenericCodes(codes) {
  const families = new Set(codes.map((code) => code.slice(0, 2)).filter((f) => GENERIC_FAMILIES.has(f)));
  await Promise.all([...families].map((family) => {
    if (!genericLoads.has(family)) {
      genericLoads.set(family, loadGenericFamily(family).catch(() => {}));
    }
    return genericLoads.get(family);
  }));
}

export async function loadManufacturerIndex() {
  if (!manufacturerIndexLoad) {
    manufacturerIndexLoad = fetch('data/manufacturer/index.json')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const makes = await res.json();
        if (!Array.isArray(makes) || !makes.every((item) => typeof item === 'string')) {
          throw new Error('Invalid manufacturer-code index.');
        }
        return makes;
      })
      .catch((err) => {
        manufacturerIndexLoad = null;
        throw new Error(`Couldn't load the manufacturer-code index (${err.message}).`);
      });
  }
  return manufacturerIndexLoad;
}

export async function loadManufacturerCodes(make) {
  const key = manufacturerMakeKey(make);
  if (!key) return {};
  const makes = await loadManufacturerIndex();
  if (!makes.includes(key)) return {};

  if (!manufacturerLoads.has(key)) {
    manufacturerLoads.set(key, fetch(`data/manufacturer/${key}.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || !Object.entries(data).every(([code, description]) => isDtcCode(code)
            && isManufacturerCode(code) && typeof description === 'string' && description.trim())) {
          throw new Error('Invalid manufacturer-code data.');
        }
        manufacturerCodes.set(key, data);
      })
      .catch((err) => {
        manufacturerLoads.delete(key);
        throw new Error(`Couldn't load ${make}'s manufacturer-specific codes (${err.message}).`);
      }));
  }
  await manufacturerLoads.get(key);
  return manufacturerCodes.get(key);
}

export function describeCategory(code) {
  const [letter, d1, d2] = code;
  if (letter === 'P' && d1 === '0' && P0_GROUPS[d2]) return t('bob.category.p0', { digit: d2, group: P0_GROUPS[d2]() });
  return t('bob.category.system', { letter, system: SYSTEMS[letter]() });
}

// Always returns something Bob can say, even for codes he has no notes on.
export function lookup(code, make = '') {
  const entry = codeBook[code];
  if (entry) {
    const translated = isTranslatedEntry({ code });
    return { code, known: true, ...entry, translated, lang: translated ? activeCodeBookLanguage : 'en' };
  }

  const key = manufacturerMakeKey(make);
  const manufacturerDescription = isManufacturerCode(code) ? manufacturerCodes.get(key)?.[code] : null;
  if (manufacturerDescription) {
    return {
      code,
      known: false,
      brandSpecific: true,
      make,
      title: t('bob.title.manufacturer'),
      lang: 'en',
      plain: manufacturerDescription,
      urgency: 'unknown',
      causes: [],
      difficulty: null,
      tellMechanic: `${code} is listed for ${make}: ${manufacturerDescription}. Confirm it with vehicle-specific service information.`,
    };
  }

  const general = generic[code];
  if (general) {
    return {
      code,
      known: false,
      generic: true,
      lang: 'en',
      plain: general.title,
      urgency: 'unknown',
      causes: [],
      difficulty: null,
      tellMechanic: `I have a ${code}, ${general.title}. Can you diagnose it?`,
      ...general,
      lang: 'en',
    };
  }

  const manufacturer = isManufacturerCode(code);
  return {
    code,
    known: false,
    manufacturer,
    title: manufacturer ? t('bob.title.manufacturer') : t('bob.title.genericUnknown'),
    lang: getLanguage(),
    plain: manufacturer
      ? t('bob.lookup.manufacturer', {})
      : t('bob.lookup.unknown', { category: describeCategory(code) }),
    urgency: 'unknown',
    causes: [],
    difficulty: null,
    tellMechanic: t('bob.lookup.tellMechanic', { code }),
  };
}

export function searchUrl(code, car = {}) {
  const query = [code, car.year, car.make, car.model].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function urgencyBadge(level) {
  const info = URGENCY[level] ?? URGENCY.unknown;
  return h('span', { class: 'badge', dataset: { level: URGENCY[level] ? level : 'unknown' } }, info.label);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Bob {
  // slot: where the bubble goes. live: an aria-live region for screen readers.
  // voice: optional read-aloud (voice.js).
  constructor({ slot, live, getCar, voice = null }) {
    this.slot = slot;
    this.live = live;
    this.getCar = getCar;
    this.voice = voice;
    this.script = '';  // what the current bubble says, as one plain string
    this.bubble = null;
    this.typing = null;
    this.token = 0;
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
  }

  get reducedMotion() { return this.motion.matches; }
  get isOpen() { return Boolean(this.bubble); }

  // tone: low | medium | high | unknown | (default navy). mood: check | warning | question.
  // script: the bubble as plain sentences for screen readers and the voice;
  // defaults to the heading plus text.
  async say({ tone = 'default', mood = null, heading = null, text = '', details = [], script = null }) {
    const token = ++this.token;
    await this.#dismissCurrent();
    if (token !== this.token) return;  // a newer message won the race

    const typed = h('span', { 'aria-hidden': 'true' });
    const bubble = h('div', { class: 'bubble pop-in', dataset: { tone }, onClick: () => this.#finishTyping() },
      mood && h('span', { class: 'bubble-mood', 'aria-hidden': 'true' }, MOODS[mood]),
      heading,
      text && h('p', {}, typed),
      details,
    );
    // Drop the class once it has played so re-showing the page (after
    // printing, for example) doesn't replay it.
    if (this.reducedMotion) bubble.classList.remove('pop-in');
    else bubble.addEventListener('animationend', () => bubble.classList.remove('pop-in'), { once: true });
    this.slot.replaceChildren(bubble);
    this.bubble = bubble;

    this.script = script ?? [heading?.textContent, text].filter(Boolean).join('. ');
    this.live.textContent = this.script;
    this.voice?.speak(this.script);
    this.#type(typed, text);
  }

  // Reads the current bubble again, e.g. right after the voice is turned on.
  repeat() {
    if (this.bubble) this.voice?.speak(this.script);
  }

  explain(entry) {
    const urgency = URGENCY[entry.urgency] ?? URGENCY.unknown;
    const badge = urgencyBadge(entry.urgency);
    if (entry.urgency === 'high' && !this.reducedMotion) badge.classList.add('pulse');

    const details = [
      h('p', { class: 'urgency-line' }, badge, h('span', {}, urgency.says)),
      entry.causes.length > 0 && h('h4', {}, t('bob.commonCauses')),
      entry.causes.length > 0 && h('ul', {}, entry.causes.map((cause) => h('li', {}, cause))),
      entry.difficulty && h('p', {}, h('strong', {}, t('bob.diyOrShop')), DIFFICULTY[entry.difficulty]),
      h('h4', {}, t('bob.tellMechanic')),
      h('p', { class: 'tell' }, `“${entry.tellMechanic}”`),
      entry.generic && h('p', { class: 'hint' },
        t('bob.genericDisclaimer')),
      entry.brandSpecific && h('p', { class: 'hint' },
        t('bob.codes.manufacturerDisclaimer')),
      entry.brandSpecific && h('p', { class: 'hint' },
        h('a', { href: 'https://github.com/kierandrewett/obd/blob/main/LICENSE',
          target: '_blank', rel: 'noopener noreferrer' }, t('bob.codes.manufacturerSource'))),
      !entry.known && h('p', {},
        h('a', { href: searchUrl(entry.code, this.getCar()), target: '_blank', rel: 'noopener noreferrer',
          dataset: { searchCode: entry.code } },
          t('bob.searchGoogle'))),
    ].filter(Boolean);

    const script = [
      `${entry.code}: ${entry.title}.`,
      entry.plain,
      `${urgency.label} urgency. ${urgency.says}`,
      entry.causes.length > 0 && `${t('bob.commonCauses')}: ${entry.causes.join(', ')}.`,
      entry.difficulty && `${t('bob.diyOrShop')}${DIFFICULTY[entry.difficulty]}.`,
      `${t('bob.tellMechanic')}: ${entry.tellMechanic}`, 
    ].filter(Boolean).join(' ');

    const mood = entry.urgency === 'high' ? 'warning' : entry.known || entry.generic ? null : 'question';
    return this.say({
      tone: entry.known ? entry.urgency : 'unknown',
      mood,
      heading: h('h3', {}, h('span', { class: 'code' }, entry.code), ' · ', entry.title),
      text: entry.plain,
      details,
      script,
    });
  }

  async close() {
    this.token++;
    this.voice?.stop();
    await this.#dismissCurrent();
    this.script = '';
    this.live.textContent = '';
  }

  async #dismissCurrent() {
    this.#finishTyping();
    const old = this.bubble;
    if (!old) return;
    this.bubble = null;
    if (!this.reducedMotion) {
      old.classList.remove('pop-in');
      old.classList.add('fade-out');
      await wait(120);
    }
    old.remove();
  }

  // Types the plain-English line out quickly; clicking the bubble finishes it.
  #type(el, text) {
    if (!text || this.reducedMotion) {
      el.textContent = text;
      return;
    }
    let shown = 0;
    el.classList.add('typing');
    const step = () => {
      shown = Math.min(text.length, shown + 2);
      el.textContent = text.slice(0, shown);
      if (shown < text.length) this.typing.frame = requestAnimationFrame(step);
      else this.#finishTyping();
    };
    this.typing = { el, text, frame: requestAnimationFrame(step) };
  }

  #finishTyping() {
    if (!this.typing) return;
    const { el, text, frame } = this.typing;
    cancelAnimationFrame(frame);
    el.textContent = text;
    el.classList.remove('typing');
    this.typing = null;
  }
}
