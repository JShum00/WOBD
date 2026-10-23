// Raw capture of parameters WOBD can't decode yet: the opt-in consent state, how often to
// sample them, and a time budget so they never crowd out the regular gauges. No DOM and no
// clock here, so scripts/test-raw-capture.mjs can exercise all of it.
import { DRIVING_SPEED_MPH } from './recorder.js';

export const SPEED_FRESH_MS = 5000;   // an older speed reading no longer counts as known
const MOVING_MPH = 2;                  // leave "stationary" at this speed (enter it at exactly 0)
const MARGIN_MPH = 1;                  // hysteresis around the driving threshold

// Starting rates, not guaranteed-safe ones: the budget below still applies.
const EVERY = { stationary: 1, slow: 3, driving: 6, unknown: 6 };

// How often (every N polling rounds) to sample one undecoded parameter. speedValid is explicit,
// so a missing or stale speed is never mistaken for a parked car. previousBand adds hysteresis
// so the rate doesn't flip back and forth right at a boundary.
export function rawEvery(speedMph, speedValid, previousBand = null) {
  if (!speedValid || !Number.isFinite(speedMph)) return { band: 'unknown', every: EVERY.unknown };
  let band;
  if (previousBand === 'stationary') {
    band = speedMph < MOVING_MPH ? 'stationary' : speedMph > DRIVING_SPEED_MPH + MARGIN_MPH ? 'driving' : 'slow';
  } else if (previousBand === 'driving') {
    band = speedMph >= DRIVING_SPEED_MPH - MARGIN_MPH ? 'driving' : speedMph === 0 ? 'stationary' : 'slow';
  } else {
    band = speedMph === 0 ? 'stationary' : speedMph > DRIVING_SPEED_MPH + MARGIN_MPH ? 'driving' : 'slow';
  }
  return { band, every: EVERY[band] };
}

// Raw reads may use only a share of the time the live loop spends reading. The numbers decay, so
// the budget follows the recent loop and adapts to how fast this adapter and protocol really are.
export class RawBudget {
  constructor() {
    this.gaugeMs = 0;
    this.rawMs = 0;
  }

  note(kind, ms) {
    this.gaugeMs *= 0.98;
    this.rawMs *= 0.98;
    if (kind === 'raw') this.rawMs += ms;
    else this.gaugeMs += ms;
  }

  // Parked cars can spare more; moving or unknown ones keep to a smaller share.
  allows(band) {
    const share = band === 'stationary' ? 0.5 : 0.25;
    return this.rawMs <= share * (this.rawMs + this.gaugeMs);
  }
}

// Consent for recording undecoded parameters. Turning it on needs an acknowledgement every time,
// and it is locked while a recording runs, so it only ever applies to the next recording.
export class RawOptIn {
  constructor() {
    this.enabled = false;
    this.acknowledged = false;
    this.locked = false;
  }

  // The checkbox was ticked: true when the dialog should open.
  request() {
    if (this.locked || this.enabled) return false;
    this.acknowledged = false;
    return true;
  }

  setAcknowledged(value) {
    this.acknowledged = Boolean(value);
  }

  get canConfirm() {
    return this.acknowledged;
  }

  confirm() {
    this.enabled = this.acknowledged && !this.locked;
    return this.enabled;
  }

  // Cancel, Escape, or closing the dialog never enables anything.
  cancel() {
    this.enabled = false;
    this.acknowledged = false;
  }

  disable() {
    if (!this.locked) this.cancel();
  }

  lock() {
    this.locked = true;
  }

  unlock() {
    this.locked = false;
  }
}
