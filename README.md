# WOBD: Web On-Board Diagnostics

A free, browser-based car diagnostic tool. Plug a USB OBD-II adapter into a Chromebook or laptop, open the site, and read your car's trouble codes with nothing to install. Bob, a scripted cartoon mechanic, explains each code in plain English.

## Features

- **Scan and clear codes**: Bob explains stored, pending, and permanent trouble codes in plain English, and identifies the reporting ECU when the adapter provides it. Clearing requires confirmation and resets emissions readiness monitors.
- **Live data dashboard**: a gauge cluster with radial dials (RPM, speed), vertical bars (throttle, load, fuel trims), and horizontal bars (temperatures, airflow, pressure, timing, O2 sensors, voltage, and distance), plus open or closed loop status. On connect, WOBD follows the car's Mode 01 support bitmaps and offers manual selection or automatic, priority-based monitoring. Its parameter catalog distinguishes reported support from decoder availability; standardized OBD-II data is not a complete inventory of physical sensors.
- **Adapter details**: see the detected protocol, car-response status, adapter voltage, and adapter identification. Automatic baud-rate detection has a manual retry option for adapters that need a specific speed.
- **Protocol troubleshooting**: automatic protocol selection is the default; an optional per-connection override can force a specific OBD protocol for troubleshooting.
- **Feedback during updates**: the home-page update banner links to a contact page with a Google Form for issue reports and feedback.
- **Trouble code search** (`codes.html`): type a code like P0601 and see its details offline, without an adapter. Browse generic families and manufacturer-specific codes in a filterable directory that loads results in small batches; selecting a code opens its details in a modal. A counter shows the total codes in the library (from `data/code-counts.json`; regenerate with `node scripts/build-code-counts.mjs` after refreshing code data). Curated generic codes keep their dedicated pages. The offline catalog includes about 9,500 generic SAE codes; Bob's hand-written notes take precedence where available. Manufacturer-specific codes are identified rather than guessed. An optional year, make, and model personalize the external Google search link.
- **Replay and demos** (`replay.html`): replay a local CSV recording in the browser, or use the scanner's Demos section to explore simulated scenarios without an adapter.
- **Print reports**: print or save a scan report as PDF, including vehicle details, VIN when available, code urgency, explanations, causes, and mechanic notes.
- **Languages and units**: switch between English, French, German, Spanish, Japanese, and Simplified Chinese (machine translated, labelled as such), and show km/h and °C instead of mph and °F. Both settings stay in your browser and work offline.
- **Optional read-aloud**: Bob can read his speech bubble using the browser's speech synthesis when available.
- **Tested adapters** (`tested-adapters.html`): personal adapter test results loaded from `data/tested-adapters.json`, browsed by adapter, then make, with filters.
- **Installable and offline**: WOBD is a PWA. After the first load, the scanner and bundled code search work offline. Scan data stays in the browser; only a search you choose to open, or a VIN lookup you agree to, leaves the site.

### WOBD v1.92 release notes

