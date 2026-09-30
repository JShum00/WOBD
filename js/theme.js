// Light/dark theme. Loaded as a plain script in <head> so the right theme is
// set before the page paints. Follows the system setting until the user picks
// one with the header button; that choice is remembered in this browser.
(() => {
  const KEY = 'wobd.theme';
  const system = matchMedia('(prefers-color-scheme: dark)');

  const saved = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };

  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('theme-btn');
    if (!button) return;
    const dark = theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  };

  apply(saved() ?? (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', (e) => {
    if (!saved()) apply(e.matches ? 'dark' : 'light');
  });

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-btn');
    if (!button) return;
    apply(document.documentElement.dataset.theme);
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Storage blocked; the switch still works for this visit.
      }
      apply(next);
    });
  });
})();
