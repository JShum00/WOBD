// The gauge picker shown on each connect, before the live dashboard: the car's
// supported PIDs as checkboxes, presets, and how fast the chosen gauges will
// refresh. The helpers up top are pure, so scripts/test-supported-pids.mjs can
// check them in Node; the DOM is only touched by GaugePicker.
import { h } from './dom.js';
import { formatNumber, onLanguageChange, pidLabel, t } from './i18n.js';
import { displayUnit, onUnitsChange } from './units.js';
import {
  BATTERY, DEFAULT_GAUGES, LIVE_PIDS, MODE01_DECODERS, PID_NAMES, PRESETS, ROUND_PAUSE_MS, SLOW_EVERY, UNNAMED_PID,
  buildPidCatalog, gaugeDefs, isChainPid, pollingInterval,
} from './obd.js';

const ADAPTER_MS = 30;  // ATRV never leaves the adapter, so it's quick on any car
const ALL_DEFS = [...LIVE_PIDS, BATTERY];

// What the picker offers. supported is the car's Set of PIDs, or null when it
// wouldn't say, in which case every gauge WOBD knows is offered.
// undecoded lists supported PIDs with no gauge yet (not 0x01, which the scan uses).
export function pickerChoices(supported, ecus = []) {
  const offered = gaugeDefs(supported ?? new Set(LIVE_PIDS.map((def) => def.pid)));
  const decodable = new Set(MODE01_DECODERS.keys());
  const undecoded = [...(supported ?? [])]
    .filter((pid) => !decodable.has(pid) && pid !== 0x01 && !isChainPid(pid))
    .sort((a, b) => a - b)
    .map((pid) => ({ pid, name: PID_NAMES[pid] ?? UNNAMED_PID }));
  const catalog = buildPidCatalog(supported ?? new Set(LIVE_PIDS.map((def) => def.pid)), ecus)
    .map((entry) => ({
      ...entry,
      supportKnown: supported !== null,
      availability: supported === null ? t('app.picker.supportNotReported') : entry.availability,
    }));
  return { offered, undecoded, catalog };
}

// The boxes checked on a fresh connect: today's dashboard, limited to this car.
export function defaultKeys(offered) {
  return new Set(offered.map((def) => def.key).filter((key) => DEFAULT_GAUGES.includes(key)));
}

export function automaticKeys(offered) {
  return new Set(offered.filter((def) => def.monitorable !== false).map((def) => def.key));
}

// A preset's keys limited to this car, plus the labels it had to skip.
export function presetKeys(preset, offered) {
  const available = new Set(offered.map((def) => def.key));
  const wanted = preset.keys ?? [...available];
  return {
    keys: new Set(wanted.filter((key) => available.has(key))),
    skipped: wanted.filter((key) => !available.has(key)).map((key) => pidLabel(ALL_DEFS.find((def) => def.key === key))),
  };
}

// How often the chosen gauges refresh, mirroring the live loop: fast PIDs every
// round, slow ones (and battery) every SLOW_EVERY rounds.
export function estimateRefresh(defs, requestMs, mode = 'manual') {
  const pids = defs.filter((def) => def.pid !== undefined);
  if (mode === 'automatic') {
    const intervals = pids.map((def) => pollingInterval(def, mode));
    const round = requestMs * intervals.reduce((sum, interval) => sum + 1 / interval, 0)
      + (defs.includes(BATTERY) ? ADAPTER_MS / SLOW_EVERY : 0) + ROUND_PAUSE_MS;
    const slowest = Math.max(0, ...intervals, defs.includes(BATTERY) ? SLOW_EVERY : 0);
    return {
      fastMs: intervals.includes(1) ? round : null,
      slowMs: slowest > 1 ? round * slowest : null,
    };
  }
  const fast = pids.filter((def) => !def.slow).length;
  const slow = pids.length - fast;
  const battery = defs.includes(BATTERY) ? 1 : 0;
  const round = fast * requestMs + (slow * requestMs + battery * ADAPTER_MS) / SLOW_EVERY + ROUND_PAUSE_MS;
  return { fastMs: fast ? round : null, slowMs: slow + battery ? round * SLOW_EVERY : null };
}

const seconds = (ms) => `${formatNumber(ms / 1000, { minimumFractionDigits: ms < 10000 ? 1 : 0, maximumFractionDigits: ms < 10000 ? 1 : 0 })} s`;

function estimateText(defs, requestMs, measured, mode) {
  if (!defs.length) return t('app.picker.pickAtLeastOne');
  const { fastMs, slowMs } = estimateRefresh(defs, requestMs, mode);
  const speed = t(measured ? 'app.picker.measuredSpeed' : 'app.picker.estimatedSpeed', {
    ms: formatNumber(Math.round(requestMs)),
  });
  const params = {
    count: `${formatNumber(defs.length)} ${t(defs.length === 1 ? 'app.picker.gaugeSingular' : 'app.picker.gaugePlural')}`,
    secondsFast: fastMs ? seconds(fastMs) : '',
    secondsSlow: slowMs ? seconds(slowMs) : '',
    speed,
  };
  if (fastMs && slowMs) return t(mode === 'automatic' ? 'app.picker.estimateAutoBoth' : 'app.picker.estimateManualBoth', params);
  if (fastMs) return t('app.picker.estimateFast', params);
  if (slowMs) return t(mode === 'automatic' ? 'app.picker.estimateAutoSlow' : 'app.picker.estimateManualSlow', params);
  return t('app.picker.estimateNoPids', params);
}

