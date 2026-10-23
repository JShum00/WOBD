// Starts localization and the units setting on every page that includes it. Page modules
// that build text with t() import `ready` and await it before they render anything.
import { initI18n, onLanguageChange, t } from './i18n.js';
import { SYSTEMS, getUnits, initUnits, setUnits } from './units.js';

function addUnitsSelect() {
  const header = document.querySelector('.header-right');
  if (!header || document.getElementById('units-select')) return;
  if (!document.getElementById('panel-live') && !document.getElementById('replay-load')) return;
  const select = document.createElement('select');
  select.id = 'units-select';
  select.className = 'lang-select';
  for (const value of SYSTEMS) select.append(Object.assign(document.createElement('option'), { value }));
  const label = () => {
    select.setAttribute('aria-label', t('units.label'));
    select.options[0].textContent = t('units.imperial');
    select.options[1].textContent = t('units.metric');
  };
  label();
  select.value = getUnits();
  select.addEventListener('change', () => setUnits(select.value));
  header.insertBefore(select, document.getElementById('lang-select')?.nextSibling ?? header.firstChild);
  onLanguageChange(label);
}

export const ready = initI18n().then(() => {
  initUnits();
  addUnitsSelect();
});
await ready;
