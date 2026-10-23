# WOBD Advanced Diagnostics — Progress Checklist

This is the implementation tracker for [Advanced-Diagnostics-Plan.md](./Advanced-Diagnostics-Plan.md). The roadmap describes the intended behavior and rationale; this file records implementation and verification status. Design approval, feasibility prototypes, and planned tests do not count as completed application functionality.

Update this checklist whenever an implementation stage is completed. Keep acceptance items unchecked until they are implemented and verified.

## Current Status / Where to Resume

- **Latest completed milestone:** v1.8 (F1, F2 bus-error handling, F4–F6, F8 and F9: VIN lookup, detectors and notes, `.wobd`, session report, six languages and units). Before that v1.72 (report graphs generated from recordings by `scripts/make-report-graph.mjs`). Before that v1.71 patch (exports stamped with the WOBD version; report pages read it from the files). Before that v1.7 (F2 connection troubleshooting, F3 fuel level, dismissible banner). v1.6 added static code pages and SEO; v1.51 branding was `a07930b`.
- **Current application label:** WOBD v1.8 (previously v1.72, v1.71, v1.7, before that v1.51; v1.5 had been released from `2a77544`).
- **Current focus:** v1.8 is released. Remaining: F7 location (its own release) and F11 freeze-frame.
- **Chromebook result:** User confirmed the native Chrome file picker, large CSV playback, offline Replay, navigation, simulator, and USB Web Serial tests passed on the named preview. No quantitative device performance or memory measurements were reported.
- **Release note:** `README.md` contains a v1.5 changelog limited to implemented UX and Replay functionality.

## Established Baseline and Prior Audit Stages

- ✅ Existing Web Serial / ELM327 serialized request pipeline retained.
- ✅ Existing CSV live-data recording and export retained.
- ✅ Existing Replay CSV viewing and recording-time driving lock retained.
- ✅ Existing DTC scan print report retained.
- ✅ Source-aware PID discovery and ECU-source handling implemented; `scripts/test-supported-pids.mjs` passes (24 cases in the latest run).
- ✅ Expanded decoder registry and supported/undecoded parameter catalog present; supported-PID regression suite passes.
- ✅ Prioritized live polling and selectable gauge modes present in the application.
- ✅ Per-service / per-module DTC views and MIL handling present; `scripts/test-dtc.mjs` passes (12 cases in the latest run).
- ✅ Existing adapter error classification and manual protocol override retained.
- ✅ UX/navigation redesign milestone completed (`7040ebd`); navigation regression passes.
- ➖ Re-validate live polling cadence on both a legacy J1850 and a modern CAN vehicle.
- ➖ Implement Mode 02 freeze-frame retrieval (F11).
- ➖ Complete broader CAN hardware validation and update support claims from real results.

## F1 — VIN-Assisted Vehicle Identification

