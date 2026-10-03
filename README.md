# WOBD: Web On-Board Diagnostics

A free, browser-based car diagnostic tool. Plug a USB OBD-II adapter into a Chromebook or laptop, open the site, and read your car's trouble codes with nothing to install. Bob, a scripted cartoon mechanic, explains each code in plain English.

## Features

- **Scan and clear codes**: Bob explains each stored trouble code in plain English.
- **Live data dashboard**: a gauge cluster with radial dials (RPM, speed), vertical bars (throttle, load, fuel trims), and horizontal bars (coolant, intake air temp, airflow, manifold pressure, timing advance, O2 sensors, battery), plus open or closed loop status. On connect, WOBD asks the car which PIDs it supports (mode 01 PID 00) and only shows those gauges.
- **Trouble code search** (`codes.html`): type a code like P0601 and Bob explains it, offline. You can enter your car's year, make, and model so the Google search link is specific to it. It covers about 9,500 generic SAE codes (P0, P2, P34, U0, U3, B0, C0). Manufacturer-specific codes (P1, P30-P33) get a message saying so instead of a guess. Bob's own hand-written notes win over the general database wherever both exist.
- **Tested adapters** (`tested-adapters.html`): personal adapter test results loaded from `data/tested-adapters.json`.
- **Installable and offline**: WOBD is a PWA. After the first load, the app shell works without a connection.

> **Status:** in active testing and development. Results aren't guaranteed yet.

## What you need

- An OBD-II car (US model year 1996 and newer)
- A USB ELM327-compatible adapter
- Chrome, Edge, or Opera on desktop, or Chrome on ChromeOS (Web Serial is required)

## Run it locally

WOBD is a static site with no build step. Serve the folder over localhost, which Web Serial treats as secure:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

### Offline and installing

The service worker (`sw.js`) only registers on HTTPS or localhost. It caches static files only (pages, CSS, JS, and the code databases). Web Serial talks to the adapter directly and never goes through it, so caching can't affect the connection.

Cached files are served first, so to ship an update, bump `CACHE_VERSION` in `sw.js` and add any new files to `APP_SHELL`. Returning users get the new version, and old caches are deleted. The version shown in every page's footer is `WOBD_VERSION` in `js/version.js`; bump it with each release.

### Vehicle models

The Model dropdown comes from `data/models.json`, built from NHTSA's vPIC API. Run `node scripts/update-models.mjs` to refresh it. A GitHub Actions workflow does this every Monday and commits the result. If you add a `CLOUDFLARE_API_TOKEN` repository secret, it also deploys.

### Generic code database

`data/generic/` is built from [OBDex](https://github.com/foerbsnavi/OBDex), an open code database released under CC0. Its descriptions and causes are general and technical, so Bob labels them as such. To refresh it, run `npm install` once, then `node scripts/update-generic-codes.mjs`.

### Demo mode

Try the whole flow without a car or adapter:

| URL | Pretend car |
| --- | --- |
| `/?demo` | CAN car with codes P0301, P0171, P0442 |
| `/?demo=iso` | Older ISO 9141 car (like a 2001 PT Cruiser) with P0420 and P1491, no VIN |
| `/?demo=clear` | No trouble codes |
| `/?demo=slowbaud` | Runs baud rate detection: silent on the first three speeds, answers on the fourth. Shows the progress bar and Cancel |
| `/?demo=nobaud` | Detection fails, so Bob shows the Retry form. Pick any speed and it connects |

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `guide.html`, `codes.html`, `tested-adapters.html` | The app, the How to use page, code search, and tested adapter results |
| `manifest.webmanifest`, `sw.js`, `js/pwa.js` | PWA manifest, service worker, and its registration |
| `img/icons/` | App icons |
| `css/` | Theme and layout (`style.css`), print report (`print.css`) |
| `js/serial.js`, `js/elm327.js`, `js/obd.js` | Web Serial, the ELM327 command queue, OBD-II decoding |
| `js/smartbauder.js` | Finds the adapter's baud rate with a quick ATI probe, ordered by USB chip and remembered per adapter (test: `node scripts/test-smartbauder.mjs`) |
| `js/bob.js`, `js/voice.js` | Bob's explanations and optional read-aloud voice |
| `js/codes.js` | The code search page |
| `js/tested-adapters.js`, `data/tested-adapters.json` | Render and store the tested adapter results |
| `js/ui.js`, `js/app.js` | Rendering (including the gauges) and app wiring |
| `js/demo.js` | Pretend adapter for demo mode |
| `data/codes.json` | Bob's code book (detailed explanations) |
| `data/models.json` | Models per make for the car form, generated from NHTSA vPIC |
| `scripts/update-models.mjs` | Refreshes `data/models.json` and bumps `CACHE_VERSION` |
| `.github/workflows/update-models.yml` | Runs that script weekly and commits any change |
| `data/generic/` | Generic code definitions, one file per family (P0, P2, ...), built from OBDex |
| `scripts/update-generic-codes.mjs` | Rebuilds `data/generic/` (run `npm install` first) and bumps `CACHE_VERSION` |

## Contributing code explanations

Each entry in `data/codes.json` needs a `title`, a plain-English `plain` line under 40 words, an `urgency` (`low`, `medium`, or `high`), a few `causes` (cheapest first), a `difficulty` (`diy`, `moderate`, or `shop`), and a `tellMechanic` line. Write explanations in your own words.

## License

GPL v3. See [LICENSE](LICENSE).

WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.
