# WOBD: Web On-Board Diagnostics

A free, browser-based car diagnostic tool. Plug a USB OBD-II adapter into a Chromebook or laptop, open the site, and read your car's trouble codes with nothing to install. Bob, a scripted cartoon mechanic, explains each code in plain English.

## Features

- **Scan and clear codes**: see the check-engine-light status and stored trouble codes; select a code for Bob's explanation. Clearing requires confirmation and resets emissions readiness monitors.
- **Live data dashboard**: gauges show supported readings such as RPM, speed, throttle, load, fuel trims, temperatures, airflow, pressure, timing, oxygen sensors, fuel-system status, and adapter voltage. WOBD asks which engine PIDs the car supports and displays only those readings.
- **Adapter details**: see the detected protocol, car-response status, adapter voltage, and adapter identification. Automatic baud-rate detection has a manual retry option for adapters that need a specific speed.
- **Trouble code search** (`codes.html`): type a code like P0601 and Bob explains it offline, without an adapter. The offline catalog includes about 9,500 generic SAE codes; Bob's hand-written notes take precedence where available. Manufacturer-specific codes are identified rather than guessed. An optional year, make, and model personalize the external Google search link.
- **Print reports**: print or save a scan report as PDF, including vehicle details, VIN when available, code urgency, explanations, causes, and mechanic notes.
- **Optional read-aloud**: Bob can read his speech bubble using the browser's speech synthesis when available.
- **Tested adapters** (`tested-adapters.html`): personal adapter test results loaded from `data/tested-adapters.json`.
- **Installable and offline**: WOBD is a PWA. After the first load, the scanner and bundled code search work offline. Scan data stays in the browser; only a search you choose to open leaves the site.

> **Status:** in active testing and development. Results aren't guaranteed yet.

## What you need

- An OBD-II car (US model year 1996 and newer)
- A USB ELM327-compatible adapter
- A laptop or Chromebook with Chrome, Edge, or Opera. Web Serial is required; phones and tablets are not supported.
- An HTTPS connection, or localhost when running locally.

## Run it locally

WOBD is a static site with no build step. Serve the folder over localhost, which Web Serial treats as secure:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

### Offline and installing

The service worker (`sw.js`) only registers on HTTPS or localhost. It caches static files only (pages, CSS, JS, and the code databases). Web Serial talks to the adapter directly and never goes through it, so caching can't affect the connection. The scanner and code search can use bundled data offline after the first load; the year/make/model Google search link needs an internet connection.

Cached files are served first, so to ship an update, bump `CACHE_VERSION` in `sw.js` and add any new files to `APP_SHELL`. Returning users get the new version, and old caches are deleted.

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
| `js/conninfo.js` | Adapter and vehicle connection details |
| `js/bob.js`, `js/voice.js` | Bob's explanations and optional browser read-aloud |
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

Each entry in `data/codes.json` needs a `title`, a plain-English `plain` line under 40 words, an `urgency` (`low`, `medium`, or `high`), a few `causes` (cheapest first), a `difficulty` (`diy`, `moderate`, or `shop`), and a `tellMechanic` line. Write explanations in your own words. The code search identifies manufacturer-specific P codes (P1 and P30-P33) and B, C, or U codes in the 1xxx and 2xxx ranges rather than giving them a generic definition.

## License

GPL v3. See [LICENSE](LICENSE).

WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.