- ✅ Existing startup `0902` VIN probe is present; this is a baseline capability, not the proposed vehicle-match flow.
- ✅ Validate VIN payloads for legacy and CAN multi-frame responses; reject malformed or conflicting ECU VINs (`js/vin.js`: 17 chars, no I/O/Q, check digit for North American VINs, per-ECU grouping).
- ✅ Decision: NHTSA vPIC only, after a consent prompt every time; no offline decoder. Explicit "Is this your car?" confirmation (Yes / No, I'll pick it).
- ✅ Manual year/make/model selection is preserved on `NO DATA`, malformed VIN, conflict, lookup failure, offline, or decline; the lookup runs after connect and never delays it. Skipped when the form is already filled and for demo cars.
- ✅ Optional saved car stores year/make/model only (never the VIN) in `localStorage`, with a "Forget saved car" control. ✅ The DTC print report hides the VIN by default; an "Unhide VIN in the printed report" checkbox (unchecked each connection) opts in. ➖ Not yet browser-verified.
- ✅ `scripts/test-vin.mjs` (14 cases) covers success, malformed/short/multi-ECU/conflict data, vPIC parsing, HTTP and network failure, and saved-car privacy; dialogs and restore/forget were exercised in a browser. ➖ Not tested end to end with a real adapter connecting to a car that reports a VIN (the Highlander is the candidate), and Escape-to-dismiss was not driven in the automation.

## F2 — Connection Troubleshooting and Protocol Guidance

- ✅ Existing adapter/serial/OBD error classification and protocol override remain available.
- ✅ Explain adapter failure, ECU nonresponse, `NO DATA`, `CAN ERROR`, bus error, timeout, and parse failure distinctly in Bob's context-sensitive guidance (`js/troubleshoot.js`, `scripts/test-troubleshoot.mjs`, 9 cases).
- ✅ On override failure, show the protocol by name and recommend automatic selection before external research.
- ✅ Add an encoded, user-initiated vehicle/protocol search link; do not treat search snippets as authoritative.
- ✅ Safe retry/reset and `ATSPx` / `ATDPN` behavior verified against the simulator: every connect starts with `ATZ`, the override sends the chosen `ATSPx`, `ATDPN` shows `A2` for automatic and the bare number for a forced protocol. A definitive `CAN ERROR` / `BUS ERROR` / `FB ERROR` on the first `0100` now stops connecting immediately (it was being swallowed, so the app carried on with extra requests and never showed the F2 message); `BUS BUSY` and `BUFFER FULL` still fall back. `ATDP`/`ATDPN` are still only queried after `UNABLE TO CONNECT`.
- ✅ PT Cruiser case reproduced in the simulator (`test-simulator.mjs`): automatic `ATSP0` connects as `A2`; forced `ATSP6` gives `CAN ERROR` and Bob's message names the protocol and recommends automatic first. ➖ Still open: the simulator's forced-CAN `CAN ERROR` is modelled from the earlier PT Cruiser observation, not a captured trace; a real vLinker trace of the forced-`ATSP6` failure would close this. The v1.1 Ranger failure stays unverified for current versions.

## F3 — Fuel-Level PID and Related Parameters

- ✅ Add Mode 01 PID `2F` only when advertised and response-validated; decode `100 × A / 255` (`LIVE_PIDS`; tests cover 0 / 255 / mid-scale, wrong lengths, and no data).
- ✅ Provenance, units, sample time, and availability are kept: each CSV row carries the PID (`0x2F`), name, unit (`%`), timestamp, and raw bytes for undecodable replies; malformed or missing replies are skipped, never guessed. Fuel is not inferred from trims or the dash gauge.
- ✅ Decision: no display smoothing. Gauges and recordings show the raw ECU value, so nothing needs labeling.
- ✅ Decision: no manual fuel note. When the car doesn't offer `2F`, the gauge picker says "Fuel level: not available through standard OBD-II on this car."
- ✅ Tests: 0 / 255 / mid-scale, unsupported, and malformed responses (`test-supported-pids.mjs`); recording first/last sample, dropouts, and legacy 6-column CSV with fuel (`test-replay.mjs`). ➖ Not verified on real hardware: whether the user's vehicles actually advertise `2F`.

## F4 — Replay Timeline and Review Workspace

### Completed Replay foundations

- ✅ Existing CSV playback remains supported.
- ✅ Streaming CSV parser reads incrementally, handles quote/escape and line-ending boundaries, and preserves `parseRecording(text)` compatibility (`e36ec00`).
- ✅ Import limit raised to 128 MiB (`e36ec00`).
- ✅ Replay chart render-time first/min/max/last downsampling implemented; source readings remain unchanged (`03846df`).
- ✅ Per-PID visual gap threshold uses `max(10,000 ms, 5 × median positive interval)` with bounded median sampling; visual gaps break chart lines and are not diagnostic events (`03846df`).
- ✅ Cached chart views are reused during playback; exact gauge, playhead, and hover values continue to use raw readings.
- ✅ Tests cover spikes/dips, flat and sparse data, equal timestamps, out-of-order input, gaps, cache reuse, frozen raw data, and >500,000 readings (`scripts/test-replay-downsample.mjs`, 23 cases).
- ✅ Controlled integrated-browser file-input test imported the synthetic 7-hour / 756,000-reading / 64.5 MB CSV; isolated-spike and gap-band screenshots were visually inspected. This does not complete the native Chrome chooser or ChromeOS checks.

### Still planned

- ✅ Elapsed and local date/time for the selected sample are shown beside the playback time (recorded instant converted to this device's zone, labeled with the zone name). Files with no usable timestamp show "Clock time not recorded" and no date is invented; zone-less timestamps are labeled "assumed local".
- ✅ Timeline: zoom out / in buttons, "Whole drive" reset, a pan slider, and an overview bar showing the visible window, the playhead, and connection gaps. Zoom stays at least 10 s wide, and the window follows the playhead during playback. Graphs clip to the plot and keep raw readings untouched.
- ✅ Connection gaps (no PID of any kind answered for `max(10 s, 5 × median interval)`) are shaded on every graph and listed in text, with a note that a gap doesn't say why. ➖ Known/user-annotated engine-off intervals wait for annotations.
- ✅ Per-PID sample ages at the playhead ("How old is each reading?").
- ✅ Timestamp data-quality flags (blank, malformed, duplicate, out-of-order, clock jump/drift) with counts and the first affected data row, shown in a "Recording quality" panel; no source row is changed or dropped. Elapsed-only files are noted.
- ✅ Relative-only and absolute-timestamp legacy CSVs map correctly (`test-replay-time.mjs`, 13 cases, plus the existing replay suites).
- ✅ Annotation-only notes on the Replay page (panel under the graphs): presets (engine hesitation, stop sign, intentional ignition off, refueling, road condition) plus a custom label, with an optional comment. Notes are keyed to session-relative time (`t_rel`) and to a content fingerprint (readings, duration, start, hash of every time/value), never to the file name, and the CSV is never modified. They show as amber ticks on every graph and the overview bar, click to jump, delete individually.
- ✅ Notes save in browser storage; Export writes `<name>-notes.json`, Import validates the format, caps size/count/text, and asks before applying notes made for a different recording (`js/annotations.js`, `test-annotations.mjs`, 13 cases). Blocked or full storage is reported and notes stay in memory.
- ✅ Automatic detections are kept out of notes by design (they arrive with F5 as a separate list).
- ➖ Notes attach to a single moment, not a range. Known/user-annotated engine-off *intervals* would need ranges; `ignition-off` notes are the marker for now.
- ➖ Browser-checked: add/validate/reload persistence, jump, delete, import, and the mismatch prompt. Not checked: the Export download itself (the integrated browser doesn't surface downloads; the JSON round-trip is unit-tested).
- ➖ Order-only (no `elapsed_ms`) files: not supported today (the importer requires `elapsed_ms`).
- ➖ Test DST transitions, seek/zoom on slow devices, and the native file chooser. Browser-checked only in the integrated browser: the PT Cruiser replay, zoom/pan/overview, and a synthetic gap file.

## F5 — Automatic Anomaly and Event Detection

Pass 1 covers four detectors, run on Replay only (no live alerts), with fixed conservative thresholds and no sensitivity selector. Code: `js/detectors.js`; tests: `scripts/test-detectors.mjs` (22) and `scripts/test-annotations.mjs`.

- ✅ Detectors: RPM change at steady speed, open/closed-loop changes (plus fault and flapping), adapter communication loss, and suspected stall.
- ➖ Trim, temperature, voltage, and sensor-dropout detectors are not built. Deliberately left out of pass 1.
- ✅ Detections require fresh samples, dwell time, hysteresis-style merging, single-sample spike rejection, and speed/throttle context.
- ✅ Each event stores evidence readings, exact time range, PID keys, thresholds, and detector version.
- ✅ Automatic events live in a separate "Detected patterns" panel, not in notes.
- ✅ Dismiss or classify (normal, known issue, real problem) without deleting evidence. Reviews are saved in the same browser entry and travel in the notes export/import file.
- ✅ Authored, cautious explanations; routine events are hidden behind a checkbox.
- ✅ No-stall rule: a gap alone is reported as communication loss, never a stall. Suspected stall needs fresh RPM dropping to zero while other gauges still answer.
- ✅ Tests cover shifts, spikes, irregular intervals, stale data, gaps, engine-off stops, and hybrids.
- ➖ Browser-verified in the integrated browser only on the Highlander recording (routine toggle, classification, persistence across reload; no console errors). The real PT Cruiser recording produced no events. RPM-swing, stall, and comm-loss events were only unit-tested, not seen on a real recording or on hardware.

## F6 — Flight Recorder, Resilience, and Export

### Existing functionality

- ✅ Existing in-memory live-data CSV capture/export and recording driving lock remain in place; recorder regression passes (21 cases in the latest run).

### Part A — browser backup (IndexedDB), implemented, not released

Opt-in checkbox "Keep a backup copy in this browser while recording". Code: `js/flight-store.js` (storage logic), `js/backup.js` (page glue); tests: `scripts/test-flight-store.mjs` (17).

- ✅ Chunked persistence: rows written in checksummed chunks (every 5 s or 250 rows), each committed in one transaction with the session record.
- ✅ Retention: saved copies are removed after 30 days. Interrupted sessions are never deleted automatically.
- ✅ Local session list on the home page with explicit Download CSV and Delete (confirmed).
- ✅ Crash recovery: interrupted sessions are listed on the next visit with Download or Delete. Never auto-resumed. Recovered CSV is byte-identical to what the live recording would have saved.
- ✅ Validation: a bad, missing, or out-of-order chunk ends the usable data; later chunks are left out and the problem is reported. Nothing is repaired, filled, or inferred.
- ✅ Storage monitoring: `navigator.storage.estimate()` warns at 70% / 90% or low free space, projects hours left, shows persistent vs best-effort, and asks for persistence only after the user ticks the box.
- ✅ Failures (quota, transaction, blocked IndexedDB) stop only the backup, keep stored data, say so, and leave the in-memory recording and normal CSV save untouched. The waiting buffer is bounded.
- ✅ CSV import/export unchanged and compatible (recorder tests still pass).
- ➖ Verified in the integrated browser with the simulated drive only: write, interrupted-session list after a reload, and delete. The Download CSV button was not observed (embedded browser hides downloads); its content is covered by a unit test.
- ➖ Not tested: real quota exhaustion, private-mode blocking, `persist()` prompts, multi-hour sessions, multiple tabs recording at once, a real hardware drive.
- ➖ Limitation: the live recording still lives in memory too, so very long sessions are not yet bounded in RAM.

### Part B — `.wobd` export/import and lossless CSV migration, implemented, not released

Spec: [WOBD-Format-Spec.md](./WOBD-Format-Spec.md). Code: `js/zip.js`, `js/wobd.js`, `js/csv-lossless.js`. Tests: `scripts/test-wobd.mjs` (34). Decisions: `.wobd` / `application/vnd.wobd.session+zip`; no per-row latency/quality; stored-entry fallback for Chrome/Edge 89–102; compression ratio is a warning only; original CSV embedded by default.

- ✅ In-house ZIP reader/writer with bounded, hostile-input validation and caps; accepted by Python `zipfile`.
- ✅ Chunked JSONL telemetry, manifest with CRC-32 and SHA-256, versioned (unknown major refused, unknown minor fields ignored).
- ✅ Gaps, clock regressions, and inferred crashes are stored as events. Readings are never invented, and a gap is never called a stall. Rows are never reordered.
- ✅ Lossless CSV migration: both real recordings round-trip to identical bytes with and without the embedded original. Fixtures cover unknown PIDs, extra columns, empty/non-numeric values, malformed/duplicate/out-of-order rows, `0.50`, `1e3`, `0500`, BOM, LF, no final newline, and invalid UTF-8.
- ✅ The original is only left out when WOBD proves the CSV rebuilds exactly; leaving it out needs a confirmation.
- ✅ Visible "What was kept" migration report.
- ✅ UI: Replay opens `.wobd` files (notes inside are applied) and has "Save as .wobd"; saved/interrupted backups have "Download .wobd".
- ✅ CSV import/export is unchanged.
- ✅ Size: the Highlander archive is under a third of its CSV size (the PT Cruiser archive is 26 KB without the original, from a 251 KB CSV).
- ➖ Browser-verified in the integrated browser: Save as .wobd on the PT Cruiser recording, the report, and writing then re-reading an archive in-page (byte-identical) and opening it in Replay. The file download and the native file chooser were then tested by the owner: a `.wobd` download and upload both work.
- ➖ Not done or not tested: 1 / 3 / 7-hour size, memory, and timing fixtures; Safari and Chrome/Edge 89–102; quarantine of a single damaged entry (a damaged file is refused); per-segment monotonic time (not recorded by the recorder); streaming import above ~100 MiB; locations and raw replies in the archive. Part A's session/segment IDs are one session and one segment per file.
- ➖ Independent verification of the production implementation has not been done; the same author wrote the code and tests.

## F7 — Geolocation and Route Visualization

- ➖ Keep route/GPS collection and online map loading as independent user-controlled consents.
- ➖ Store GPS locally by default; no automatic route-history uploads or location in analytics/errors.
- ➖ Implement independent asynchronous location fixes with accuracy and honest timestamps.
- ➖ Build offline route polyline first, with gaps, accuracy, event markers, synchronized playback, and no external tile requests.
- ➖ Add privacy controls for redaction, trimming, location-free export, and local deletion.
- ➖ Do not treat GPS fixes and sequential OBD samples as simultaneous; do not invent locations in gaps.
- ➖ Before optional Mapbox: disclose IP/request/viewport data flow; restrict public token; review terms/telemetry; add monitoring, quota/cost safeguards, rotation, explicit lazy-load, and offline fallback.
- ➖ Test denied/revoked permission, inaccurate/missing fixes, offline mode, long gaps, sensitive addresses, export/print privacy, and no unexpected network requests.
- ➖ Decide Mapbox go/no-go after privacy, terms, and cost review.

## F8 — Printable Diagnostic-Session Report

- ✅ Existing DTC scan print report is present; this is separate from the session report.
- ✅ Replay has "Print session report": a client-side, multi-page report (cover facts, length, readings count, gaps, protocol, recorded-with version, non-diagnosis disclaimer on the cover and in a repeating footer). Optional vehicle text is typed by the user; the VIN is never printed and recordings do not store one. No location is included.
- ✅ Summary table with lowest/highest (and when), sample count and average for numeric gauges only; state gauges (e.g. fuel system) are listed as not summarized. Gauges that go quiet while others keep answering are named.
- ✅ Overview graphs follow the summary: inline SVG per gauge, gap-aware (lines break, grey bands for all-gauge gaps), min/max markers, note markers, detected-pattern bands.
- ✅ Every detected pattern is listed in an index (routine and dismissed included, with your review). First 40 get detail sections with evidence and a 30 s context chart; the report says when more exist.
- ✅ Notes: each note has an "In report" checkbox (all ticked by default); left-out notes are counted.
- ✅ Methodology section lists detector rules, gap rule and limits. No DTC, freeze-frame or GPS appendix yet (not captured in recordings).
- ✅ `scripts/test-session-report.mjs` (14 tests, model/charts/real PT Cruiser). The new file is in `APP_SHELL`.
- ➖ Browser-verified in the integrated browser only: the Highlander and PT Cruiser reports render (screenshotted with print.css applied), note selection works. Not verified: the real print dialog/PDF page breaks and repeating footer, Safari/Firefox print, 3/7-hour recordings, localization and unit display.
- ➖ A DTC/module appendix, freeze frames and GPS route are deferred until those are captured.

## F9 — Language Selection and Offline Localization

- ✅ Chosen from Cloudflare visitor data (US, France, Singapore, China, Germany, Japan…): French, German, Spanish, Japanese, Simplified Chinese, plus English. Traditional Chinese, Hindi and others are not supported yet.
- ✅ Stable keys and versioned bundles: 953 keys in `data/i18n/en.json` (built from `scripts/i18n-src/*.json` by `node scripts/build-i18n.mjs`), one bundle per language, English fallback for any missing key or a corrupt/missing bundle.
- ✅ Top-bar language selector, choice saved in this browser, same URLs for every language. Browser language only triggers a one-time, dismissible suggestion (never an automatic switch). Switching does not reload, so a connection is not dropped.
- ✅ Localized: top bar, footer, Scanner, Bob, Live data, gauge labels (`pid.*`), Replay, detectors, notes, session report, errors, simulator and report pages, dates and numbers, Bob's spoken voice (when the browser has one).
- ✅ Bob's 66 hand-written code explanations are translated per language (`data/i18n/codes.<lang>.json`) and marked as translated. The generic code database (OBDex), static `/codes` pages, guide, tested adapters, changelog and contact stay English by design.
- ✅ Separate display units setting (imperial default / metric: mph→km/h, °F→°C). Display only: CSV, `.wobd` and exports keep the recorded units.
- ✅ Every non-English language is labelled "· AI" with a footer notice that it was machine translated and not yet reviewed by a native speaker.
- ✅ Tests: `test-i18n.mjs` (engine, fallback, key/placeholder/tag/plural parity per language, page and script keys), `test-units.mjs`, `test-pid-labels.mjs`, plus metric cases in the Replay and session-report tests. New files are in `APP_SHELL`.
- ➖ Native-speaker review of automotive and safety wording is still needed (all five languages). Until then the "AI" label stays.
- ➖ Browser-verified in the integrated browser only: language switching on Scanner and Replay, selectors on a phone width. Not verified: every screen in every language for text overflow, the print dialog in other languages, voice output, Safari/Firefox.
- ➖ A few strings still show English names of controls from other pages (for example "Start Recording" inside a Replay hint).

## F10 — Module-Aware Reporting and Vehicle Validation

- ✅ Existing All Modules / per-ECU scan views and inferred ECU labeling are implemented.
- ✅ Existing scan/report and DTC regression checks pass (`test-dtc.mjs`, 12 cases).
- ➖ Reuse module/source confidence and per-service/per-module/per-time status in future reports and recordings.
- ➖ Preserve unknown source IDs and distinguish unavailable Mode 0A from “no permanent codes.”
- ➖ Build deterministic modern CAN, multi-frame VIN, differing ECU bitmap, legacy checksum, unknown source, address alias, and protocol-failure fixtures.
- ➖ Test a consented modern CAN 11-bit / 500 kbps vehicle from automatic mode; capture new logs before any override.
- ➖ Limit hardware compatibility claims to vehicles actually tested; never clear codes or change firmware during compatibility testing.

## F11 — Mode 02 Freeze Frame and Session Comparison

- ➖ Discover/validate Mode 02 records and parameters with exact service/record/response checks.
- ➖ Reuse verified Mode 01 formulas where valid; associate freeze frame to a DTC only when the ECU response supports it.
- ➖ Display source and missing values honestly.
- ➖ Compare sessions with independent timestamps; do not fabricate synchronization.
- ➖ Test supported/partial/unsupported/malformed, per-ECU, stale/missing, multi-frame, and old CSV replay behavior.

## Delivery and Regression Tracking

- ✅ P0 current repository and regression baseline reviewed (2026-10-21).
- ✅ P1 streaming CSV parser and 128 MiB cap completed (`e36ec00`).
- ✅ P1 Replay downsampling and gap rendering completed (`03846df`).
- ➖ P1 Replay wall-clock display and annotation-only review workspace.
- ✅ P1 connection-aware Bob troubleshooting / protocol search guidance.
- ✅ P1 fuel-level PID `012F` (unsupported-vehicle wording and manual notes still open).
- ➖ P2 VIN confirm/fallback/save flow.
- ➖ P2 anomaly detection and event annotations.
- ➖ P2 printable session report.
- ➖ P2 IndexedDB persistence/recovery and `.wobd` reader/writer with lossless CSV migration.
- ➖ P3 GPS capture, offline route view, optional Mapbox layer, and localization.
- ➖ P3 Mode 02 freeze frames, multi-session comparisons, and expanded CAN validation.
- ✅ Re-ran all regression scripts after v1.5 release hardening: `test-dtc` 12, `test-navigation`, `test-recorder` 21, `test-replay-downsample` 23, `test-replay` 18, `test-simulator` 18, `test-smartbauder` 21, and `test-supported-pids` 24; all passed.
- ➖ Re-run the full regression set after every relevant future code change; retain non-regression of serial queue, connection, gauges, scans, export, and driving lock.

## Release and Manual Checks

- ✅ Synthetic 7-hour / 756,000-reading CSV (64.5 MB) imported through the browser file-input path in integrated Chromium 150.
- ✅ Isolated 7,000-RPM spike was visible in the chart screenshot; synthetic 4.5-minute gap rendered as a break/band.
- ✅ Integrated Chromium 150 playback measurement on that 7-hour CSV: 300 animation frames, 59.7 fps mean, 16.8 ms p95, 33.3 ms maximum frame interval, 23.3 MB V8 heap used; one 53 ms long task. This is Linux Electron/Chromium evidence, not ChromeOS or total browser-process memory.
- ✅ User confirmed native Chrome file-picker testing and large CSV playback on the real Chromebook using the v1.5 Preview; detailed fixture/cap-edge-case coverage and numerical performance/memory measurements were not reported.
- ✅ User confirmed offline Replay and navigation worked on Chromebook; the preview origin had its own HTTPS service-worker scope and the cached Replay module.
- ✅ User confirmed the simulator worked and a USB Web Serial adapter connected on Chromebook.
- ✅ Update the shared header across all site pages with the new logo, retaining the WOBD wordmark; replace the page favicon while preserving Bob's in-page illustrations.
- ✅ Confirm header logo and favicon render in browser; increase the header logo to 2rem (slightly larger than the wordmark).
- ✅ Allow only `Assets/favicon.png` and `Assets/header-logo.png` through `.assetsignore`; keep unrelated `Assets/BOB-Mechanic.png` excluded.
- ➖ Record ChromeOS memory, frame rate, responsiveness, and tab-stability measurements for a multi-hour recording.
- ➖ Exercise BOM/CRLF edge cases, invalid CSV handling, and a near-limit file through the native file picker.
- ✅ Add `js/replay-downsample.js` to `APP_SHELL` and increment `CACHE_VERSION` from v31 to v32; verify activation removes prior `wobd-cache-*` caches and the new cache includes the module.
- ✅ Verify Replay can reload offline after the v32 service worker activates and serves the new module.
- ✅ Update `WOBD_VERSION` from 1.4 to 1.5 and prepare README v1.5 notes containing only implemented behavior.
- ✅ Bump `WOBD_VERSION` to 1.51, add v1.51 branding notes, add the two branding assets to the service-worker app shell, and bump the cache version to v33.
- ✅ All eight regression scripts passed after v1.51 branding changes: DTC (12), navigation, recorder (21), Replay downsampling (23), Replay (18), simulator (18), smart baud (21), and supported PIDs (24).
- ✅ Deployed v1.51 branding commit `a07930b`; both production domains serve v1.51 and return the new favicon and header logo successfully.
- ✅ Verify cache v33 contains the new branding assets and Replay dependencies; unrelated `Assets/BOB-Mechanic.png` remains excluded (HTTP 404).
- ➖ Verify existing v1.4 installations update from the deployed origin; preview and local lifecycle tests do not substitute for production propagation.
- ➖ Test Firefox/Safari import behavior where supported; record browser/version and limits.
- ✅ Deploy approved commit `2a77544` to the existing production Worker; `wobd.app` and `wobd.shumwayjohnny.workers.dev` return HTTP 200 and serve version 1.5 plus `js/replay-downsample.js`.
- ✅ Verify the production origin activates `wobd-cache-v32`, caches Replay and its downsampling module, and serves the app shell and Replay resources with networking disabled.
- ➖ Verify production PWA installation/start URL and update behavior for an existing v1.4 installation on ChromeOS.

## Blockers and Unresolved Decisions

- **Manual/device verification:** Chromebook user confirmed native file picker, large CSV, offline Replay, navigation, simulator, and USB Web Serial on the Preview. Quantitative ChromeOS multi-hour performance/memory and detailed CSV edge-case measurements were not reported.
- **Version/release:** v1.51 commit `a07930b` is pushed to `main` and live in production with cache v33. Existing-install upgrade and PWA install/start URL checks remain open.
- **Recording format decisions:** media type/file extension, per-row latency/quality defaults, compaction duration and import caps, Chrome/Edge 89–102 fallback, and ratio-warning behavior (see Recording-Format-Study.md §9).
- **Recorder decisions:** quota warning thresholds/minimum free space, batch interval, optional-data degradation order, retention/eviction defaults, wall-clock tolerance, and legacy annotation sidecar/fingerprint details.
- **Feature decisions:** Mapbox go/no-go and cost/terms, annotation-editor placement, anomaly sensitivity and dismissed-event presentation, location consent persistence, VIN decoder privacy approach, report annotation defaults, and initial language set/review.
- **Hardware evidence:** no newly measured modern CAN vehicle; older Ranger failure was under v1.1 and remains unverified for current versions.
- **Evidence discipline:** prototype numbers in the feasibility study and Node benchmarks do not prove production durability, Safari compatibility, or ChromeOS behavior.
