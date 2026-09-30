// Bob's voice: optional read-aloud of his speech bubble through the Web Speech
// API. Off by default; the choice is remembered in this browser only.

const PREF_KEY = 'wobd.voice';

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

function savePref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked; the toggle still works for this visit.
  }
}

// Makes Bob's text sound right: spells codes out ("P 0 4 2 0"), drops emoji
// and separators, and splits into sentences. Chrome cuts off long utterances,
// so each sentence is queued on its own.
function toSentences(text) {
  return text
    .replace(/\b([PCBU])([0-9A-F]{4})\b/g, (_, letter, digits) => `${letter} ${[...digits].join(' ')}`)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*·\s*/g, ', ')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class Voice {
  constructor() {
    this.synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.enabled = this.supported && readPref();
    this.voice = null;
    if (!this.supported) return;
    this.#pickVoice();
    this.synth.addEventListener('voiceschanged', () => this.#pickVoice());
    window.addEventListener('pagehide', () => this.stop());
  }

  get supported() {
    return Boolean(this.synth) && 'SpeechSynthesisUtterance' in window;
  }

  setEnabled(on) {
    this.enabled = on;
    savePref(on);
    if (!on) this.stop();
  }

  // Prefers a voice installed on this computer, so Bob keeps talking offline
  // and his words stay local. Some browsers only offer online voices.
  #pickVoice() {
    const english = this.synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
    const us = (v) => /^en[-_]US$/i.test(v.lang);
    this.voice = english.find((v) => v.localService && us(v))
      ?? english.find((v) => v.localService)
      ?? english.find(us)
      ?? english[0]
      ?? null;
  }

  speak(text) {
    if (!this.enabled || !text) return;
    this.stop();
    for (const sentence of toSentences(text)) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = this.voice?.lang ?? 'en-US';
      if (this.voice) utterance.voice = this.voice;
      utterance.pitch = 0.9;  // a touch lower, for a friendly mechanic
      utterance.rate = 1;
      this.synth.speak(utterance);
    }
  }

  stop() {
    this.synth?.cancel();
  }
}
