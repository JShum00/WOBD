// Bob: looks up codes in the local code book and talks through a speech bubble.
// Everything he says is scripted, so he works offline and never makes things up.
import { h } from './dom.js';

export const URGENCY = {
  low: { label: 'Low', says: "Safe to drive. Get it looked at when it's convenient." },
  medium: { label: 'Medium', says: 'Drive gently and get it checked soon.' },
  high: { label: 'High', says: "Pull over when it's safe. Driving on this could damage the engine." },
  unknown: { label: 'Unknown', says: "I can't rate this one. If the car drives differently, get it checked." },
};

export const DIFFICULTY = {
  diy: 'Easy DIY',
  moderate: "DIY if you're handy",
  shop: 'Shop job',
};

const MOODS = { check: '✓', warning: '!', question: '?' };

const SYSTEMS = {
  P: 'engine or transmission',
  C: 'chassis (brakes, steering, or suspension)',
  B: 'body (airbags, seats, or lights)',
  U: 'network (how the car’s computers talk to each other)',
};

// Generic P0 groups, keyed by the third character.
const P0_GROUPS = {
  0: 'a fuel, air, or cam timing problem',
  1: 'a fuel and air metering problem',
  2: 'a fuel injector or fuel system problem',
  3: 'an ignition or misfire problem',
  4: 'an emissions control problem',
  5: 'a speed, idle control, or electrical input problem',
  6: 'an engine computer or output circuit problem',
  7: 'a transmission problem',
  8: 'a transmission problem',
  9: 'a transmission problem',
  A: 'a hybrid system problem',
};

let codeBook = {};
let generic = {};  // definitions from data/generic/, filled in by loadGenericCodes()
const genericLoads = new Map();
const GENERIC_FAMILIES = new Set(['P0', 'P2', 'P3', 'U0', 'U3', 'B0', 'C0']);

export async function loadCodeBook(url = 'data/codes.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load Bob's code book (${res.status}).`);
  codeBook = await res.json();
}

// Loads the generic definitions for the code families these codes belong to (P0, U3, ...).
// A failed download just leaves Bob with his own notes.
export async function loadGenericCodes(codes) {
  const families = new Set(codes.map((code) => code.slice(0, 2)).filter((f) => GENERIC_FAMILIES.has(f)));
  await Promise.all([...families].map((family) => {
    if (!genericLoads.has(family)) {
      genericLoads.set(family, fetch(`data/generic/${family}.json`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data) => { Object.assign(generic, data); })
        .catch(() => { genericLoads.delete(family); }));
    }
    return genericLoads.get(family);
  }));
}

// P1xxx, P30-P33xx, and C/B/U 1xxx-2xxx are defined by each car brand.
export function isManufacturerCode(code) {
  const [letter, d1, d2] = code;
  if (letter === 'P') return d1 === '1' || (d1 === '3' && '0123'.includes(d2));
  return d1 === '1' || d1 === '2';
}

export function describeCategory(code) {
  const [letter, d1, d2] = code;
  if (letter === 'P' && d1 === '0' && P0_GROUPS[d2]) return `a P0${d2}xx code is ${P0_GROUPS[d2]}`;
  return `${letter} codes are about the ${SYSTEMS[letter]}`;
}

// Always returns something Bob can say, even for codes he has no notes on.
export function lookup(code) {
  const entry = codeBook[code];
  if (entry) return { code, known: true, ...entry };

  const general = generic[code];
  if (general) {
    return {
      code,
      known: false,
      generic: true,
      plain: general.title,
      urgency: 'unknown',
      causes: [],
      difficulty: null,
      tellMechanic: `I have a ${code}, ${general.title}. Can you diagnose it?`,
      ...general,
    };
  }

  const manufacturer = isManufacturerCode(code);
  return {
    code,
    known: false,
    manufacturer,
    title: manufacturer ? 'Manufacturer-specific code' : 'Generic code (no notes yet)',
    plain: manufacturer
      ? "Hmm, that one's specific to your car's brand, so it isn't in my book. A quick search with your car's details is the fastest way to find out what it means."
      : `I haven't written notes on this one yet, but ${describeCategory(code)}. Here's a search to get you started.`,
    urgency: 'unknown',
    causes: [],
    difficulty: null,
    tellMechanic: `I have a ${code}. Can you look up what it means for my car?`,
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
      entry.causes.length > 0 && h('h4', {}, 'Common causes'),
      entry.causes.length > 0 && h('ul', {}, entry.causes.map((cause) => h('li', {}, cause))),
      entry.difficulty && h('p', {}, h('strong', {}, 'DIY or shop: '), DIFFICULTY[entry.difficulty]),
      h('h4', {}, 'Tell your mechanic'),
      h('p', { class: 'tell' }, `“${entry.tellMechanic}”`),
      entry.generic && h('p', { class: 'hint' },
        "This is a general description from an open code database, not one of my own notes. Details can vary by car."),
      !entry.known && h('p', {},
        h('a', { href: searchUrl(entry.code, this.getCar()), target: '_blank', rel: 'noopener noreferrer',
          dataset: { searchCode: entry.code } },
          'Search Google for this code')),
    ].filter(Boolean);

    const script = [
      `${entry.code}: ${entry.title}.`,
      entry.plain,
      `${urgency.label} urgency. ${urgency.says}`,
      entry.causes.length > 0 && `Common causes: ${entry.causes.join(', ')}.`,
      entry.difficulty && `DIY or shop: ${DIFFICULTY[entry.difficulty]}.`,
      `Tell your mechanic: ${entry.tellMechanic}`,
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
