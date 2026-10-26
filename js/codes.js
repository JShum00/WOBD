import './i18n-boot.js';
import { h } from './dom.js';
import {
  describeCategory, loadCodeBook, loadGenericFamily, loadManufacturerCodes,
  loadManufacturerIndex, lookup, reloadCodeBook, searchUrl,
} from './bob.js';
import { isDtcCode, isManufacturerCode, manufacturerMakeKey } from './dtc.js';
import { formatNumber, onLanguageChange, richNodes, t } from './i18n.js';
import { getCar, initCarForm } from './ui.js';

const $ = (id) => document.getElementById(id);
const GENERIC_FAMILIES = ['P0', 'P2', 'P3', 'B0', 'C0', 'U0', 'U3'];
const DIRECTORY_PAGE_SIZE = 100;
const codeInput = $('code-input');
const directory = $('code-directory');
const directoryStatus = $('directory-status');
const dialog = $('code-dialog');
const dialogTitle = $('code-dialog-title');
const dialogContent = $('code-dialog-content');
const counter = $('code-counter');
let codeCounts = null;
let lastCode = '';
let lastMake = '';
let requestId = 0;

const normalize = (text) => text.toUpperCase().replace(/[^0-9A-Z]/g, '');

function directoryLink(code, description, make = '') {
  const query = new URLSearchParams({ code, ...(make ? { make } : {}) });
  return h('li', {},
    h('a', {
      href: `codes.html?${query}`,
      dataset: { code, make },
      class: 'directory-code-link',
    }, h('code', {}, code), ' ', description));
}

function renderDirectoryEntries(entries, make = '') {
  const items = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  const filter = h('input', {
    type: 'search',
    class: 'directory-filter-input',
    'aria-label': t('bob.codes.directoryFilter'),
    placeholder: t('bob.codes.directoryFilter'),
  });
  const list = h('ul', { class: 'directory-links' });
  const empty = h('p', { class: 'directory-empty', hidden: true }, t('bob.codes.directoryNoMatches'));
  const more = h('button', { type: 'button', class: 'directory-show-more', hidden: true });
  let visibleCount = DIRECTORY_PAGE_SIZE;

  const render = () => {
    const query = filter.value.trim().toLocaleLowerCase();
    const matches = items.filter(([code, entry]) => {
      const description = make ? entry : entry.title;
      return !query || `${code} ${description}`.toLocaleLowerCase().includes(query);
    });
    const visible = matches.slice(0, visibleCount);
    list.replaceChildren(...visible.map(([code, entry]) =>
      directoryLink(code, make ? entry : entry.title, make)));
    empty.hidden = matches.length > 0;
    more.hidden = matches.length <= visibleCount;
    more.textContent = t('bob.codes.directoryShowMore', {
      shown: visible.length,
      total: matches.length,
    });
  };

  filter.addEventListener('input', () => {
    visibleCount = DIRECTORY_PAGE_SIZE;
    render();
  });
  more.addEventListener('click', () => {
    visibleCount += DIRECTORY_PAGE_SIZE;
    render();
  });
  render();
  return h('div', { class: 'directory-browser' },
    h('label', { class: 'directory-filter' },
      h('span', {}, t('bob.codes.directoryFilter')),
      filter),
    list,
    empty,
    more);
}

function renderCounter() {
  if (!codeCounts) return;
  counter.replaceChildren(...richNodes(t('bob.codes.counter', {
    total: formatNumber(codeCounts.total),
    generic: formatNumber(codeCounts.generic),
    manufacturer: formatNumber(codeCounts.manufacturer),
  })));
  counter.hidden = false;
}

fetch('data/code-counts.json')
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then((counts) => {
    codeCounts = counts;
    renderCounter();
  })
  .catch(() => {});

function setDirectoryStatus(message = '', isError = false) {
  directoryStatus.textContent = message;
  directoryStatus.dataset.state = isError ? 'error' : '';
}

