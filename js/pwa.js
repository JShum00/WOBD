// Registers the service worker (secure origins only). Deliberately never
// reloads the page when an update arrives, so a live adapter connection survives.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Offline mode unavailable:', err);
    });
  });
}
