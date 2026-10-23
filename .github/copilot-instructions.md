# Repository instructions

## Project shape

- WOBD is a static, browser-based OBD-II diagnostic tool. There is no build step or app bundler; pages load native JavaScript modules directly.
- Use `README.md` as the source of truth for the project layout, local setup, supported workflows, and code-data conventions.
- Keep changes focused and consistent with the existing vanilla HTML, CSS, and JavaScript patterns. Avoid adding dependencies unless the change needs them.

## Development and validation

- Run locally with `python3 -m http.server 8000`, then open `http://localhost:8000` in Chrome or Edge. Web Serial requires a secure context (HTTPS or localhost).
- Run the focused baud-detection checks with `node scripts/test-smartbauder.mjs`.
- There is no general build or test command in `package.json`. For browser-facing changes, verify the affected page and relevant interaction in a browser when possible.

## Data and offline behavior

- `scripts/update-models.mjs` refreshes NHTSA model data; `scripts/update-generic-codes.mjs` refreshes the generic code database and requires `npm install` first.
- Data refresh scripts can bump `CACHE_VERSION` in `sw.js`. When adding files to the offline app shell, update `APP_SHELL` in `sw.js` as well.
- Keep `data/codes.json` explanations aligned with the README's schema and plain-English requirements. Generic code data is generated from OBDex; do not hand-edit generated files unless the task specifically requires it.

## Requirements Every Release

- Before every release verify with me that I am ready to push the release.
- Update readme.md, other docs, changelog, sitemap, and robots.txt accordingly (if need) before every release or when a task is finished.
- The project pushes to both github and cloudflare. Use wrangler deploy to push to wobd.app
- The site url (public and live) is https://wobd.app/
- If at anypoint you need something clarified, stop and ask.

## Important, About Quotas and Usage Limits

- If you are given a task that you know will exceed usage limit quotas and the corresponding additional budget, let me know before you begin.
- If you find yourself in a situation where the task can not be finished before quota is used up, stop, mark where you left off, and notify me.