function loadGroup(details, load, label) {
  details.addEventListener('toggle', async () => {
    if (!details.open || details.dataset.loaded || details.dataset.loading) return;
    details.dataset.loading = 'true';
    details.setAttribute('aria-busy', 'true');
    let content = details.querySelector(':scope > .directory-group-content');
    if (!content) {
      content = h('div', { class: 'directory-group-content' });
      details.append(content);
    }
    content.replaceChildren(h('p', { class: 'directory-loading' }, t('bob.codes.directoryLoading')));
    try {
      const entries = await load();
      if (!details.isConnected) return;
      content.replaceChildren(renderDirectoryEntries(entries, details.dataset.makeLabel || ''));
      details.dataset.loaded = 'true';
      details.dataset.count = String(Object.keys(entries).length);
      const summary = details.querySelector(':scope > summary');
      summary.append(h('span', { class: 'directory-count', 'aria-label': t('bob.codes.directoryCount', { count: Object.keys(entries).length }) },
        ` (${Object.keys(entries).length})`));
    } catch (err) {
      if (!details.isConnected) return;
      content.replaceChildren(h('p', { class: 'directory-error', role: 'alert' },
        t('bob.codes.directoryLoadFailure', { group: label, error: err.message })));
      details.dataset.loading = '';
    } finally {
      details.removeAttribute('aria-busy');
      delete details.dataset.loading;
    }
  });
}

function buildDirectory() {
  const genericRoot = h('details', { class: 'directory-group directory-root' },
    h('summary', {}, t('bob.codes.genericDirectory')));
  for (const family of GENERIC_FAMILIES) {
    const group = h('details', { class: 'directory-group', dataset: { family } },
      h('summary', {}, family));
    loadGroup(group, () => loadGenericFamily(family), family);
    genericRoot.append(group);
  }

  const manufacturerRoot = h('details', { class: 'directory-group directory-root' },
    h('summary', {}, t('bob.codes.manufacturerDirectory')),
    h('p', { class: 'directory-help' }, t('bob.codes.manufacturerDirectoryHint')));
  manufacturerRoot.addEventListener('toggle', async () => {
    if (!manufacturerRoot.open || manufacturerRoot.dataset.loaded || manufacturerRoot.dataset.loading) return;
    manufacturerRoot.dataset.loading = 'true';
    manufacturerRoot.setAttribute('aria-busy', 'true');
    let content = manufacturerRoot.querySelector(':scope > .directory-manufacturers');
    if (!content) {
      content = h('div', { class: 'directory-manufacturers' });
      manufacturerRoot.append(content);
    }
    content.replaceChildren(h('p', { class: 'directory-loading' }, t('bob.codes.directoryLoading')));
    try {
      const [keys, response] = await Promise.all([
        loadManufacturerIndex(),
        fetch('data/makes.json').then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        }),
      ]);
      const labels = new Map(response.map((name) => [manufacturerMakeKey(name), name]));
      const groups = keys.map((key) => {
        const make = labels.get(key) ?? key.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
        const group = h('details', { class: 'directory-group', dataset: { makeLabel: make } },
          h('summary', {}, make));
        loadGroup(group, () => loadManufacturerCodes(make), make);
        return group;
      });
      content.replaceChildren(...groups);
      manufacturerRoot.dataset.loaded = 'true';
    } catch (err) {
      content.replaceChildren(h('p', { class: 'directory-error', role: 'alert' },
        t('bob.codes.directoryLoadFailure', { group: t('bob.codes.manufacturerDirectory'), error: err.message })));
    } finally {
      manufacturerRoot.removeAttribute('aria-busy');
      delete manufacturerRoot.dataset.loading;
    }
  });

  directory.replaceChildren(genericRoot, manufacturerRoot);
}

function sourceLink(label, url) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
}

