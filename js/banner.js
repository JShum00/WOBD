// Lets people close the home-page development banner. The choice is remembered
// per release (WOBD_VERSION), so the banner returns when a new version ships.
const KEY = 'wobd-banner-dismissed';
const banner = document.getElementById('dev-banner');

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

if (banner) {
  if (stored() === WOBD_VERSION) banner.hidden = true;
  document.getElementById('dev-banner-close')?.addEventListener('click', () => {
    banner.hidden = true;
    try { localStorage.setItem(KEY, WOBD_VERSION); } catch { /* private mode: it just returns next visit */ }
  });
}