- New Credits page (`credits.html`, linked in every footer via `js/version.js`) crediting [kierandrewett/obd](https://github.com/kierandrewett/obd) and [foerbsnavi/OBDex](https://github.com/foerbsnavi/OBDex/) and their authors.
- Tested adapters page redesigned: adapter list, then make list, then a vehicle table for that make with year, model, protocol, and notes filters. It is built from `data/tested-adapters.json`, so new tests appear automatically.

### WOBD v1.91 release notes

- Fixed the Replay file picker greying out `.wobd` files on iPhone and Android. Any recording (`.wobd` or CSV) can now be chosen on any device; the file type is detected from its contents.

### WOBD v1.9 release notes

- Code Search redesign: a wider page with a filterable directory of generic families and manufacturer makes, code details in a modal, and a live counter of the 21,886 codes in the library. Bob now appears only on the scanner page.
- Manufacturer-specific descriptions: 12,353 make-specific mappings across 37 makes, imported from [kierandrewett/obd](https://github.com/kierandrewett/obd) (MIT) with `node scripts/update-manufacturer-codes.mjs`; counts regenerate with `node scripts/build-code-counts.mjs`.

### WOBD v1.81 release notes

- Fixed Replay gauges showing their unit twice (for example `189 °F°F`) during playback.

### WOBD v1.8 release notes

- Languages: a top-bar selector for English, French, German, Spanish, Japanese and Simplified Chinese. The core app (Scanner, Bob, Live data, Replay, the session report, errors and Bob's spoken voice) is translated, along with Bob's 66 code explanations. Translations are machine drafts, labelled "AI" with a notice, and not yet reviewed by native speakers. The guide, tested adapters, changelog, contact and `/codes` pages stay English. Everything works offline, the choice stays in your browser, and browser language only suggests a switch. A separate Units setting shows km/h and °C without changing recordings or exports. Strings live in `data/i18n/` (built by `node scripts/build-i18n.mjs`; `node scripts/test-i18n.mjs --require-all`).
- Replay "Print session report": a multi-page, printable (or Save as PDF) report of a recording with cover facts, a readings summary (lowest, highest, average for numeric gauges), gap-aware overview graphs, every detected pattern with evidence and a context chart, the notes you tick, and a methods section. It never includes the VIN or any location, and is built in your browser (`node scripts/test-session-report.mjs`).

- `.wobd` files: Replay can open them, and "Save as .wobd" turns a CSV into one compact, checksummed file that keeps every row, unknown parameters, your notes, and (by default) the original CSV byte for byte. Saved or interrupted backups can also be downloaded as `.wobd`. CSV still works as before. Format: [Docs/WOBD-Format-Spec.md](Docs/WOBD-Format-Spec.md) (`node scripts/test-wobd.mjs`).
- Optional browser backup while recording: tick "Keep a backup copy in this browser" and an interrupted drive can be recovered next visit (download or delete, never auto-resumed). Copies are kept 30 days, stored only in your browser, with storage warnings (`node scripts/test-flight-store.mjs`).
- Replay "Detected patterns": WOBD flags RPM changes at steady speed, open/closed-loop changes, adapter communication loss, and suspected stalls using fixed, conservative rules. Each shows why it was flagged, can be dismissed or classified (kept with the evidence), and is stored separately from your notes. Replay only (`node scripts/test-detectors.mjs`).
- Replay notes: add your own marks to a recording (engine hesitation, stop sign, ignition off, refueling, road condition, or a custom label, with an optional comment). They show as ticks on the graphs, are saved in this browser only, and can be exported or imported as `annotations` JSON. They are tied to the recording's content, never change the CSV, and WOBD asks before applying notes made for a different recording (`node scripts/test-annotations.mjs`).
- Replay now shows the local date and time of the playhead, a zoom and pan timeline with an overview bar, shaded connection gaps, per-reading sample ages, and a Recording quality panel that flags blank, malformed, duplicate, out-of-order, and clock-jump timestamps without changing any rows.
- The gauge picker says when fuel level isn't available through standard OBD-II on your car. Fuel level is shown as the raw ECU value, with no smoothing, and replays correctly from recordings (including older CSVs).
- The VIN is left off the printed DTC report by default. When the car reports one, an "Unhide VIN in the printed report" checkbox appears (unchecked every connection) so it only prints on purpose.
- A definitive adapter bus error (`CAN ERROR`, `BUS ERROR`, `FB ERROR`) on the first request now ends connecting at once and shows Bob's connection message, instead of carrying on with fallback gauges. The simulator answers a forced CAN protocol on a non-CAN car with `CAN ERROR`, and the PT Cruiser automatic-vs-forced case is covered in `scripts/test-simulator.mjs`.
- Vehicle identification from the VIN (F1). When the car reports a VIN, Bob offers to look it up at NHTSA's free vPIC decoder to fill in year, make, and model. It asks every time before the VIN leaves the device, shows the result as "Is this your car?" (Yes or "No, I'll pick it"), and never locks the selectors. The VIN is validated first (17 characters, no I/O/Q, check digit for North American VINs; conflicting ECU replies are rejected), and a missing, malformed, offline, or declined lookup leaves the manual lists as they are. "Remember this car" is optional and stores only year, make, and model in this browser, with a "Forget saved car" button. The VIN is never saved. Demo cars never trigger a lookup. Logic is in `js/vin.js` (`node scripts/test-vin.mjs`).

### WOBD v1.72 release notes

- `node scripts/make-report-graph.mjs --all` draws each test's graph PNG from its recording CSV (or pass one CSV with `--title` and `--out`), so all report graphs share one layout: speed/RPM, fuel trims, O2 sensors, catalyst temperature, airflow/throttle/load, and temperatures/voltage, with panels the car didn't report skipped and engine-off gaps shaded. It needs `npm install` (`@resvg/resvg-js`) and looks best with the DejaVu Sans font installed (`node scripts/test-report-graph.mjs`). The old Claude/GPT-made graphs were replaced and their `graphNote` credits removed.

### WOBD v1.71 release notes

- Every export names the WOBD version that made it, taken from `js/version.js` (the only place a version is written; helpers in `js/version-info.js`). CSV recordings begin with a `# WOBD v1.71` line before the header (Replay skips it and shows the version; older files without it still replay, but recordings made now won't open in WOBD before 1.71). Adapter traffic logs and DTC reports include it too.
- `node scripts/update-report-versions.mjs` reads versions from each test's CSV and traffic log into `reports.versions` in `data/tested-adapters.json`. A hand-set `wobdVersion` is a manual override and always wins (used for the PT Cruiser, 1.0, and the Highlander, 1.51); PDFs can't be read, so they rely on an override. The tested adapters table and report pages show the result and mark overrides.
- Ideas for letting users submit reports are in `Docs/Community-Report-Submissions.md` (design notes only, not built).

### WOBD v1.7 release notes

- Connection failures are explained by type (adapter missing or silent, car silent, no data, bus error, unreadable reply, rejected command) in `js/troubleshoot.js`. The adapter's own wording, such as `CAN ERROR`, is shown and logged. A failed forced protocol is named and Bob recommends automatic selection first; with a year/make/model entered, a user-initiated protocol search link is offered (test: `node scripts/test-troubleshoot.mjs`).
- Fuel tank level (PID `0x2F`, `100 × A / 255`) is a live gauge when the car advertises it.
- The home-page development banner has a close button; the choice is remembered per release in `localStorage` (`js/banner.js`).

### WOBD v1.6 release notes

- Every trouble code Bob has hand-written notes for now has its own page at `/codes/<code>` (for example `/codes/p0340`), listed on Code Search, with a `sitemap.xml`, `robots.txt`, canonical links, and structured data so search engines can index them. The home page gains a static intro and FAQ. Regenerate the pages with `node scripts/build-code-pages.mjs` after editing `data/codes.json`.
- New `changelog.html` lists every release; the version in each page footer links to it.
- Added decoders for wideband O2 sensors (`0x24`, `0x34`) and absolute EVAP pressure (`0x53`).
- Tested adapters are organized as `reports/<adapter>/<make>/<year>/<model>/`, with a 2010 Highlander test added (graph, recording, and adapter traffic log). Reports and the tested-adapters table explain untested features with (i) popovers.
- Recordings add `raw`, `mode`, and `ecu` columns: each reply's data bytes (hex), the service (`01`), and the responding ECU when the adapter reports it. A reply WOBD couldn't decode keeps an empty `value` and its raw bytes, and Replay decodes it from those bytes when a decoder exists. Second values in one reply (wideband voltage/current) are rows like `0x24.2`. Older CSVs without these columns still replay.
- "Record undecoded parameters (raw)" is off by default. Turning it on opens an acknowledgement dialog (shown every time), and the setting is locked while recording. Undecoded PIDs are then sampled one at a time as raw-only rows, one row per responding ECU: every round when stopped (0 mph), every 3 rounds at low speed, every 6 rounds when driving or when speed is unavailable or stale. A time budget keeps raw reads to a small share of polling, so regular gauges keep priority (tests: `node scripts/test-raw-capture.mjs`).

### WOBD v1.5 release notes

- Updated navigation and demo layout.
- Replay imports CSV recordings incrementally with a 128 MiB file limit.
- Replay charts downsample for display while retaining the original readings for playback and hover; isolated spikes are preserved and detected visual gaps are not connected.

### WOBD v1.51 release notes

- Replaced the header diamond with the new WOBD logo and updated the page favicon.

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

The service worker (`sw.js`) only registers on HTTPS or localhost. It caches static files only (pages, CSS, JS, and the code databases). Web Serial talks to the adapter directly and never goes through it, so caching can't affect the connection. The scanner, code search, and Replay page are available offline after the app shell has been cached; opening Replay still requires a local CSV file or a bundled sample. The year/make/model Google search link needs an internet connection.

Cached files are served first, so to ship an update, bump `CACHE_VERSION` in `sw.js` and add any new files to `APP_SHELL`. Returning users get the new version, and old caches are deleted. The version shown in every page's footer is `WOBD_VERSION` in `js/version.js`; bump it with each release. Feedback submitted on the contact page is sent through Google Forms, not stored by WOBD.

### Vehicle models

The Model dropdown comes from `data/models.json`, built from NHTSA's vPIC API. Run `node scripts/update-models.mjs` to refresh it. A GitHub Actions workflow does this every Monday and commits the result. If you add a `CLOUDFLARE_API_TOKEN` repository secret, it also deploys.

### Generic code database

`data/generic/` is built from [OBDex](https://github.com/foerbsnavi/OBDex), an open code database released under CC0. Its descriptions and causes are general and technical, so Bob labels them as such. To refresh it, run `npm install` once, then `node scripts/update-generic-codes.mjs`.

### Manufacturer-specific code database

`data/manufacturer/` is refreshed from the per-make JSON files in [kierandrewett/obd](https://github.com/kierandrewett/obd/tree/main/dtc_codes) by running `node scripts/update-manufacturer-codes.mjs`. The updater keeps only manufacturer-specific DTC ranges, preserves the upstream MIT license notice, updates the offline app shell, and reports the current entry count. In the initial import, the 37 make files contained 17,060 mappings total; 12,353 were in manufacturer-specific ranges, covering 4,025 distinct code numbers. This is less than the repository README's 21,000+ headline, so use the updater's reported count for later refreshes. The repository says its descriptions were collected from [dot.report](https://dot.report/dtc/). Code Search now browses generic codes by family and manufacturer-specific codes by make; selecting a code opens its details in a modal.

### Demo mode

Try the whole flow without a car or adapter:

| URL | Pretend car |
| --- | --- |
| `/?demo` | CAN car with codes P0301, P0171, P0442 |
| `/?demo=pending` | CAN car with pending P0301 and permanent P0442 |
| `/?demo=twomodules` | J1850 car where two modules answer; scan results get a tab per module |
| `/?demo=iso` | Older ISO 9141 car (like a 2001 PT Cruiser) with P0420 and P1491, no VIN |
| `/?demo=clear` | No trouble codes |
| `/?demo=slowbaud` | Runs baud rate detection: silent on the first three speeds, answers on the fourth. Shows the progress bar and Cancel |
| `/?demo=nobaud` | Detection fails, so Bob shows the Retry form. Pick any speed and it connects |
| `/?demo=sim` | The car follows the year, make, and model in the header, read when you click Connect. Preset them with `&year=2001&make=Ford&model=Ranger`, `&codes=none`, `&codes=few`, `&codes=brand`, or `&noauto` |

The pretend adapter behaves like a real ELM327 about protocols: it only reaches the car when `ATSP` matches the car's protocol (or is `0` for automatic), and otherwise answers `UNABLE TO CONNECT`. That makes every demo a way to test the protocol override.

### Simulator

`simulator.html` lets you pick any year, make, and model and connect to a pretend car for it, then shows every command and reply. `js/vehicles.js` maps year, make, and model to a protocol (for example, a 2001 Ford Ranger is J1850 PWM and a 2015 Honda Civic is CAN). These are rules of thumb, so add a `MODEL_RULES` entry when a real car differs. "Automatic protocol search fails" makes the car connect only with the right override. Test: `node scripts/test-simulator.mjs`.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `guide.html`, `codes.html`, `tested-adapters.html` | The app, the How to use page, code search, and tested adapter results |
| `credits.html` | Credits for the code data sources and their authors |
| `manifest.webmanifest`, `sw.js`, `js/pwa.js` | PWA manifest, service worker, and its registration |
| `img/icons/` | App icons |
| `css/` | Theme and layout (`style.css`), print report (`print.css`) |
| `js/serial.js`, `js/elm327.js`, `js/obd.js` | Web Serial, the ELM327 command queue, OBD-II decoding |
| `js/i18n.js`, `js/i18n-boot.js`, `js/units.js`, `data/i18n/` | Language engine, boot loader, display units, and the translation bundles (`en.json` is built from `scripts/i18n-src/*.json`; `codes.<lang>.json` hold Bob's translated code notes) |
| `js/smartbauder.js` | Finds the adapter's baud rate with a quick ATI probe, ordered by USB chip and remembered per adapter (test: `node scripts/test-smartbauder.mjs`) |
| `js/conninfo.js` | Adapter and vehicle connection details |
| `js/bob.js`, `js/voice.js` | Bob's explanations and optional browser read-aloud |
| `js/codes.js` | The code search page |
| `js/tested-adapters.js`, `data/tested-adapters.json` | Render and store the tested adapter results |
| `reports/` | Test files, organized as `reports/<adapter>/<make>/<year>/<model>/` (for example `reports/vlinker-fs-usb/toyota/2010/highlander/`) and linked from `data/tested-adapters.json` |
| `js/ui.js`, `js/app.js` | Rendering (including the gauges) and app wiring |
| `js/site-nav.js` | Active state for the shared site navigation |
| `js/demo.js` | Pretend adapter for demo mode and the simulator |
| `simulator.html`, `js/simulator.js`, `js/vehicles.js` | Simulator page and the year/make/model to protocol rules |
| `data/codes.json` | Bob's code book (detailed explanations) |
| `codes/`, `sitemap.xml`, `scripts/build-code-pages.mjs` | Generated static page per code in `data/codes.json`, the sitemap, and the list in `codes.html` (test: `node scripts/test-code-pages.mjs`). `robots.txt` points to the sitemap |
| `changelog.html` | Release history; add an entry with each release |
| `data/models.json` | Models per make for the car form, generated from NHTSA vPIC |
| `scripts/update-models.mjs` | Refreshes `data/models.json` and bumps `CACHE_VERSION` |
| `.github/workflows/update-models.yml` | Runs that script weekly and commits any change |
| `data/generic/` | Generic code definitions, one file per family (P0, P2, ...), built from OBDex |
| `scripts/update-generic-codes.mjs` | Rebuilds `data/generic/` (run `npm install` first) and bumps `CACHE_VERSION` |

## Contributing code explanations

Each entry in `data/codes.json` needs a `title`, a plain-English `plain` line under 40 words, an `urgency` (`low`, `medium`, or `high`), a few `causes` (cheapest first), a `difficulty` (`diy`, `moderate`, or `shop`), and a `tellMechanic` line. Write explanations in your own words. After editing, run `node scripts/build-code-pages.mjs` to regenerate the static code pages and sitemap. The code search identifies manufacturer-specific P codes (P1 and P30-P33) and B, C, or U codes in the 1xxx and 2xxx ranges rather than giving them a generic definition.

## License

GPL v3. See [LICENSE](LICENSE).

WOBD gives general information, not a professional diagnosis. Always confirm a problem before replacing parts.
