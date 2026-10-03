// The site's version, shown in the bottom-right corner of every page's footer.
// Bump this (and CACHE_VERSION in sw.js) when releasing.
const WOBD_VERSION = '1.3';

for (const footer of document.querySelectorAll('.site-footer')) {
  const tag = document.createElement('p');
  tag.className = 'site-version';
  tag.textContent = `WOBD v${WOBD_VERSION}`;
  footer.append(tag);
}
