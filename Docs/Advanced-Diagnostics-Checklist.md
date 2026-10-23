# WOBD Advanced Diagnostics — Progress Checklist

This is the implementation tracker for [Advanced-Diagnostics-Plan.md](./Advanced-Diagnostics-Plan.md). The roadmap describes the intended behavior and rationale; this file records implementation and verification status. Design approval, feasibility prototypes, and planned tests do not count as completed application functionality.

Update this checklist whenever an implementation stage is completed. Keep acceptance items unchecked until they are implemented and verified.

## Current Status / Where to Resume

- **Latest completed milestone:** v1.7 (F2 connection troubleshooting, F3 fuel level, dismissible banner). v1.6 added static code pages and SEO; v1.51 branding was `a07930b`.
- **Current application label:** WOBD v1.7 (previously v1.51; v1.5 had been released from `2a77544`).
- **Current focus:** v1.7 released: F2 connection troubleshooting and F3 fuel level are implemented. Work stopped there on purpose: the next items (F1, F4 annotations, F5, F6, F7, F8, F9) each have open decisions listed under "Blockers and Unresolved Decisions" and need your answers first.
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
- ➖ Validate VIN payloads for legacy and CAN multi-frame responses; reject malformed or conflicting ECU VINs.
- ➖ Offer a local or consented external decoder and an explicit vehicle-match confirmation.
- ➖ Preserve manual year/make/model selection on `NO DATA`, malformed VIN, timeout, offline, or user decline.
- ➖ Add optional local saved-vehicle identity with change/delete controls; keep VIN out of ordinary UI and reports.
- ➖ Test success, correction, PT Cruiser `NO DATA`, malformed/short/multiframe data, network failure, consent decline, and privacy masking.

## F2 — Connection Troubleshooting and Protocol Guidance

