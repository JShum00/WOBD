# WOBD Advanced Diagnostics — Audit, Product Roadmap, and Implementation Plan

**Original audit:** October 20, 2026  
**Expanded roadmap:** October 21, 2026  
**Current release discussed:** WOBD v1.4  
**Status:** Planning document — proposals are not implementation approval

## Purpose and approval gate

This document preserves the direction of the original advanced-diagnostics audit while recording subsequent real-vehicle findings and proposed features. The project is a static, client-side browser OBD-II application. Vehicle communication should remain in the browser through the existing Web Serial / ELM327 pipeline. Routine diagnostic requests must remain read-only; Mode 04 clearing stays a separate, explicit confirmation flow. The product should remain usable without a paid LLM, ongoing translation API, account, or server.

**Approval rule:** An item labeled **Proposed** must be reviewed and approved before code changes. Work should be divided into small, testable stages; this is not authorization for one giant implementation patch.

## 1. Architecture and established baseline

### Existing modules and responsibilities

| Component | Established responsibility |
| --- | --- |
| `js/serial.js` | Web Serial access, browser checks, port lifecycle, and disconnection. |
| `js/smartbauder.js` | Adapter serial-baud probing. |
| `js/elm327.js` | Single serialized ELM command queue, reply/prompt handling, adapter error and timeout classification. |
| `js/obd.js` | OBD request/response parsing, legacy and CAN payload handling, PID discovery/decoders, protocol and DTC parsing. |
| `js/conninfo.js` | Connection details such as adapter, protocol, voltage, timing, and responding-module counts. |
| `js/app.js` | Connection, diagnostics, scanning, and live-poll orchestration. |
| `js/gauge-picker.js`, `js/ui.js` | Supported-gauge selection, parameter catalog, display, scan presentation, and print rendering. |
| `js/bob.js`, `data/codes.json`, `data/generic/` | Rule-based Bob messages and offline trouble-code descriptions. |
| `js/recorder.js` | In-browser live telemetry capture, CSV export, and driving lock. |
| `js/replay-data.js`, `js/replay.js` | CSV import, playback, and charting. |
| `js/demo.js` | Simulated vehicle and communication scenarios. |
| `js/report.js` | Published adapter-report loading; distinct from scan print layout. |
| `README.md`, `Docs/WebAppDesignDoc-WOBD.md` | User and architecture documentation. |

### Original audit findings — historical, not necessarily current

The October 20 audit identified these issues before the subsequent v1.4 work: global unioning of multiple ECUs' PID bitmaps without retaining their sources; incomplete response-shape validation; a small decoder/name catalog; manual rather than prioritized automatic monitoring; missing/stale readings collapsing to dashes; limited multi-service DTC reporting; in-memory CSV-only recording; and playback without event markers, freeze frames, or full session reports. Do **not** treat these as still-open defects without checking the current tree and tests.

### Work reported as already implemented

The original implementation-progress section reports the following completed work in the working tree or v1.4 rollout; confirm deployment and version before modifying any of it:

- Contact page / Google Form and update-banner link, including service-worker shell entry.
- Source-aware supported-PID discovery with temporary ELM headers, strict four-byte bitmap checks, multi-ECU maps, and fallback when source identity cannot be read.
- Expanded, length-validated Mode 01 decoder registry; separate ECU voltage versus adapter `ATRV` voltage; catalog of supported but undecoded parameters.
- Gauge selection with Auto/Manual modes, categorized searchable parameter catalog, per-connection defaults/presets, prioritized polling, and value/status/freshness display.
- Per-service Mode 03 stored, Mode 07 pending, Mode 0A permanent/unavailable DTC scans, module source labeling, safe Mode 04 confirmation, and print scan report integration.
- A corrected overall MIL rule: **MIL ON if any responding module reliably reports ON**; retain each module's own MIL state. If none report a usable MIL state, show **unknown**, not falsely OFF. Avoid deduplicating distinct modules or summing retransmissions.
- Module-aware DTC scan tabs: **All Modules**, then individually responding ECUs (e.g., engine ECM and transmission TCM), with inferred module names explicitly marked as inferred.
- Adapter traffic transcript, including request/reply timing, chosen protocol, errors, and opt-in VIN disclosure on copied logs.
- Automatic protocol selection and an existing manual override for ELM protocols `1`–`9`, `A`, `B`, `C`. The override already existed by v1.2; do not add it again.
- Existing time-series CSV recording/replay and recording-time driving lock (dashboard intentionally blocked to discourage interaction while moving).

**Reported outstanding from the prior plan:** Mode 02 freeze-frame retrieval, durable rolling capture and recovery, automatic event capture, time/gap-aware session editor and session comparison, broader simulator tests, and complete documentation.

### Real-hardware evidence (not blanket compatibility claims)

**2001 Chrysler PT Cruiser (“Sparky”) / Vgate vLinker FS USB, ELM327 v2.3 / ChromeOS Chrome, 115200 adapter baud:**

- Automatic adapter setup (`ATSP0`) and `0100` discovery succeeded using **SAE J1850 VPW**, ELM protocol **2**, with `ATDPN` replying `A2` (automatically selected protocol 2).
- Headered `0100` showed responses from `48 6B 18` and `48 6B 10`. The app currently infers TCM and ECM respectively. **Address-based naming is provisional**; retain raw source ID and confidence.
- `0902` VIN request returned `NO DATA` in approximately 0.112 seconds on this vehicle. The presence of a VIN-redaction option does *not* mean VIN retrieval always succeeds.
- A deliberate override to protocol **6**, CAN 11-bit 500 kbps, sent `ATSP6`; `0100` and `0902` returned `CAN ERROR`; the app classified `BUS_ERROR` and closed the port. This is a valuable intentional-negative test, not evidence of a faulty vehicle.
- V1.4 scan views report the engine ECM as MIL ON with five stored and one pending DTC entry and the inferred TCM as MIL OFF with zero stored and zero pending entries in answered services. Permanent Mode 0A is unavailable. Zero reported codes in standard services **does not certify that a transmission has no faults**.
- An *older* PDF snapshot said overall MIL OFF; the multi-response MIL bug was corrected afterward. Do not reopen it merely because the outdated PDF still contains the former result.
- Two real-world CSV recordings of normal-feeling drives demonstrated the usefulness of elapsed/wall-clock time, speed context, frequent RPM/MAP/timing sampling, and explicit annotations for an intentional engine-off stop. Normal-feeling trips do **not** resolve earlier intermittent stalling.
- An attempted ~2020–2021 Ford Ranger test failed to reach vehicle communication under WOBD **v1.1**. That does not establish a v1.4 compatibility defect; a new consented CAN-vehicle test is needed.

