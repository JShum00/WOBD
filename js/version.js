// The site's version, shown in the bottom-right corner of every page's footer.
// Bump this (and CACHE_VERSION in sw.js) when releasing. This is the only place a
// version is written: exports read it through js/version-info.js.
const WOBD_VERSION = '1.91';
window.WOBD_VERSION = WOBD_VERSION;

for (const footer of document.querySelectorAll('.site-footer')) {
  const tag = document.createElement('p');
  tag.className = 'site-version';
  const link = document.createElement('a');
  link.href = '/changelog';
  link.textContent = `WOBD v${WOBD_VERSION}`;
  tag.append(link);
  footer.append(tag);
}
