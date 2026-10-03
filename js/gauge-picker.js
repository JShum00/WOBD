// The gauge picker shown on each connect, before the live dashboard: the car's
// supported PIDs as checkboxes, presets, and how fast the chosen gauges will
// refresh. The helpers up top are pure, so scripts/test-supported-pids.mjs can
// check them in Node; the DOM is only touched by GaugePicker.
import { h } from './dom.js';
import {
  BATTERY, DEFAULT_GAUGES, LIVE_PIDS, PID_NAMES, PRESETS, ROUND_PAUSE_MS, SLOW_EVERY,
  gaugeDefs, isChainPid, pidLabel,
} from './obd.js';

const ADAPTER_MS = 30;  // ATRV never leaves the adapter, so it's quick on any car
const ALL_DEFS = [...LIVE_PIDS, BATTERY];

// What the picker offers. supported is the car's Set of PIDs, or null when it
// wouldn't say, in which case every gauge WOBD knows is offered.
// undecoded lists supported PIDs with no gauge yet (not 0x01, which the scan uses).
export function pickerChoices(supported) {
  const offered = gaugeDefs(supported ?? new Set(LIVE_PIDS.map((def) => def.pid)));
  const decodable = new Set(LIVE_PIDS.map((def) => def.pid));
  const undecoded = [...(supported ?? [])]
    .filter((pid) => !decodable.has(pid) && pid !== 0x01 && !isChainPid(pid))
    .sort((a, b) => a - b)
    .map((pid) => ({ pid, name: PID_NAMES[pid] ?? 'Not a standard PID' }));
  return { offered, undecoded };
}

// The boxes checked on a fresh connect: today's dashboard, limited to this car.
export function defaultKeys(offered) {
  return new Set(offered.map((def) => def.key).filter((key) => DEFAULT_GAUGES.includes(key)));
}

// A preset's keys limited to this car, plus the labels it had to skip.
export function presetKeys(preset, offered) {
  const available = new Set(offered.map((def) => def.key));
  const wanted = preset.keys ?? [...available];
  return {
    keys: new Set(wanted.filter((key) => available.has(key))),
    skipped: wanted.filter((key) => !available.has(key)).map((key) => ALL_DEFS.find((def) => def.key === key).label),
  };
}

// How often the chosen gauges refresh, mirroring the live loop: fast PIDs every
// round, slow ones (and battery) every SLOW_EVERY rounds.
export function estimateRefresh(defs, requestMs) {
  const pids = defs.filter((def) => def.pid !== undefined);
  const fast = pids.filter((def) => !def.slow).length;
  const slow = pids.length - fast;
  const battery = defs.includes(BATTERY) ? 1 : 0;
  const round = fast * requestMs + (slow * requestMs + battery * ADAPTER_MS) / SLOW_EVERY + ROUND_PAUSE_MS;
  return { fastMs: fast ? round : null, slowMs: slow + battery ? round * SLOW_EVERY : null };
}

const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

function estimateText(defs, requestMs, measured) {
  if (!defs.length) return 'Pick at least one gauge.';
  const { fastMs, slowMs } = estimateRefresh(defs, requestMs);
  const count = `${defs.length} gauge${defs.length === 1 ? '' : 's'}`;
  const parts = [];
  if (fastMs) parts.push(`each one updates about every ${seconds(fastMs)}`);
  if (slowMs) parts.push(`${fastMs ? 'temperatures, fuel trims, and battery' : 'they'} every ${seconds(slowMs)}`);
  const speed = `${measured ? '' : 'about '}${Math.round(requestMs)} ms per reading${measured ? ' on this car' : ''}`;
  return `Fewer gauges = faster updates. With ${count}, ${parts.join(', and ')} (${speed}).`;
}

// A supported PID WOBD can't show yet: listed, but never selectable.
function undecodedRow({ pid, name }) {
  return h('li', {},
    h('label', { class: 'picker-option is-disabled' },
      h('input', { type: 'checkbox', disabled: true }),
      h('span', { class: 'picker-name' }, name),
      h('span', { class: 'picker-pid' }, pidLabel({ pid }))));
}

export class GaugePicker {
  #root;
  #offered = [];
  #timing = { requestMs: 150, measured: false };
  #onApply;
  #onPresetHint;

  constructor({ root, onApply, onPresetHint }) {
    this.#root = root;
    this.#onApply = onApply;
    this.#onPresetHint = onPresetHint;
  }

  get isOpen() { return !this.#root.hidden; }

  // checked: the gauge keys to tick. timing: { requestMs, measured }.
  show({ offered, undecoded, checked, timing }) {
    this.#offered = offered;
    this.#timing = timing;
    const boxes = offered.map((def) => h('label', { class: 'picker-option' },
      h('input', { type: 'checkbox', value: def.key, checked: checked.has(def.key), onChange: () => this.#update() }),
      h('span', { class: 'picker-name' }, def.label),
      h('span', { class: 'picker-pid' }, pidLabel(def))));

    const presets = PRESETS.map((preset) => h('button', {
      type: 'button',
      class: 'btn picker-preset',
      onClick: () => this.#applyPreset(preset),
      onPointerenter: () => this.#onPresetHint(preset),
      onFocus: () => this.#onPresetHint(preset),
    }, preset.label));

    this.#root.replaceChildren(
      h('h2', { class: 'picker-title' }, 'Pick your gauges'),
      h('p', { class: 'picker-lede' }, offered.length > 1
        ? 'These are the live readings your car supports that WOBD can show.'
        : "Your car didn't report any live readings WOBD can show yet, so only the adapter's battery reading is available."),
      h('div', { class: 'picker-presets', role: 'group', 'aria-label': 'Presets' },
        presets,
        h('button', { type: 'button', class: 'btn picker-preset', onClick: () => this.#setChecked(new Set()) }, 'Clear')),
      h('p', { class: 'picker-skipped', hidden: true, 'aria-live': 'polite' }),
      h('fieldset', { class: 'picker-list' }, h('legend', { class: 'sr-only' }, 'Gauges'), boxes),
      undecoded.length > 0 && h('details', { class: 'picker-undecoded' },
        h('summary', {}, `Supported but not decoded yet (${undecoded.length})`),
        h('ul', {}, undecoded.map(undecodedRow))),
      h('p', { class: 'picker-estimate', 'aria-live': 'polite' }),
      h('div', { class: 'picker-actions' },
        h('button', { type: 'button', class: 'btn btn-primary picker-apply', onClick: () => this.#apply() }, 'Apply & continue')));
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

  #setChecked(keys, skipped = []) {
    for (const box of this.#root.querySelectorAll('.picker-list input')) box.checked = keys.has(box.value);
    const note = this.#root.querySelector('.picker-skipped');
    note.textContent = skipped.length ? `Not available on this car: ${skipped.join(', ')}.` : '';
    note.hidden = !skipped.length;
    this.#update();
  }

  #applyPreset(preset) {
    this.#onPresetHint(preset);
    const { keys, skipped } = presetKeys(preset, this.#offered);
    this.#setChecked(keys, skipped);
  }

  #update() {
    const defs = this.#checkedDefs();
    this.#root.querySelector('.picker-apply').disabled = defs.length === 0;
    this.#root.querySelector('.picker-estimate').textContent =
      estimateText(defs, this.#timing.requestMs, this.#timing.measured);
  }

  #apply() {
    const defs = this.#checkedDefs();
    if (defs.length) this.#onApply(defs);
  }
}