**Baseline software checks from the original audit (historical):** `test-supported-pids` 14/14, `test-recorder` 21/21, `test-replay` 9/9, and `test-smartbauder` 20/20. Re-run and update counts against the current tree. Demo/fixture results are not physical-vehicle validation.

## 2. Product principles

1. **Truthful diagnostics:** Distinguish measured data, inferred metadata, and heuristic suspicion. Do not claim to identify a failed component from an RPM spike alone.
2. **Single command queue:** Continue using one transport/command serializer; no parallel polling on the same ELM port.
3. **Actual sample times:** Preserve wall-clock and monotonic timestamps for every returned sensor value; sensors queried sequentially are not simultaneous.
4. **Clear missing-data semantics:** `unsupported`, `supported-undecoded`, `no response`, `malformed`, `temporarily stale`, `not recorded`, and `unknown` are distinct.
5. **Privacy:** Default local-first. VIN remains redacted in copied logs; GPS is opt-in and may be excluded from exports/reports. Full trip traces can expose sensitive locations.
6. **Safety:** Maintain the driving lock. Maps, editing, report customization, and complex UI belong in post-drive playback; speed = 0 alone is not proof of safe parking.
7. **No recurring AI bills:** Bob remains a deterministic state machine with authored messages, templates, rules, and optional offline language packs.
8. **Backward compatibility:** Existing exported CSV files, legacy gauge keys, and current scan flow must keep working. Add versioned session export where needed.
9. **Vehicle-agnostic:** Use protocol-discovered capabilities rather than assumptions about a specific year/make/model; unknown ECU IDs remain unknown.

## 3. Prior audit implementation stages — disposition

| Original stage | Current disposition / remaining work |
| --- | --- |
| 1. Source-aware PID discovery | **Reported implemented.** Regression tests still needed for all legacy layouts, malformed data, and source attribution. |
| 2. Decoder catalog/status model | **Partially implemented/expanded.** Continue standards verification, including response lengths, signedness, and units; add fuel-level PID `012F` where supported. |
| 3. Automatic monitoring | **Reported implemented.** Benchmark real J1850 versus CAN vehicles; validate priorities, stale states, and cancellation. |
| 4. Stored/pending/permanent DTCs | **Reported implemented.** Confirm deduplication, correct per-module MIL, status provenance, and print/replay consistency. |
| 5. Mode 02 freeze frames | **Proposed — not reported completed.** |
| 6. Durable flight recorder/events | **Proposed — not reported completed.** |
| 7. Session visualization/reports | **Proposed — expand with clock, annotations, GPS/map, anomaly summaries, full printable reports.** |
| 8. Simulator/regression/docs | **Ongoing.** Expand for all new features and real-world traces. |

## 4. New feature specifications

### F1 — VIN-assisted vehicle identification (Proposed; small–medium)

**Goal:** Reduce manual year/make/model selection without relying on an LLM.

**Flow:** During the existing connection startup, the app already attempts Mode 09 PID 02 (`0902`). If a well-formed 17-character VIN is returned, validate the payload (including legacy/CAN multi-frame handling), then *with user consent* decode locally or request a public vehicle-decoder service. Show Bob's deterministic confirmation message: “I found a possible vehicle match: [year] [make] [model]. Is that right?” Allow user correction. For `NO DATA`, malformed VIN, timeout, or offline use, leave the existing manual selectors available. Do not delay or fail basic connectivity on VIN failure.

- The VIN **contains model-year coding**, although year-code interpretation can require vehicle context; it does not establish the exact build date.
- Evaluate NHTSA vPIC VIN decoding for vehicles and markets that it covers. Its decoded metadata is **not** a source of fault-code definitions.
- A decoder request sends the VIN off-device: disclose and require consent first, or choose a privacy-preserving on-device fallback.
- “Remember this vehicle” must be optional and locally stored with clear/delete controls. Prefer a local pseudonymous saved-vehicle ID rather than showing VIN in ordinary UI/report headers.
- Multiple responding ECUs might give no VIN, duplicates, or conflicts. Never silently choose an arbitrary conflicting VIN.

**Acceptance/tests:** success and confirmation; corrected match; `0902 NO DATA` on the PT Cruiser; malformed/short/multiframe responses; network unavailable; service error; masked copy; user declines external lookup; saved vehicle invalidation/change.

### F2 — Connection troubleshooting and protocol guidance (Proposed; small)

**Goal:** Explain *where* a connection failed, using existing adapter traffic and Bob's state machine.

- Distinguish adapter/serial failure from ECU nonresponse, adapter `NO DATA`, `CAN ERROR`, bus error, timeout, and syntactically valid but unparseable responses.
- If a manual override fails, display the selected protocol by name and suggest returning to automatic selection **before** suggesting internet research.
- If year/make/model is known, offer a user-initiated Google search link containing vehicle identity + “OBD-II diagnostic protocol” and, where useful, the failure category. Do not treat search snippets as an authoritative protocol determination.
- Keep existing manual protocol override; do not add a second override UI. Preserve meaningful `ATSPx`, `ATDPN`, and failure traces. Avoid unnecessary follow-up requests after a definitive unrecoverable bus error.
- Offer retry with safe initialization/reset; confirm protocol override actually causes the chosen `ATSPx` and matches expected `ATDPN` semantics.

**Acceptance/tests:** reproduce PT Cruiser successful auto `ATSP0`/`A2` versus incompatible `ATSP6`/`CAN ERROR`; validate Bob's context-dependent message and encoded search URL; distinguish parse failure from silent vehicle; old v1.1 Ranger failure remains *unverified* under v1.4.

### F3 — Fuel-level and related supported PIDs (Proposed; small)

**Goal:** Include fuel level when the vehicle actually exposes it, for correlation with intermittent problems and trip context.

