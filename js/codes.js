import './i18n-boot.js';
// Offline trouble-code search: Bob answers a typed code from the bundled lists.
import { h } from './dom.js';
import { Bob, loadCodeBook, reloadCodeBook, loadGenericCodes, lookup, isManufacturerCode, describeCategory, searchUrl } from './bob.js';
import { onLanguageChange, t } from './i18n.js';
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
    t('bob.searchGoogle')));

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
      text: t('bob.codes.invalid'),
    });
  }

  if (isManufacturerCode(code)) {
    return bob.say({
      tone: 'unknown',
      mood: 'question',
      heading: heading(code, t('bob.title.manufacturer')),
      text: t('bob.codes.manufacturerDetails', { code }),
      details: [searchLink(code)],
    });
  }

  const entry = lookup(code);
  if (entry.known || entry.generic) return bob.explain(entry);

  return bob.say({
    tone: 'unknown',
    mood: 'question',
    heading: heading(code, t('bob.codes.notListed')),
    text: t('bob.codes.notListedDetails', { code, category: describeCategory(code) }),
    details: [searchLink(code)],
  });
}

function start() {
  const input = $('code-input');
  let currentAnswer = '';
  const loaded = loadCodeBook();
  const ask = async (code) => {
    input.value = normalize(code);
    currentAnswer = input.value;
    try {
      await loaded;
    } catch (err) {
      return bob.say({ tone: 'high', mood: 'warning', text: t('bob.codes.loadFailure', { error: err.message }) });
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
  onLanguageChange(async () => {
    await reloadCodeBook();
    if (currentAnswer) {
      await loadGenericCodes([currentAnswer]);
      answer(currentAnswer);
    } else {
      bob.say({ text: t('bob.codes.greeting') });
    }
  });
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
  else bob.say({ text: t('bob.codes.greeting') });
}

start();