// A supported PID WOBD can't show yet: listed, but never selectable.
function undecodedRow({ pid, name }) {
  return h('li', {},
    h('label', { class: 'picker-option is-disabled' },
      h('input', { type: 'checkbox', disabled: true }),
      h('span', { class: 'picker-name' }, ALL_DEFS.find((def) => def.pid === pid) ? pidLabel(ALL_DEFS.find((def) => def.pid === pid)) : name),
      h('span', { class: 'picker-pid' }, `0x${pid.toString(16).toUpperCase().padStart(2, '0')}`)));
}

function catalogRow(entry) {
  const status = entry.decoderAvailable
    ? entry.monitorable ? t('app.picker.decodedMonitorable') : t('app.picker.decodedNotLive')
    : t('app.picker.decoderUnavailable');
  const support = entry.supportKnown ? t('app.picker.supportedVehicle') : t('app.picker.supportNotReported');
  const sources = entry.ecuSources.length ? t('app.picker.ecuSources', { sources: entry.ecuSources.join(', ') }) : t('app.picker.ecuUnknown');
  return h('li', { class: 'picker-catalog-row' },
    h('div', { class: 'picker-catalog-heading' },
      h('strong', {}, (ALL_DEFS.find((def) => def.pid === entry.pid) && pidLabel(ALL_DEFS.find((def) => def.pid === entry.pid))) || entry.name),
      h('span', { class: 'picker-pid' }, `0x${entry.pid.toString(16).toUpperCase().padStart(2, '0')}${entry.unit ? ` · ${displayUnit(entry.unit)}` : ''}`)),
    h('p', {}, entry.description),
    h('p', { class: 'picker-catalog-meta' }, `${support} · ${status} · ${sources}`));
}

export class GaugePicker {
  #root;
  #offered = [];
  #mode = 'manual';
  #timing = { requestMs: 150, measured: false };
  #onApply;
  #onPresetHint;
  #renderState = null;
  #filterTerm = '';
  #skipped = [];
  #skippedKeys = [];