- Add standard Mode 01 **PID `2F`** (“Fuel Tank Level Input”) only if discovery advertises it and its response passes service/PID/length validation. Standard percentage conversion for byte `A`: `100 × A / 255`.
- Track provenance, units, sample time, availability, and response errors. Do not infer tank contents from trims or the dashboard gauge.
- Smooth *display* cautiously if requested (fuel slosh) while preserving unsmoothed raw samples. Fuel percentage is **not** fuel consumption rate or an accurate remaining-range estimate by itself.
- For unsupported vehicles (possibly the older PT Cruiser), display “not available through standard OBD-II”; optionally allow clearly labeled **manual fuel-level annotations**, not fabricated ECU readings.

**Acceptance/tests:** known A=0/255/mid-scale, missing PID, malformed response, stopped/started recording, raw vs display-smoothed data, legacy CSV import.

### F4 — Replay wall-clock, timeline, and review workspace (Proposed; high-priority small → medium)

**Goal:** Make existing time-stamped recordings understandable without memorizing elapsed minutes.

- Show **elapsed time and local date/time** for the selected sample, near the playback controls. Preserve timestamp source, UTC/offset, and daylight-saving handling; do not invent absolute times for old files lacking them.
- Include a scrubber/zoomable timeline with visible **connection gaps**, engine-off intervals only when known or user annotated, and separate per-PID sample ages.
- Create a **Session Review** (or “Recording Editor”) page that never edits source measurements. Editing means adding/removing annotations and report selections, not rewriting diagnostics.
- Support event notes after the trip: `engine hesitation`, `stop sign`, `intentional ignition off`, `refueling`, `road condition`, custom label and comment.
- Link annotations to the unified session time, not merely array indices. Keep raw CSV playback intact.

**Unified session timeline and legacy CSV mapping**

- Define the unified session time as **session-relative milliseconds** (`t_rel`, ≥ 0 from the first accepted sample), with an optional absolute anchor (`utc_start`, plus UTC offset where known). Absolute time for any sample is *derived* as `utc_start + t_rel` only when an anchor exists.
- **Legacy CSV with absolute timestamps:** parse the existing timestamp column(s) as the anchor, record the timestamp source and whether a time zone/offset was present (assume none is known if absent; display as "local time as recorded" rather than guessing a zone), and compute `t_rel` from the first valid row. Gaps are computed from actual timestamp differences.
- **Legacy CSV with only relative/elapsed timestamps:** use the elapsed value as `t_rel` directly and leave `utc_start` null. Never invent a wall-clock date/time; the UI shows elapsed time only and labels absolute time "not recorded".
- **No usable timestamps:** replay in row order with a clearly labeled "sample order only" timeline; annotations attach to row index and the file is flagged as low-fidelity.
- **Annotations on legacy files:** stored in a **sidecar** (e.g., `annotations.json`) keyed to a file fingerprint (name, size, row count, and content hash) and the `t_rel` (or row index for order-only files), so the source CSV is never modified. If the fingerprint no longer matches, warn and offer to re-attach rather than silently misapplying annotations. Sidecar annotations are exportable and importable with the CSV.
- **Timestamp anomalies** (record each as a data-quality note shown in the review UI; never silently correct or drop source rows):
  - *Missing/blank:* row retained, treated as `not recorded` for time; excluded from interval statistics and not interpolated.
  - *Malformed/unparseable:* same handling, with the raw text retained and a warning count.
  - *Duplicate:* retained in file order; same-time samples are preserved, not merged; charts do not draw zero-length segments as false data.
  - *Out-of-order:* playback orders by `t_rel` for charts while retaining original row order for export; flag a count and the first occurrence. Backward jumps larger than a defined threshold are reported as a possible clock change, not as negative elapsed time.
  - *Large forward gap* (default candidate > 5× the median sample interval, minimum fixed floor): represented as an explicit gap on the timeline, not as a continuous line.
- **Compatibility:** existing CSV import and export formats are unchanged. New metadata is additive (sidecars or new optional columns that old importers ignore). The existing exporter keeps producing files the current importer reads.

**Streaming, downsampling, and lossless migration** (details in study §7.8–§7.9): CSV import streams (`File.stream` → incremental quote-aware parser → typed columns) instead of loading the whole file; charts downsample at render time (min/max per pixel bucket, gaps as breaks) and never modify or discard raw samples; converting a legacy CSV to `.wobd` preserves unknown PIDs, extra columns, original timestamp text, raw value text, and the original bytes (`legacy/source.csv`), with a visible migration report. Round-trip: byte-identical CSV when the source is embedded.

**Acceptance/tests:** the only real recording in the repo is the 7.4-minute `reports/` CSV, so the 17- and 28-minute timelines must be built as seeded fixtures (study §7.11); a ~4.5-minute gap remains a gap; no falsely detected stall solely from a recording interruption; time zones and invalid timestamps; seek/zoom/replay on slow devices. Deterministic fixtures: (a) absolute-timestamp CSV maps to correct `t_rel` and derived wall-clock; (b) relative-only CSV shows no invented date; (c) no-timestamp CSV falls back to order-only; (d) annotation save/reload round-trip on each legacy type, including fingerprint mismatch; (e) blank, malformed, duplicate, out-of-order, and backward-jump rows each produce the specified flags with source rows unchanged; (f) DST transition and missing-offset files; (g) export-after-import round-trip is byte-compatible with the existing format for unannotated data.

### F5 — Automatic anomaly/event detection (Proposed; medium–large)

**Goal:** Highlight suspicious *patterns* without requiring a paid LLM or pretending to provide a definitive diagnosis.

- Implement deterministic, configurable detectors as pure/testable code: rapid RPM changes at approximately steady **OBD speed**, unexplained RPM drop near idle, recurring RPM oscillation, short-term fuel-trim excursions, unusual temperature trends, voltage changes, open-/closed-loop transitions, sensor dropout, and adapter communication loss.
- Compare only suitably fresh, quality-checked samples. Use rolling windows, hysteresis, minimum dwell, debounce, and speed/load context; avoid interpreting shift/downshift events or sequential polling skew as misfire proof.
- Each marker stores exact first/last timestamp, originating PID/ECU, samples, computed threshold, neighboring context, and detector-version information.
- Bob explains in predefined, cautious language: e.g., “RPM rose from 2,000 to 4,000 while reported speed stayed near 30 mph. This *may* reflect a shift, torque-converter change, wheel/road load change, or abnormal engine behavior. Review the surrounding data.” No blanket “your transmission is failing.”
- Mark **automatically detected events** separately from **user annotations**. Allow the viewer to dismiss or classify a false positive while retaining the original sample data.

