// Bob's voice: optional read-aloud of his speech bubble through the Web Speech
// API. Off by default; the choice is remembered in this browser only.

import { getLanguage } from './i18n.js';

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
    .split(/(?<=[.!?…！？。])\s*/u)
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
    const voices = this.synth.getVoices();
    const selectedLanguage = getLanguage() === 'zh-Hans' ? 'zh-CN' : getLanguage();
    const language = selectedLanguage.toLowerCase();
    const selected = voices.filter((voice) => voice.lang.toLowerCase().replaceAll('_', '-').startsWith(language));
    const english = voices.filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang));
    const preferLocal = (list) => list.find((voice) => voice.localService) ?? list[0] ?? null;
    this.voice = preferLocal(selected) ?? preferLocal(english);
  }

  speak(text) {
    if (!this.enabled || !text) return;
    this.stop();
    this.#pickVoice();
    for (const sentence of toSentences(text)) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      const language = getLanguage();
      utterance.lang = language === 'zh-Hans' ? 'zh-CN' : language;
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
