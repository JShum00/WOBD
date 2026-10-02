// Offline trouble-code search: Bob answers a typed code from the bundled lists.
import { h } from './dom.js';
import { Bob, loadCodeBook, loadGenericCodes, lookup, isManufacturerCode, describeCategory, searchUrl } from './bob.js';
import { initCarForm, getCar } from './ui.js';

const $ = (id) => document.getElementById(id);

const CODE_FORMAT = /^[PCBU][0-3][0-9A-F]{3}$/;

const bob = new Bob({ slot: $('bob-slot'), live: $('bob-live'), getCar });

// "p-0601", " P0601 " -> "P0601"
function normalize(text) {
  return text.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const searchLink = (code) => h('p', {},
  h('a', { href: searchUrl(code, getCar()), target: '_blank', rel: 'noopener noreferrer', dataset: { searchCode: code } },
    'Search Google for this code'));

// Links already in Bob's bubble follow the car form as it changes.
function refreshSearchLinks() {
  for (const link of document.querySelectorAll('a[data-search-code]')) {
    link.href = searchUrl(link.dataset.searchCode, getCar());
  }
}

const heading = (code, title) => h('h3', {}, h('span', { class: 'code' }, code), ' · ', title);

function answer(input) {
  const code = normalize(input);

  if (!CODE_FORMAT.test(code)) {
    return bob.say({
      tone: 'unknown',
      mood: 'question',
      text: "That doesn't look like a trouble code. Codes are a letter (P, C, B, or U) followed by four characters, like P0601.",
    });
  }

  if (isManufacturerCode(code)) {
    return bob.say({
      tone: 'unknown',
      mood: 'question',
      heading: heading(code, 'Manufacturer-specific code'),
      text: `${code} is a manufacturer-specific code. Each car maker decides what it means, so the same number can mean different things on different brands. I won't give you a generic answer that could be wrong. Search with your car's year, make, and model to find the right one.`,
      details: [searchLink(code)],
    });
  }

  const entry = lookup(code);
  if (entry.known || entry.generic) return bob.explain(entry);

  return bob.say({
    tone: 'unknown',
    mood: 'question',
    heading: heading(code, 'Not in my list'),
    text: `${code} isn't in my offline list. ${describeCategory(code)}.`,
    details: [searchLink(code)],
  });
}

function start() {
  const input = $('code-input');
  const loaded = loadCodeBook();
  const ask = async (code) => {
    input.value = normalize(code);
    try {
      await loaded;
    } catch (err) {
      return bob.say({ tone: 'high', mood: 'warning', text: `I couldn't load my code list. ${err.message}` });
    }
    await loadGenericCodes([input.value]);
    return answer(input.value);
  };

  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  $('car-form').addEventListener('change', refreshSearchLinks);
  $('car-form').addEventListener('input', refreshSearchLinks);
  for (const chip of document.querySelectorAll('.code-chip')) {
    chip.addEventListener('click', () => ask(chip.dataset.code));
  }

  // The car form is optional, so a failed download just leaves it empty.
  Promise.all([
    fetch('data/makes.json').then((res) => res.json()),
    fetch('data/models.json').then((res) => res.json()).catch(() => ({})),
  ]).then(([makes, models]) => initCarForm(makes, models)).catch(() => {});

  const fromLink = new URLSearchParams(location.search).get('code');
  if (fromLink) ask(fromLink);
  else bob.say({ text: "Hi, I'm Bob! Type a trouble code like P0601 and I'll tell you what it means." });
}

start();
