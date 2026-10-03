// Live data recording: keeps readings in memory, turns them into a CSV, and
// decides when the driving lock may offer to unlock. No DOM here, and every
// method takes the time as `now` (ms), so scripts/test-recorder.mjs can replay
// a drive without a car or a browser.
import { pidLabel } from './obd.js';

export const DRIVING_SPEED_MPH = 5;        // faster than this counts as driving
export const STOPPED_UNLOCK_MS = 15000;    // valid 0 mph this long after driving unlocks
export const NO_DETECTION_UNLOCK_MS = 10000;  // plain unlock when the car has no speed PID
export const LOST_AFTER_MS = 10000;        // no valid PID reply this long means the car stopped answering

const SPEED = 0x0D;
const RPM = 0x0C;

const isValid = (value) => (typeof value === 'number' ? Number.isFinite(value) : value != null);
const pad = (n, size = 2) => String(n).padStart(size, '0');

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class Recording {
  // protocol and baudRate are repeated on every row, so the file stays one row
  // per reading with no comment lines for graphing tools to trip over.
  constructor(now, { protocol = null, baudRate = null } = {}) {
    this.startedAt = now;
    this.protocol = protocol ?? 'unknown';
    this.baud = Number.isInteger(baudRate) ? baudRate : 'unknown';
    this.rows = [];
  }

  // Dropouts (null) are skipped, never written as empty values.
  add(def, value, now) {
    if (isValid(value)) this.rows.push({ at: now, def, value });
  }

  toCsv() {
    const lines = [['timestamp', 'elapsed_ms', 'pid', 'name', 'value', 'unit', 'protocol', 'baud']];
    for (const { at, def, value } of this.rows) {
      lines.push([
        new Date(at).toISOString(),
        at - this.startedAt,
        pidLabel(def),
        def.label,
        typeof value === 'number' ? value.toFixed(def.digits ?? 2) : value,
        def.unit ?? '',
        this.protocol,
        this.baud,
      ]);
    }
    return `${lines.map((line) => line.map(csvField).join(',')).join('\r\n')}\r\n`;
  }

  // wobd-recording-YYYY-MM-DD-HHMMSS.csv, in local time, from when recording started.
  filename() {
    const d = new Date(this.startedAt);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `wobd-recording-${date}-${time}.csv`;
  }
}

// Driving lock: waiting (not moving yet) -> driving -> unlocked.
// Only valid readings count. A dropout never adds stopped time and never resets it.
export class DriveLock {
  constructor({ hasSpeed, hasRpm, hasPids = true }, now) {
    this.hasSpeed = hasSpeed;
    this.hasRpm = hasRpm;
    this.hasPids = hasPids;
    this.lastValidAt = now;
    this.speedSeen = false;  // a car can list Speed and still never answer it
    this.reset(now);
  }

  // Back to "the car just started", for Keep Recording.
  reset(now) {
    this.phase = 'waiting';
    this.startedAt = now;
    this.stoppedMs = 0;
    this.lastZeroAt = null;  // previous speed reply, if it was a valid 0
    this.speed = null;       // latest valid speed
  }

  update(def, value, now) {
    if (def.pid === undefined || !isValid(value)) {
      // A missed speed reply breaks the run of zeros: the next valid 0 starts a
      // new interval, so the time spent without data is never counted.
      if (def.pid === SPEED) this.lastZeroAt = null;
      return;
    }
    this.lastValidAt = now;
    if (def.pid === SPEED) this.#speed(value, now);
    else if (def.pid === RPM) this.#rpm(value);
  }

  #speed(mph, now) {
    this.speed = mph;
    this.speedSeen = true;
    if (mph > DRIVING_SPEED_MPH && this.phase !== 'driving') {
      // Moving again before anyone pressed Unlock locks it back up.
      this.phase = 'driving';
      this.stoppedMs = 0;
      this.lastZeroAt = null;
      return;
    }
    if (this.phase !== 'driving') return;
    if (mph !== 0) {
      this.stoppedMs = 0;
      this.lastZeroAt = null;
      return;
    }
    if (this.lastZeroAt !== null) this.stoppedMs += now - this.lastZeroAt;
    this.lastZeroAt = now;
    if (this.stoppedMs >= STOPPED_UNLOCK_MS) this.phase = 'unlocked';
  }

  // Engine off. Needs a stopped car too: a hybrid can drive on battery at 0 rpm.
  #rpm(rpm) {
    if (rpm !== 0) return;
    if (!this.hasSpeed || (this.phase === 'driving' && this.speed === 0)) this.phase = 'unlocked';
  }

  status(now) {
    // No speed to watch: a plain unlock after a short delay, flagged on the overlay.
    const noSpeed = !this.hasSpeed || (!this.speedSeen && now - this.startedAt >= NO_DETECTION_UNLOCK_MS);
    const fallback = noSpeed && now - this.startedAt >= NO_DETECTION_UNLOCK_MS;
    return {
      unlocked: this.phase === 'unlocked' || fallback,
      detectionUnavailable: noSpeed,
      lost: this.hasPids && now - this.lastValidAt >= LOST_AFTER_MS,
    };
  }
}