**Guardrail:** a recording gap or missing RPM readings must never, by itself, produce a stall classification; key-off and stall look identical in a gap, and zero-RPM readings are measurements. A "suspected stall" requires fresh valid RPM readings falling to 0 with ignition context (study §7.10).

**Acceptance/tests:** a gap with no RPM data yields no stall event; normal shifts stay unflagged or informational; deterministic synthetic 2,000→4,000 RPM events; irregular sample intervals; 0-speed but ignition-on; engine-off at gas station; dropped sensor updates; open-loop deceleration; sensor spikes and stale data; no false diagnoses.

### F6 — Flight recorder, resilience, and export (Proposed; large)

**Goal:** Preserve richer evidence of intermittent faults without fragile, RAM-only sessions.

- Extend the existing recorder: per-sample wall-clock and monotonic timestamp, PID, numeric/raw value, units, ECU/source if known, request latency, result quality, and optional raw reply. Separately store adapter/protocol/connection events.
- Use IndexedDB or equivalent browser storage with bounded chunked writes, retention controls, quota/eviction warnings, restore-after-interruption as best-effort, and explicit delete/export.
- Support rolling event capture (initial candidate: 30 seconds before / 60 seconds after) without automatically discarding full sessions if the user chooses whole-trip recording.
- Continue CSV export; define a **versioned full-fidelity session bundle**, possibly ZIP with `telemetry.csv`, `events.json`, `metadata.json`, and optional `locations.json`. Add schema version and compatibility tests. See "Storage growth and a possible custom format" below for whether CSV remains the internal format.
- Never draw lines through unknown time spans or substitute a zero for missing readings. Pause/resume semantics and adapter disconnection must be distinct from a zero-RPM engine reading.
- Preserve the existing **driver-eyes-on-road screen**. Any stationary review mode needs explicit user confirmation of safe parking; never unlock interactive controls solely because OBD speed has been zero for a few seconds.

**Session and segment identity**

- Each recording has a random **`session_id`** (UUID) created at start. Each uninterrupted run of capture within it has a **`segment_id`** and a monotonically increasing **`segment_seq`** (1, 2, …). A new segment starts after a browser reload, crash recovery, adapter reconnect, or explicit pause/resume. Resuming after recovery is always a *new* segment of the same session, never a continuation of the old one.
- Every stored sample carries: `session_id`, `segment_id`, `segment_seq`, a per-session monotonically increasing **`sample_seq`**, **`utc_ms`** (wall clock, `Date.now()`), and **`mono_ms`** (`performance.now()`-based, relative to the segment start). `sample_seq` is assigned at write time from a persisted counter, so ordering survives reloads without relying on any clock.
- **Ordering rule:** canonical order is `(segment_seq, sample_seq)`. Intervals *within* a segment are computed from `mono_ms`. Intervals *across* segments are **not computed from monotonic time** (it resets); they are reported from `utc_ms` where trustworthy, otherwise as "unknown duration gap".
- `metadata.json`/the session record stores the segment table: `segment_id`, `segment_seq`, start `utc_ms`, start reason (initial/reload/reconnect/recovery/resume), end `utc_ms` and end reason (stop/crash-inferred/disconnect/unknown).

**Wall-clock changes**

- Within a segment, compare the wall-clock delta between consecutive samples to the monotonic delta. If they differ by more than a defined tolerance (candidate: max(2 s, 5 % of interval)), record a **`clock_adjustment` event** with before/after `utc_ms`, the monotonic reference, and the apparent offset (NTP sync, manual change, DST is not a UTC change and must not trigger this).
- Samples are **never reordered or retimed** because of a clock change. Elapsed time inside the segment keeps using `mono_ms`; the UTC value is kept as observed, and the viewer shows a clock-discontinuity marker. Optionally, derived "corrected UTC" may be offered as a *separate, labeled* view, never overwriting the stored value.
- Across segments, if the later segment's `utc_ms` precedes the earlier segment's last `utc_ms`, keep canonical `(segment_seq, sample_seq)` order, flag `clock_regression`, and mark cross-segment durations as unreliable.

**Interruptions, gaps, and missing data**

- Record explicit events, not silence: `segment_start`, `segment_end`, `adapter_disconnect`, `adapter_reconnect`, `pause`, `resume`, `recovery`, `storage_write_failed`, `storage_warning`, `clock_adjustment`, `clock_regression`, `polling_gap`. An unexplained time jump with no event is represented as an `unknown_gap` derived at read time.
- Per-PID quality states (`unsupported`, `no_response`, `malformed`, `stale`, `not_recorded`, `unknown`) remain distinct from numeric values. **No zero-fill, interpolation, carry-forward, or fabricated sample** is ever written to the store. Charts break lines at gaps.
- Crash-inferred segment ends are labeled `end_reason = crash-inferred`, distinct from a user stop, and the interval to the next segment is an unknown gap.

**Recovery of partial or interrupted IndexedDB recordings**

- Write in **small, atomic batches** (one transaction per batch, containing samples and the updated per-segment counters/`last_sample_seq` together) so a reload leaves either the complete batch or none of it. Maintain a per-segment status: `open`, `closed`, `recovered`, `corrupt-tail`.
- On startup, detect sessions with an `open` segment (no clean end). Offer **Recover, Export recovered data, or Discard**; never auto-upload, auto-delete, or silently resume.
- Validation on recovery: check `sample_seq` is contiguous and monotonic within each segment, schema version is readable, and the last batch is complete. A torn or invalid trailing record is quarantined (kept in a separate store, excluded from the main timeline) and a `recovery` event notes how many samples were kept/quarantined. Interior gaps in `sample_seq` are reported, not repaired.
- Recovery never fabricates the missing tail; the last good sample is the segment's end, with a `crash-inferred` end event.
- If the schema/version is unsupported or the database is unreadable, offer raw export of whatever can be read and explain the limitation instead of failing silently.

**Storage growth, quota, and export**