- ✅ Existing adapter/serial/OBD error classification and protocol override remain available.
- ✅ Explain adapter failure, ECU nonresponse, `NO DATA`, `CAN ERROR`, bus error, timeout, and parse failure distinctly in Bob's context-sensitive guidance (`js/troubleshoot.js`, `scripts/test-troubleshoot.mjs`, 9 cases).
- ✅ On override failure, show the protocol by name and recommend automatic selection before external research.
- ✅ Add an encoded, user-initiated vehicle/protocol search link; do not treat search snippets as authoritative.
- ➖ Verify safe retry/reset and `ATSPx` / `ATDPN` behavior without unnecessary follow-up after definitive bus failure. (Partly done: the adapter's own reply, such as `CAN ERROR`, is now kept and written to the traffic log; `ATDP`/`ATDPN` are still only queried after `UNABLE TO CONNECT`. Needs a hardware or simulator trace.)
- ➖ Test PT Cruiser automatic `ATSP0` / `A2` against deliberate `ATSP6` / `CAN ERROR` (message logic is unit-tested with canned errors; a real or recorded trace is still needed); keep the v1.1 Ranger failure labeled unverified for current versions.

## F3 — Fuel-Level PID and Related Parameters

- ✅ Add Mode 01 PID `2F` only when advertised and response-validated; decode `100 × A / 255` (`LIVE_PIDS`; tests cover 0 / 255 / mid-scale, wrong lengths, and no data).
- ➖ Preserve provenance, units, sample time, availability, and response errors; do not infer fuel from trims or the dash gauge.
- ➖ If display smoothing is introduced, retain raw unsmoothed measurements and label the display behavior.
- ➖ For unsupported vehicles, say unavailable through standard OBD-II; any manual fuel note must be labeled as user-entered.
- ➖ Test 0 / 255 / mid-scale, unsupported and malformed responses, recording boundaries, raw/display values, and legacy CSV. (0 / 255 / mid-scale, malformed, unsupported, and not-offered cases are done in `test-supported-pids.mjs`; recording boundaries and legacy CSV are not.)

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

- ➖ Show elapsed and local date/time for the selected sample; retain timestamp source, UTC/offset, and DST semantics.
- ➖ Add a zoomable timeline, connection-gap markers, known/user-annotated engine-off intervals, and per-PID sample ages.
- ➖ Add annotation-only Session Review; never rewrite source measurements.
- ➖ Support post-drive event notes and keep automatic detections separate from user annotations.
- ➖ Key annotations to unified session time; retain row order/source data and existing CSV compatibility.
- ➖ Map absolute-timestamp legacy CSV to relative time plus an honest timestamp anchor; map relative-only CSV without inventing a wall clock; support order-only data.
- ➖ Handle missing, malformed, duplicate, out-of-order, and backward-jump timestamps without silently changing source rows; flag quality issues.
- ➖ Persist legacy annotations in a sidecar with a file fingerprint and safe mismatch behavior.
- ➖ Preserve CSV timestamp/row compatibility and round-trip unannotated legacy exports.
- ➖ Test time zones, DST, invalid timestamps, gaps, annotations, seek/zoom, and slow devices.

## F5 — Automatic Anomaly and Event Detection

- ➖ Implement pure/testable detectors for candidate RPM, trim, temperature, voltage, fuel-control, sensor-dropout, and communication patterns.
- ➖ Gate detections on fresh, quality-checked samples; account for polling skew, intervals, hysteresis, dwell, debounce, speed/load, and stale data.
- ➖ Store evidence, exact time range, PID/ECU, thresholds, context, and detector version on each marker.
- ➖ Keep automatic events distinct from annotations; allow false-positive dismissal/classification without deleting evidence.
- ➖ Use cautious, authored explanations, not definitive component diagnoses.
- ➖ Enforce the no-stall rule: a gap or missing RPM alone never means stall; suspected stall needs fresh valid RPM falling to zero with ignition context.
- ➖ Test normal shifts, RPM changes, irregular intervals, ignition-on at zero speed, engine-off stop, stale/dropout data, open-loop deceleration, spikes, and gaps.

## F6 — Flight Recorder, Resilience, and Export

### Existing functionality

- ✅ Existing in-memory live-data CSV capture/export and recording driving lock remain in place; recorder regression passes (21 cases in the latest run).

### Planned storage and format work — not implemented

- ➖ Record separate session and segment IDs/sequences; persist `sample_seq`, UTC wall time, and per-segment monotonic time.
- ➖ Preserve canonical ordering across reloads; report wall-clock adjustments/regressions without reordering or retiming samples.
- ➖ Store quality states and explicit interruption/gap events; never fabricate measurements, zero-fill, interpolate, or infer engine stall from a gap.
- ➖ Add IndexedDB chunked persistence, retention controls, local session listing, explicit delete/export, and best-effort crash recovery.
- ➖ Recover open/interrupted sessions by validation; quarantine corrupt tails; offer recover/export/discard; never silently resume or delete.
- ➖ Monitor estimated storage, persistent-storage availability, and projected duration; warn clearly when storage is unavailable or nearing quota.
- ➖ Handle quota/transaction/database failures independently of warning thresholds; keep stored data, bound in-memory tail, report failure, and offer export.
- ➖ Batch writes atomically; test crash mid-batch, torn tail, missing end record, sequence gaps, invalid schema, multiple open sessions, and quota failure with misleading estimates.
- ➖ Implement approved versioned `.wobd` ZIP with chunked JSONL, bounded ZIP validation, checksums, security caps, and stated browser fallback.
- ➖ Keep CSV import/export compatible.
- ➖ Implement lossless CSV migration preserving original bytes by default, unknown PIDs, extra columns, raw values, original timestamps, row order, and residual/malformed rows.
- ➖ Add visible migration report and explicit confirmation before omitting embedded source CSV.
- ➖ Test 1 / 3 / 7-hour measured-rate, assumed-CAN, and enriched fixtures; report measured vs assumed size, memory, timing, compression, integrity, and recovery.
- ➖ Verify production implementation independently; feasibility prototypes are not production code.

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

- ✅ Existing DTC scan print report is present; this is not the proposed session report.
- ➖ Generate a client-side, multi-page report with truthful vehicle/session metadata, duration/gaps, sample counts, and a non-diagnosis disclaimer.
- ➖ Add meaningful numeric statistics and suppress misleading categorical/unsupported statistics.
- ➖ Put overview graphs early; show timestamps, extrema, annotations, and visible gaps.
- ➖ Include all automatic events by default with uncertainty and references; include user annotations by explicit selection.
- ➖ Add evidence/context for each event and optional methodology, DTC/module, freeze-frame, or GPS appendix only when actually captured and authorized.
- ➖ Test empty/no-event/many-event sessions, 3/7-hour sessions, missing data, localization/units, long tables, page breaks, privacy, and legacy CSV.

## F9 — Language Selection and Offline Localization

- ➖ Inventory user-facing strings and introduce stable translation keys/versioned bundles with English fallback.
- ➖ Add reversible language selector; browser-language detection is only a suggestion.
- ➖ Localize Bob messages, errors, Replay, reports, help, dates, numbers, and supported display units without altering raw values or identifiers.
- ➖ Commit static translations; review automotive/safety language with qualified speakers; no paid runtime translation.
- ➖ Test missing keys, placeholders, language switching, offline use, print/export, long strings, corrupted bundle fallback, and English fallback.
- ➖ Review language-selection evidence before choosing the initial languages.

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
