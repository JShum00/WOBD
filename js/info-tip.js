import { t } from './i18n.js';

// Small "i" button that opens a shared popover with an explanation. Click or press
// Enter to toggle; click elsewhere, press Escape, or scroll to close. Hover shows the text as a tooltip too.
let bubble = null;
let owner = null;

function close() {
  if (!bubble) return;
  bubble.hidden = true;
  owner?.setAttribute('aria-expanded', 'false');
  owner = null;
}

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'info-tip-bubble';
  bubble.id = 'info-tip-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  document.body.append(bubble);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.info-tip, .info-tip-bubble')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { owner?.focus(); close(); }
  });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  return bubble;
}

function open(button, text) {
  const tip = ensureBubble();
  tip.textContent = text;
  tip.hidden = false;
  const rect = button.getBoundingClientRect();
  const width = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', tip.id);
  owner = button;
}

export function infoTip(text, label = t('app.ui.moreInfo')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-tip';
  button.textContent = 'i';
  button.title = text;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const wasOpen = owner === button;
    close();
    if (!wasOpen) open(button, text);
  });
  return button;
}