- Recent recordings held thousands of readings in under 30 minutes; adding raw replies, GPS fixes, events, and rolling capture could make a multi-hour session far larger. Treat storage as a first-class, monitored resource.
- **Estimate consumption:** keep a running estimate of bytes written per session (samples × average serialized size, refined by measured sizes) and query `navigator.storage.estimate()` for usage/quota where available. Show a live indicator and projected remaining recording time at the current rate.
- **Persistence status:** request `navigator.storage.persist()` only after a user action with an explanation; show clearly whether storage is *persistent* or *best-effort* (evictable). Warn before recording if persistence is unavailable, if IndexedDB is blocked (private mode), or if free quota is below a minimum.
- **Thresholds (candidates, to confirm):** warn at ~70 % of quota, strong warning at ~90 %, and stop storing *optional* data (raw replies, then verbose events) before core samples. Warnings use a non-modal, driver-safe notice during driving; details live in the post-drive UI.
- **Batching:** buffer in memory only briefly (candidate: flush every ~1–5 s or N samples, whichever first), with a bounded buffer so a stalled write never grows RAM without limit. On `QuotaExceededError` or write failure: emit `storage_write_failed`, keep the existing data intact, stop or degrade capture visibly (never silently drop), and keep the in-memory tail exportable.
- **Always exportable:** the user can export everything recorded so far at any time (including after a quota failure or recovery), as CSV and/or the session format. Exports stream/chunk to avoid building a giant in-memory string, and report if they are partial.
- **Retention/controls:** list sessions with size, date, and duration; per-session export and delete; "delete all"; configurable retention and an automatic-eviction policy only with explicit consent (never silently delete a user's only copy).
- **Reduce growth by design:** optional raw replies off by default or limited to events/rolling windows; store GPS at independent lower rate; compact numeric encoding; optional lossless compression for export.

**Storage growth and recording format (architecture and specification revision 2 approved; no implementation yet)**

CSV is excellent for interchange but verbose at hours-long scale: the real 7.4-minute recording measured 82.7 B/row, and a 3-hour fast-CAN session would exceed the current 20 MiB import cap. The [Recording Format Feasibility Study](./Recording-Format-Study.md) compared CSV + sidecars, a ZIP-based `.wobd`, and SQLite. **Direction (approved as a specification; prototype-tested only, not implemented):**

- **IndexedDB working store** using chunk records whose payload is the same JSON Lines encoding used in the archive, with exact byte accounting.
- **Versioned, documented `.wobd` ZIP archive** (JSON metadata + chunked JSONL telemetry, optional events/annotations/locations/raw replies) for full-fidelity export and import. Measured on synthetic fixtures tiled from the one real recording: ≈3.2–4.5 B/row, about 21–29× smaller than CSV (7 h at the measured 6.79 rows/s ≈ 0.76 MB; at an *assumed* 30 rows/s ≈ 2.4 MB). Enriched data (GPS, raw replies) is assumed, planning range 3–8 B/row.
- **ZIP container:** in-house reader/writer over `CompressionStream`/`DecompressionStream('deflate-raw')` (these provide raw deflate only, not ZIP), with bounded entries (≤ 4 MiB) and absolute size/count caps. Verified in headless Chromium 154 and Firefox 158; Safari untested; Chrome/Edge 89–102 lack the streams (stored-entry fallback proposed). See study §7.7.
- **Gap states:** user stop/pause, adapter disconnect/reconnect, communication interruption, bus error, inferred crash or sleep, and unknown gaps stay distinct; a gap never implies an engine stall (study §7.10).
- **CSV remains supported** for import and export, is never auto-converted or deleted, and converts to `.wobd` only by explicit user action, losslessly.
- **No custom binary encoding** (no size advantage once deflated) and **no SQLite** for now (WASM, header, security, and maintenance costs without a current need).

**Recovery is best-effort and quota handling is independent of warnings.** WOBD must never promise that an interrupted recording will be recovered: browsers can evict storage, users can clear it, crashes can lose the newest batches, and private modes can restrict it. The 70 %/90 % thresholds and `navigator.storage.estimate()` are advisory and approximate; every write path must handle `QuotaExceededError`, aborted transactions, and unavailable storage unconditionally, even when no warning fired. On failure, keep stored data, show the failure, keep a bounded in-memory tail, and offer immediate export. Tests must cover quota failure with warnings disabled and with an estimate that reports ample space.

**Acceptance/tests (deterministic):**
- Identity/order: session and segment IDs unique; `sample_seq` persists across a simulated reload; canonical order holds with shuffled insertion and duplicate `utc_ms`.
- Clocks: injected wall-clock step forward/back within a segment yields a `clock_adjustment` event with no reordering or retiming; cross-segment `clock_regression` flagged; DST/offset changes do not trigger adjustment.
- Gaps: disconnect/reconnect, pause/resume, reload each produce the specified events; no zero-filled or interpolated samples; zero-RPM reading remains distinct from missing data.
- Recovery: simulated crash mid-batch (torn tail), missing end event, non-contiguous `sample_seq`, corrupt/unsupported schema, empty session, and multiple open sessions; recover/export/discard each work; quarantined data excluded; nothing auto-deleted.
- Storage: mocked `navigator.storage.estimate()` crossing 70/90 %; `persist()` denied; IndexedDB unavailable; `QuotaExceededError` mid-recording keeps prior data exportable; bounded buffer under stalled writes; multi-hour synthetic session (e.g., 3–7 h, with raw replies and GPS) stays within a stated size and memory budget; export of partial/large sessions streams without freezing.
- Performance and integrity: seeded 1 h / 3 h / 7 h fixtures (measured-rate, assumed-CAN, enriched) with peak memory, import/export time, compression ratio, CRC/SHA-256 integrity, and recovery checks, measured results labeled apart from assumed CAN figures (study §7.11); hostile-ZIP fixtures (bomb, traversal, duplicate names, mismatched headers, bad CRC, truncation); lossless CSV migration fixtures (unknown PIDs, extra columns, `0.50`/`1e3` text, non-canonical timestamps, BOM/CRLF).
- Format: CSV and WOBD-session round-trips are lossless for core fields; forward-compatibility with unknown fields; checksum failure detected; legacy CSV unchanged.
- Safety: no storage warning requires interaction while the driving lock is active; recovery/export UI appears only post-drive.

### F7 — Browser geolocation recording and Mapbox route explorer (Proposed; large)

**Goal:** Correlate route location, time, OBD speed, engine readings, and events in a post-drive map.

**Privacy and data flow (applies before any implementation)**

- **Two independent, separately consented features:** (1) *Record route/location* (browser Geolocation → local storage) and (2) *Load online map tiles* (Mapbox). Enabling one never enables the other; each has its own toggle, explanation, and revoke control. Location recording works fully without Mapbox.
- **Local by default:** GPS fixes are stored only in local browser storage with the session. There are **no automatic route-history uploads** to WOBD, Mapbox, or anyone else, and no location in telemetry, analytics, or error reports. Any export containing location is an explicit user action.
- **Mapbox disclosure:** the UI and docs must state plainly that loading online map resources sends **request metadata, the viewport/tile coordinates and zoom being requested, the public access token, browser/user-agent and referrer information, and the user's IP address** to Mapbox, and that the visible tile area can reveal approximate route location even though raw GPS points are not uploaded. Mapbox's terms/privacy policy and any telemetry/event-collection behavior of the SDK must be reviewed and disabled or disclosed as the library permits before adoption.
- **Before enabling Mapbox, all of the following must be specified and in place:** a **URL-restricted public token** (production domain only, minimum scopes, no secret tokens in the repository or client); usage monitoring and alerts; a **quota/cost safeguard** (account-level spending cap or alerts, client-side limits such as lazy-loading the map only after an explicit "Show online map" action, no auto-load on page open, and tile/zoom limits); a documented process for token rotation; and **graceful fallback** when the token is missing/revoked, quota is exhausted, the user is offline, or requests are blocked.
- **Offline route visualization (required, ships first):** draw the route as an SVG/canvas polyline from stored fixes with **no external tiles or requests**, on a blank/neutral background with scale bar and time/speed coloring, hover/click-to-seek, gap rendering, event markers, and accuracy indication. This is the default view; Mapbox is an optional enhancement layered on top and must not be required for map-less review, printing, or reports.
- **Reports:** printed/exported reports contain no map imagery or coordinates unless the user opts in for that export; a Mapbox-rendered image is never fetched implicitly during print.

- Ask separately for **Record route/location** consent. Do not make location mandatory for vehicle diagnostics. ChromeOS location may be Wi-Fi-derived rather than satellite GPS: record latitude, longitude, accuracy, optional geolocation speed/heading, and timestamp with the original accuracy uncertainty.
- Collect coordinates as **independent asynchronous fixes** (e.g., around 1–2 seconds *when supplied*), not one coordinate per every OBD sample. Never imply the browser guarantees that frequency or accuracy.
- Keep timestamps in a shared session timebase; interpolate a map cursor only when points are sufficiently close/accurate, and show gaps otherwise. Preserve actual position points and do not imply an engine PID sample occurred exactly at a given GPS fix.
- Draw the route first as the offline polyline described above; optionally layer it on **Mapbox GL JS** (or an alternative) only when the user enables online maps. Color route segments by time or OBD speed where sample freshness permits. Hover or click to show wall-clock, speed, RPM/MAP/timing/fuel trims, and nearby events. A map click seeks the replay to the corresponding timestamp; a timeline seek highlights the route location.
- Optimize long trips (route simplification for *display*, not deletion of raw fixes), marker grouping, offline/no-map fallback, and map-provider usage costs/token limits.
- Map viewing and annotation are **post-trip** features, not interactive driving UI. Provide coordinate redaction, trim start/end of trip, export without locations, and full local deletion.

**Acceptance/tests:** precise/imprecise locations; user denies/revokes permission; offline travel; missing GPS fixes; long gaps; time zone transitions; three-hour-plus sessions; map unavailable; speed mismatch; locally sensitive addresses; preserved non-location recordings. Deterministic additions: with GPS recording on and map loading off, a network-request spy records **zero** requests to Mapbox or any external host; Mapbox loads only after its separate explicit action; revoking either consent stops the feature without affecting the other; the offline polyline renders identically with the network blocked; missing/invalid/revoked token, HTTP 401/403/429, and offline states fall back to the offline view with a visible explanation; no coordinates appear in default print/export output or in any outbound request body; location data are removed by "export without locations" and "delete session"; Mapbox code is not loaded (no script/CSS fetch) until enabled.

### F8 — Full printable diagnostic-session report (Proposed; medium–large)

**Goal:** Give a mechanic a useful multi-page report instead of requiring playback of a multi-hour log.

**Suggested content and ordering:**

1. **Cover/overview:** vehicle as provided/confirmed, adapter/protocol, capture date, actual duration versus recording gaps, selected PIDs and modules, data quality and sample count, whether GPS included, and a prominent “not a professional diagnosis” statement.
2. **Summary statistics:** min/max/mean where mathematically useful, timestamps for peaks/lows, time in different fuel-control states, communication interruptions, and other well-defined metrics. Distinguish count of **samples** from count of **unique events**. Suppress meaningless stats for categorical/unsupported PIDs.
3. **Overview graphs at the beginning:** per-PID or relevant grouped plots with actual timestamps, min/max markers, annotated intervals, and visible gaps. Never silently connect missing segments. For very long sessions, overview graphs plus zoomed event windows are more useful than page after page of raw samples.
4. **Event index:** list *all automatically flagged events* by default, with time, category, significance/uncertainty, and jump/reference to detailed section.
5. **Event detail sections:** for each event show the timestamp/elapsed position, trigger measurements, 10–30 second contextual mini-chart (configurable), nearby readings and sample ages, Bob's **pre-written cautious explanation**, and user comments.
6. **Selected manual annotations:** each user annotation has an inclusion checkbox; included annotations appear in time order. Automatic events remain present by default, with a clear ability to identify detector false positives rather than quietly deleting evidence.
7. **Optional appendices:** module/DTC status if captured during the same session, freeze frames if supported, methodology/thresholds and sampling limitations, and optional route thumbnail or map reference **only with GPS-export consent**.

**Implementation:** Generate with browser-based HTML/CSS print styles and `window.print()` / Save as PDF, or local client-only PDF generation if needed. No upload or LLM required. Content expands to 3, 5, or many pages based on actual events; page breaks and a repeated header/footer should remain legible.

**Acceptance/tests:** empty session, no auto events, many annotations, three-/seven-hour sessions, category labels, exact times, telemetry gaps, missing speed, localization and unit display, long tables, print page breaks, privacy toggle, legacy CSV with reduced metadata. Test report export with all actual code details only where the source session included them.

### F9 — Language selection and offline localization (Released in v1.8; native review pending)

**Decision (updated from Cloudflare data: US 2.33k, France 240, Singapore 200, China 170, Germany 150, Japan 130, Taiwan 90, India 90, Switzerland 70):** the first languages are French, German, Spanish, Japanese and Simplified Chinese. Scope is the core app only, with AI-drafted static bundles labelled "AI" until native speakers review them. The candidate list below is the original proposal and is kept for history.

**Goal:** Make WOBD—including Bob, warnings, connection errors, live-data labels, replay, reports, and help—usable in languages other than English without per-user translation charges.

- Add a language selector to the top bar. Detect `navigator.languages` as a *suggestion*, not an irreversible country-based assumption. English remains available; use English fallback for missing keys.
- Use versioned translation bundles (JSON) and stable string keys, with placeholders for codes, VIN-free vehicle descriptions, numbers, units, protocol names, and timestamps. **Never translate raw code identifiers, vehicle data, or user-entered notes automatically without consent.**
- Bob's state-machine messages must use translation keys and carefully interpolated values. DTC explanations need a distinct review plan for safety-relevant automotive terminology.
- Generate candidate translations **at development time** using translation software/LLMs, commit static results, and review them with native speakers where possible. Runtime operation remains free/offline for language packs cached by the app. Add missing-key/placeholder-validation tests.
- Do not depend on a legacy Google Website Translator widget remaining available. Investigate any third-party terms/cost before adopting it; browser built-in page translation can remain an optional user workaround.
- Use Cloudflare country counts as **directional**, not proof of native language or human visits. On Oct 20 the user observed last-24-hour counts: United States 93, Germany 15, Finland 12, Czech Republic 9, Indonesia 7, Netherlands 3, Norway 3, China 2, France 2. Compare 7-/30-day trends and optional anonymous **actual language selections** before committing to a large translation matrix.
- Initial candidates: **German, Finnish, Czech**, followed by Indonesian and Dutch if evidence persists. Prioritize correctness over quantity; get critical diagnostic/safety text reviewed.
- Localize date/time, decimal separators, temperature/distance/pressure display where supported; keep raw recorded values and PID decoding units unchanged.

**Acceptance/tests:** missing translations, interpolated placeholders, dynamically generated Bob messages, small-screen top bar, language switch mid-session, offline mode, print/export, numbers/dates, corrupted language packs and fallback, strings of varied length.

### F10 — Module-aware reporting and compatible vehicle validation (Proposed; small–medium)

- Reuse v1.4 All Modules / per-ECU tabs and inferred-address confidence in all new reports and recordings. Per-ECU signal attribution is optional when the adapter/protocol cannot provide reliable headers.
- Preserve status by **service, module, and scan time**; a blank or unavailable Mode 0A does not become “no permanent codes.”
- Validate CAN 11-bit 500k on a consented modern vehicle (possibly the previously tested Ranger), starting in automatic mode. If it fails, capture the **new** traffic log before using an override. Avoid changing firmware or clearing codes during compatibility testing.
- Build deterministic CAN multi-frame VIN responses, differing ECU PID bitmaps, legacy J1850 checksums, null/unknown module source, module-address alias uncertainty, and protocol failure fixtures.

**Acceptance/tests:** per-module statuses match overall MIL without retransmission double-counting; printable overall/ECU breakdown; v1.4 tests pass on simulated CAN and legacy replies; hardware claims limited to vehicles actually tested.

### F11 — Mode 02 freeze frame and comparison (Prior-plan carryover; medium)

- Implement supported Mode 02 record/parameter discovery with exact service/record/response checks, reuse verified Mode 01 formulas where applicable, and associate a record to a DTC only if returned data supports it.
- Show the reported fault-time context with its source and missing values honestly.
- Add side-by-side or overlaid session comparisons with independently sampled timestamps and no fabricated synchronization.

**Acceptance/tests:** supported/partial/none, unsupported vs malformed, per-ECU replies, stale/missing values, multi-frame, old replay compatibility.

## 5. Dependency-oriented delivery plan

| Priority | Increment | Depends on | Deliverable | Relative effort |
| --- | --- | --- | --- | --- |
| **P0** | Re-check live v1.4 code/test baseline and update audit statuses | Current repository | Accurate implementation inventory; green tests | Small |
| **P1** | Wall-clock playback and annotation-only review page | Existing CSV replay | Useful review of today's recordings | Small–medium |
| **P1** | Connection-aware Bob messages / protocol-search fallback | Existing error classifier and vehicle selection | Better failed-connection guidance | Small |
| **P1** | Fuel-level `012F` decoder and availability UI | PID catalog/discovery | Extra gauge only on supporting cars | Small |
| **P2** | VIN confirm/fallback/save flow | Existing `0902` probe | Faster setup, privacy-respecting | Small–medium |
| **P2** | Deterministic event detectors and event annotations | Timestamps + metadata | Explainable anomalies / false-positive handling | Medium–large |
| **P2** | Printable session report (summary, graphs, event index/details) | Review/events | Mechanic-friendly multi-page PDF via print | Medium–large |
| **P1** | Streaming CSV parser, raised size cap, render-time downsampling | Existing CSV replay | Large legacy recordings import without memory blowup | Small–medium |
| **P2** | IndexedDB incremental persistence and best-effort recovery | Recorder refactor | More reliable long-trip session capture | Large |
| **P2** | `.wobd` writer/reader (in-house ZIP), spec, fixtures, lossless CSV migration | Persistence + approved spec | Versioned full-fidelity export/import | Large |
| **P3** | Geolocation opt-in capture, accuracy model, and route sync | Session timestamps + persistence | Location-aware recordings | Medium–large |
| **P3** | Offline route visualization (no tiles) | Recorded locations + replay events | Private, clickable route / synchronized data | Medium |
| **P3** | Optional Mapbox tile layer | Offline route view + token/cost safeguards + approval | Online basemap, separately consented | Medium |
| **P3** | Initial offline translation bundles | String-key inventory | English + first reviewed languages | Medium, ongoing |
| **P3** | Freeze frames, multi-session comparison, wider CAN hardware validation | Decoder catalog + session viewer | Deeper diagnostics and confidence | Medium–large |

**Practical order for limited Copilot usage:** Finish P0, then implement the playback wall clock and annotations first. These immediately improve existing CSV files; richer storage, anomaly analysis, GPS, maps, and translation can follow independently. Avoid implementing a large feature without a testable stop point.

## 6. Test fixtures and definition of done

Required example fixtures or traces (with any real VIN/location redacted):

- **Legacy successful:** PT Cruiser J1850 VPW `ATSP0 → A2`, two responders (`486B10`, `486B18`), VIN `0902 NO DATA`, corrected source-aware DTC/MIL handling.
- **Deliberate protocol failure:** PT Cruiser `ATSP6`, `0100 CAN ERROR`, `0902 CAN ERROR`, `BUS_ERROR` without mislabeling as adapter disconnect.
- **Modern CAN:** simulated and, eventually, a consented physical vehicle with genuine `0100`, DTC, and Mode 09 responses; do not infer compatibility from old Ranger v1.1 attempt.
- **Recording format:** seeded 1/3/7-hour fixtures, hostile ZIPs, and lossless-migration CSVs (study §7.9, §7.11); generated by script from the tracked real CSV, not committed.
- **Recording interruption:** 4½-minute gap with an intentional ignition-off annotation, not an automatic confirmed engine-stall diagnosis.
- **Normal driving:** real non-stalling sample trips that include ordinary shifts and speed changes; detectors must avoid overcalling them.
- **Intermittent fault simulation:** measured RPM oscillation, sudden RPM drop, open-loop transitions, stale MAP, voltage dip, polling gap, and real communication loss, labeled with confidence and context.
- **Geolocation/privacy:** inaccurate coordinate, permission denied, missing data, home-address redaction, no-location export.
- **Localization:** missing keys, placeholder substitutions, report printing, English fallback.
- **Reports:** few-minute and several-hour data, many events, no events, unsupported PIDs, and missing timestamps.

### Pre-release checklist (manual, real hardware and browsers)

Automated Node and headless-browser results are evidence, not release sign-off. Before any release containing the streaming importer or later recording work, record date, device, browser version, and outcome for each:

- [ ] **Chrome file-picker path:** choose a CSV with the Replay page's file input (this exercises `file.stream()`; the headless check only covered link loading via `fetch`). Cover the real PT Cruiser file, a CSV with a BOM and CRLF line ends, a non-WOBD CSV (friendly error), and a file near the 128 MiB cap.
- [ ] **Real ChromeOS device:** repeat the above on ChromeOS Chrome, including a multi-hour synthetic file; observe memory, UI responsiveness, and tab stability. Node `maxRSS` figures are not browser heap measurements.
- [ ] **Replay with a large recording:** play, seek, resize, and hover on a multi-hour recording on the ChromeOS device (see the render-time downsampling proposal).
- [ ] Safari and Firefox are best-effort for review/import; note results if tested.
- [ ] Later stages add: live recording with IndexedDB persistence and crash recovery, `.wobd` export/import on ChromeOS, and CSV compatibility checks.

Each stage is done only when: deterministic tests pass; no regression in serial queue/connection/gauge/scan/export/record-lock behavior; docs accurately describe support and limitations; user-facing messaging is cautious; no unapproved paid service or data upload was introduced; and any physical vehicle validation is logged separately with date, car, adapter, protocol, and outcome.

## 7. Risks, explicit non-goals, and cautions

| Risk | Guardrail |
| --- | --- |
| Older ECUs cannot supply a VIN or fuel level | Treat `NO DATA` as normal capability absence; manual fields/annotations remain available. |
| Incorrect inferred ECU name | Always retain raw source address, protocol, and `inferred` confidence; unknown stays unknown. |
| Wrong PID formula or ambiguous response length | Require verified standards definitions and byte-level fixtures; SAE J1979-DA is normative where applicable. |
| Slow legacy protocols | Use bounded sequential polling and priority scheduling; show actual measured cadence, not just demo estimates. |
| Anomaly flags look like diagnoses | Describe measurements and alternative explanations; review surrounding context; permit false-positive tagging. |
| Fuel trims / voltage / RPM sampled at different times | Never present sequential samples as simultaneous or fake missing points. |
| Browser closes / OS evicts local data | Best-effort incremental persistence, visible failures, backups/export, and deletion controls. |
| GPS may reveal home, workplace, or habitual routes | Explicit opt-in, local storage, redaction, no GPS in reports without authorization. |
| Location/map use incurs fees | Assess Mapbox plans/quotas, provide offline/no-map mode, use cached/static local review. |
| Automated translations distort safety terms | Human review of critical content and prominent original English option; avoid paid runtime translation. |
| Driver distraction | Preserve blocking recording screen; only post-drive editing and route exploration. |
| Testing encourages unsafe road use | No deliberate fault-reproduction drives, especially with known intermittent stalling. Use simulation or controlled shop tests instead. |

## 8. References and repository maintenance

- Normative PID/formula source identified in original audit: [SAE J1979 Digital Annex](https://saemobilus.sae.org/standards/j1979da_202510-j1979-da-digital-annex-e-e-diagnostic-test-modes).
- Public secondary cross-check: [OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs).
- VIN decoding candidate: [NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/).
- Recording format study: [Recording-Format-Study.md](./Recording-Format-Study.md).
- Keep formula references next to code/tests, and update `README.md`, How-to, design doc, service-worker cache version, and regression scripts when relevant user-visible features ship.

## 9. Decisions awaiting approval

- **Recording format:** architecture and study revision 2 approved (IndexedDB working store, `.wobd` ZIP with JSONL chunks, CSV retained, streaming, no SQLite). Still to decide: media type and extension, default per-row latency/quality, import caps, the Chrome/Edge 89–102 policy, and the ratio-warning behavior (study §9); blockers in study §11.
- **Storage thresholds:** confirm warning levels (~70 %/~90 %), minimum free quota to start recording, batch flush interval, which optional data degrades first, and default retention/eviction policy.
- **Clock-change tolerance:** confirm the wall-vs-monotonic discrepancy threshold and the cross-segment gap handling shown to users.
- **Legacy annotations:** confirm sidecar-with-fingerprint storage versus embedding annotations into a new export format, and the "large gap" threshold default.
- **Mapbox:** go/no-go after cost/terms review; token restrictions and spending cap; whether the offline polyline alone is sufficient for the first release.
- **Annotation editor scope:** standalone review page first, or integrate in current replay immediately?
- **Auto-event configuration:** default sensitivity profiles and distinction between informational versus suspected abnormal events.
- **Report choice:** all automatic detections by default, optional include/exclude for each user annotation; decide how dismissed auto-events appear in an appendix.
- **Location:** opt-in per session versus remembered consent (recommend per-session toggle).
- **VIN:** external vPIC lookup only on consent, or offline partial decoder first?
- **Languages:** initial pilot after 7-/30-day traffic review and whether critical messages receive native-speaker review.

---

**End of planning document.** This roadmap is intentionally additive, conservative, and test-driven. It records proposed work without asserting it has shipped.