function renderDetails(code, entry, make) {
  const isBrand = entry.brandSpecific;
  const title = isBrand
    ? `${entry.make} · ${t('bob.title.manufacturer')}`
    : entry.title || t('bob.codes.notListed');
  dialogTitle.textContent = `${code} · ${title}`;
  const searchContext = isBrand ? { make: entry.make } : getCar();

  const sections = [h('p', { class: 'code-dialog-description' }, entry.plain || entry.title || '')];
  if (entry.known && entry.urgency) {
    sections.push(h('p', { class: 'code-dialog-urgency' },
      h('span', { class: 'badge', dataset: { level: entry.urgency } }, t(`bob.urgency.${entry.urgency}`)),
      ' ', t(`bob.urgency.${entry.urgency}Says`)));
  }
  if (entry.causes?.length) {
    sections.push(h('h3', {}, t('bob.commonCauses')),
      h('ul', {}, entry.causes.map((cause) => h('li', {}, cause))));
  }
  if (entry.difficulty) {
    sections.push(h('p', {}, h('strong', {}, t('bob.diyOrShop')), t(`bob.difficulty.${entry.difficulty}`)));
  }
  if (entry.tellMechanic) {
    sections.push(h('h3', {}, t('bob.tellMechanic')), h('p', { class: 'tell' }, `“${entry.tellMechanic}”`));
  }
  if (entry.generic) {
    sections.push(h('p', { class: 'hint' }, t('bob.genericDisclaimer')),
      h('p', { class: 'code-dialog-source' },
        sourceLink(t('bob.codes.genericSource'), 'https://github.com/foerbsnavi/OBDex')));
  }
  if (isBrand) {
    sections.push(h('p', { class: 'hint' }, t('bob.codes.manufacturerDisclaimer')));
  }
  if (!entry.known && !entry.generic && !isBrand) {
    sections.push(h('p', { class: 'hint' },
      entry.manufacturer
        ? t('bob.codes.manufacturerDetails', { code })
        : t('bob.codes.notListedDetails', { code, category: describeCategory(code) })));
  }

  sections.push(h('p', { class: 'code-dialog-search' },
    sourceLink(t('bob.searchGoogle'), searchUrl(code, searchContext))));
  dialogContent.replaceChildren(...sections);
}

function showError(code, message) {
  dialogTitle.textContent = code ? `${code} · ${t('bob.codes.notListed')}` : t('bob.codes.modalTitle');
  dialogContent.replaceChildren(h('p', { class: 'directory-error', role: 'alert' }, message));
}

async function showCode(input, make = getCar().make) {
  const code = normalize(input);
  const currentRequest = ++requestId;
  lastCode = code;
  lastMake = make;
  codeInput.value = code;
  if (!dialog.open) dialog.showModal();

  if (!isDtcCode(code)) {
    dialogTitle.textContent = t('bob.codes.notListed');
    dialogContent.replaceChildren(h('p', {}, t('bob.codes.invalid')));
    return;
  }

  dialogTitle.textContent = t('bob.codes.modalLoading');
  dialogContent.replaceChildren(h('p', { role: 'status' }, t('bob.codes.modalLoading')));
  try {
    const loadError = await codeBook;
    if (loadError) throw loadError;
    const currentEntry = lookup(code, make);
    if (!currentEntry.known && !currentEntry.generic && !currentEntry.brandSpecific) {
      if (isManufacturerCode(code) && make) await loadManufacturerCodes(make);
      else if (GENERIC_FAMILIES.includes(code.slice(0, 2))) await loadGenericFamily(code.slice(0, 2));
    }
    if (currentRequest !== requestId) return;
    renderDetails(code, lookup(code, make), make);
  } catch (err) {
    if (currentRequest === requestId) showError(code, t('bob.codes.loadFailure', { error: err.message }));
  }
}

const codeBook = loadCodeBook().then(() => null).catch((err) => {
  setDirectoryStatus(t('bob.codes.loadFailure', { error: err.message }), true);
  return err;
});

directory.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-code]');
  if (!link) return;
  event.preventDefault();
  showCode(link.dataset.code, link.dataset.make || getCar().make);
});

$('code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  showCode(codeInput.value);
});

dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

for (const chip of document.querySelectorAll('.code-chip')) {
  chip.addEventListener('click', () => showCode(chip.dataset.code));
}

const fromLink = new URLSearchParams(location.search);
if (fromLink.has('code')) showCode(fromLink.get('code'), fromLink.get('make') || getCar().make);
buildDirectory();

Promise.all([
  fetch('data/makes.json').then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }),
  fetch('data/models.json').then((res) => res.ok ? res.json() : {}),
]).then(([makes, models]) => initCarForm(makes, models)).catch((err) => {
  setDirectoryStatus(t('bob.codes.carDataFailure', { error: err.message }), true);
});

onLanguageChange(async () => {
  await reloadCodeBook();
  buildDirectory();
  renderCounter();
  if (dialog.open && lastCode) showCode(lastCode, lastMake);
});