  constructor({ root, onApply, onPresetHint }) {
    this.#root = root;
    this.#onApply = onApply;
    this.#onPresetHint = onPresetHint;
    onLanguageChange(() => this.#rerender());
    onUnitsChange(() => this.#rerender());
  }

  get isOpen() { return !this.#root.hidden; }

  #rerender() {
    if (this.#root.hidden || !this.#renderState) return;
    const checked = new Set([...this.#root.querySelectorAll('.picker-list input:checked')].map((box) => box.value));
    this.show({ ...this.#renderState, checked, mode: this.#mode });
    this.#filter(this.#filterTerm);
    const skipped = this.#skippedKeys.map((key) => pidLabel(ALL_DEFS.find((def) => def.key === key)));
    this.#setChecked(checked, skipped, this.#mode, this.#skippedKeys);
  }

  // checked: the gauge keys to tick. timing: { requestMs, measured }.
  show({ offered, undecoded, catalog, checked, timing, mode = 'manual' }) {
    this.#renderState = { offered, undecoded, catalog, checked, timing, mode };
    this.#offered = offered;
    this.#mode = mode;
    this.#timing = timing;
    const boxes = offered.map((def) => h('label', { class: 'picker-option' },
      h('input', {
        type: 'checkbox',
        value: def.key,
        checked: checked.has(def.key),
        onChange: () => { this.#setMode('manual'); this.#update(); },
      }),
      h('span', { class: 'picker-name' }, pidLabel(def)),
      h('span', { class: 'picker-pid' }, pidLabel(def))));
    const groups = new Map();
    for (const entry of catalog) {
      if (!groups.has(entry.category)) groups.set(entry.category, []);
      groups.get(entry.category).push(entry);
    }
    const catalogGroups = [...groups].map(([category, entries]) =>
      h('section', { class: 'picker-catalog-group' },
        h('h3', {}, category),
        h('ul', {}, entries.map(catalogRow))));

    const presets = PRESETS.map((preset) => h('button', {
      type: 'button',
      class: 'btn picker-preset',
      onClick: () => this.#applyPreset(preset),
      onPointerenter: () => this.#onPresetHint(preset),
      onFocus: () => this.#onPresetHint(preset),
    }, preset.label));

    this.#root.replaceChildren(
      h('h2', { class: 'picker-title' }, t('app.picker.title')),
      h('p', { class: 'picker-lede' }, offered.length > 1
        ? t('app.picker.availableIntro')
        : t('app.picker.noReadingsIntro')),
      !offered.some((def) => def.key === 'fuellevel') && h('p', { class: 'picker-fuel-note' },
        t('app.picker.fuelUnavailable')),
      h('fieldset', { class: 'picker-mode' },
        h('legend', {}, t('app.picker.monitoringMode')),
        h('label', {}, h('input', {
          type: 'radio', name: 'monitor-mode', value: 'manual', checked: mode === 'manual',
          onChange: () => this.#setMode('manual'),
        }), t('app.picker.manualSelection')),
        h('label', {}, h('input', {
          type: 'radio', name: 'monitor-mode', value: 'automatic', checked: mode === 'automatic',
          onChange: () => this.#setMode('automatic'),
        }), t('app.picker.automaticSelection'))),
      h('div', { class: 'picker-presets', role: 'group', 'aria-label': t('app.picker.presets') },
        presets,
        h('button', { type: 'button', class: 'btn picker-preset', onClick: () => this.#setChecked(new Set()) }, t('app.picker.clear'))),
      h('p', { class: 'picker-skipped', hidden: true, 'aria-live': 'polite' }),
      h('label', { class: 'picker-search-label' }, t('app.picker.search'),
        h('input', { type: 'search', class: 'picker-search', onInput: (event) => this.#filter(event.currentTarget.value) })),
      h('fieldset', { class: 'picker-list' }, h('legend', { class: 'sr-only' }, t('app.picker.gauges')), boxes),
      undecoded.length > 0 && h('details', { class: 'picker-undecoded' },
        h('summary', {}, t('app.picker.undecodedCount', { count: formatNumber(undecoded.length) })),
        h('ul', {}, undecoded.map(undecodedRow))),
      catalog.length > 0 && h('details', { class: 'picker-catalog' },
        h('summary', {}, t('app.picker.catalogCount', { count: formatNumber(catalog.length) })),
        h('p', { class: 'picker-catalog-note' }, t('app.picker.catalogNote')),
        ...catalogGroups),
      h('p', { class: 'picker-estimate', 'aria-live': 'polite' }),
      h('div', { class: 'picker-actions' },
        h('button', { type: 'button', class: 'btn btn-primary picker-apply', onClick: () => this.#apply() }, t('app.picker.applyContinue'))));
    this.#root.hidden = false;
    this.#update();
  }

  hide() {
    this.#root.hidden = true;
  }

  #checkedDefs() {
    const keys = new Set([...this.#root.querySelectorAll('.picker-list input:checked')].map((box) => box.value));
    return this.#offered.filter((def) => keys.has(def.key));
  }

  #setChecked(keys, skipped = [], mode = 'manual', skippedKeys = []) {
    this.#mode = mode;
    this.#skippedKeys = skippedKeys;
    for (const box of this.#root.querySelectorAll('.picker-list input')) box.checked = keys.has(box.value);
    this.#skipped = skipped;
    const note = this.#root.querySelector('.picker-skipped');
    note.textContent = skipped.length ? t('app.picker.skipped', { names: skipped.join(', ') }) : '';
    note.hidden = !skipped.length;
    this.#syncMode();
    this.#update();
  }

  #setMode(mode) {
    this.#mode = mode;
    if (mode === 'automatic') {
      this.#setChecked(automaticKeys(this.#offered), [], 'automatic');
      return;
    }
    this.#syncMode();
  }

  #syncMode() {
    const radio = this.#root.querySelector(`.picker-mode input[value="${this.#mode}"]`);
    if (radio) radio.checked = true;
  }

  #filter(query) {
    this.#filterTerm = query;
    const term = query.trim().toLocaleLowerCase();
    for (const row of this.#root.querySelectorAll('.picker-option, .picker-catalog-row')) {
      row.hidden = term !== '' && !row.textContent.toLocaleLowerCase().includes(term);
    }
    for (const group of this.#root.querySelectorAll('.picker-catalog-group')) {
      group.hidden = !group.querySelector('.picker-catalog-row:not([hidden])');
    }
  }

  #applyPreset(preset) {
    this.#onPresetHint(preset);
    const { keys, skipped } = presetKeys(preset, this.#offered);
    const wanted = preset.keys ?? ALL_DEFS.map((def) => def.key);
    const available = new Set(this.#offered.map((def) => def.key));
    const skippedKeys = wanted.filter((key) => !available.has(key));
    this.#setChecked(keys, skipped, 'manual', skippedKeys);
  }

  #update() {
    const defs = this.#checkedDefs();
    this.#root.querySelector('.picker-apply').disabled = defs.length === 0;
    this.#root.querySelector('.picker-estimate').textContent =
      estimateText(defs, this.#timing.requestMs, this.#timing.measured, this.#mode);
  }

  #apply() {
    const defs = this.#checkedDefs();
    if (defs.length) this.#onApply(defs, this.#mode);
  }
}
