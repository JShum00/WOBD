const pages = {
  'codes.html': 'codes',
  'replay.html': 'replay',
  'guide.html': 'guide',
  'tested-adapters.html': 'adapters',
  'report.html': 'adapters',
  'simulator.html': 'demos',
};

function updateCurrentPage() {
  const page = location.pathname.split('/').pop();
  const current = pages[page] ?? (
    page === '' || page === 'index.html'
      ? location.hash === '#demos' ? 'demos' : 'scanner'
      : null
  );

  for (const link of document.querySelectorAll('[data-nav]')) {
    link.removeAttribute('aria-current');
    if (link.dataset.nav === current) link.setAttribute('aria-current', 'page');
  }
}

updateCurrentPage();
window.addEventListener('hashchange', updateCurrentPage);
