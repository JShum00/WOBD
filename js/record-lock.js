import { formatNumber, onLanguageChange, t } from './i18n.js';

// The full-screen driving lock shown while live data is recording. It's a
// modal <dialog>, so the page underneath is inert: no clicks, no Tab, no
// screen reader browsing. Nothing on it changes except the REC timer, so
// there's nothing to read while driving.
const $ = (id) => document.getElementById(id);

function clock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const twoDigits = (value) => formatNumber(value, { minimumIntegerDigits: 2, useGrouping: false });
  const s = total % 60;
  return h ? `${formatNumber(h)}:${twoDigits(m)}:${twoDigits(s)}` : `${formatNumber(m)}:${twoDigits(s)}`;
}

export class RecordLock {
  #dialog = $('record-lock');
  #view = null;      // 'locked' | 'unlocked' | 'choose'
  #session = null;   // { startedAt, lock }
  #unplugged = false;
  #ticker = 0;

  constructor({ onSave, onKeep }) {
    // Escape must not close the lock. Chrome lets a second Escape close a
    // dialog anyway, so the close handler reopens it while still recording.
    this.#dialog.addEventListener('cancel', (e) => e.preventDefault());
    onLanguageChange(() => this.#tick());
    this.#dialog.addEventListener('close', () => {
      if (this.#session) this.#dialog.showModal();
    });
    document.addEventListener('keydown', (e) => { if (this.#session) this.#trapTab(e); }, true);
    $('record-unlock-btn').addEventListener('click', () => this.#show('choose'));
    $('record-save').addEventListener('click', onSave);
    $('record-keep').addEventListener('click', () => {
      onKeep();
      this.#show('locked');
    });
  }

  get isOpen() { return this.#session !== null; }

  open({ startedAt, lock }) {
    this.#session = { startedAt, lock };
    this.#unplugged = false;
    this.#view = null;
    document.documentElement.classList.add('is-recording');
    this.#dialog.showModal();
    this.#show('locked');
    this.#ticker = setInterval(() => this.#tick(), 1000);
  }

  // The adapter is gone for good: no Keep Recording, just save.
  setUnplugged() {
    this.#unplugged = true;
    this.#tick();
  }

  close() {
    clearInterval(this.#ticker);
    this.#session = null;
    document.documentElement.classList.remove('is-recording');
    this.#dialog.close();
  }

  #tick() {
    if (!this.#session) return;
    const now = Date.now();
    const { unlocked, detectionUnavailable, lost } = this.#session.lock.status(now);
    const isLost = this.#unplugged || lost;
    $('record-elapsed').textContent = clock(now - this.#session.startedAt);
    $('record-note').hidden = !detectionUnavailable || isLost;
    this.#dialog.dataset.lost = isLost;
    $('record-title').textContent = t(isLost ? 'app.lock.connectionLost' : 'app.lock.eyesOnRoad');
    $('record-text').textContent = t(isLost ? 'app.lock.lostText' : 'app.lock.recordingLocked');
    $('record-save').textContent = t(isLost ? 'app.lock.saveCsv' : 'app.lock.stopSave');
    $('record-keep').hidden = this.#unplugged;

    const canUnlock = unlocked || isLost;
    if (!canUnlock && this.#view !== 'locked') this.#show('locked');  // moving again: lock back up
    else if (canUnlock && this.#view === 'locked') this.#show('unlocked');
  }

  // A modal dialog lets Tab wander out to the browser and the page body, so Tab
  // cycles through the lock's visible buttons, or stays on the lock itself.
  #trapTab(e) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const buttons = [...this.#dialog.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    if (!buttons.length) {
      this.#dialog.focus();
      return;
    }
    const i = buttons.indexOf(document.activeElement);
    const next = i === -1 ? (e.shiftKey ? buttons.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  #show(view) {
    this.#view = view;
    this.#dialog.dataset.view = view;
    $('record-unlock').hidden = view !== 'unlocked';
    $('record-choose').hidden = view !== 'choose';
    if (view === 'choose') $('record-save').focus();
    else if (view === 'locked') this.#dialog.focus();
    // Fade in, rather than appearing mid-glance.
    if (view === 'unlocked') {
      const box = $('record-unlock');
      box.classList.remove('is-visible');
      requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('is-visible')));
    }
    this.#tick();
  }
}
