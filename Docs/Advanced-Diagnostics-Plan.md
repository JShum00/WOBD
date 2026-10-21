# WOBD Advanced Diagnostics — Audit and Implementation Plan

Oct 20, 2026

## Purpose and approval gate

This document records the repository audit and proposes a staged path for the
advanced diagnostic update. It is a plan, not an implementation: no feature
code should be changed until this plan is reviewed and approved.

WOBD is a static, client-side application. The proposed work keeps vehicle
communication and recordings in the browser, uses standard read-only OBD-II
requests for routine diagnostics, preserves the existing gauge and replay
flows, and does not add a server or a runtime dependency.

## Architectural assessment

### What is already implemented

| Capability | Current implementation |
| --- | --- |
| Web Serial | `js/serial.js` owns the Web Serial port lifecycle, reader/writer, browser checks, and disconnect handling. |
| Adapter initialization | `js/smartbauder.js` probes baud rates; `js/app.js` resets/configures the adapter through `ELM327`. |
| Command queue and parsing | `js/elm327.js` serializes commands until the ELM prompt, cleans echo/noise, and identifies adapter errors/timeouts. `js/obd.js` converts response lines into byte messages and reassembles basic CAN multi-frame responses. |
| Protocol information | `js/obd.js` parses the protocol number; `js/conninfo.js` gathers protocol, adapter, voltage, response-time, and ECU-count information. |
| Supported PID discovery | `js/obd.js` sends `0100`, then requests `0120`, `0140`, and subsequent `0x20` ranges through `01E0` while the preceding bitmap advertises continuation. Its bitmap decoder uses the standard bit ordering, and it handles multiple reply messages. |
| Supported/decoded distinction | `LIVE_PIDS` is the decoder-backed list. Discovery filters gauge choices to supported decoders; `js/gauge-picker.js` shows a separate, non-selectable list of supported but undecoded PIDs using `PID_NAMES`. |
| Live polling and gauges | `js/app.js` polls selected PIDs sequentially; `js/obd.js` defines the available gauges and slow-PID cadence; `js/ui.js` renders them. The picker in `js/gauge-picker.js` preserves per-connection manual selection and presets and estimates refresh timing. Battery voltage is queried with adapter command `ATRV`, not an ECU PID. |
| Trouble codes | `js/obd.js` reads Mode 01 PID 01 MIL/count status, Modes 03/07/0A DTCs, and Mode 04 clear confirmation. `js/bob.js` and `data/codes.json` / `data/generic/` provide offline descriptions. The scan UI and print report are in `js/app.js` and `js/ui.js`. |
| Recording and replay | `js/recorder.js` records valid selected-gauge readings in memory and exports CSV. It includes a driving lock and a timeout-based “lost” indicator. `js/replay-data.js` parses the CSV; `js/replay.js` renders timestamped playback and charts. |
| Simulator and tests | `js/demo.js` provides CAN, older ISO/J1850-style, limited-PID, multi-ECU, no-PID, drive, and unplug demonstrations. Node scripts test discovery/picker behavior, recorder logic, replay, and baud detection. |
| Reports and documentation | `js/ui.js` builds the printable scan report; `js/report.js` loads published adapter reports. `Docs/WebAppDesignDoc-WOBD.md` and `README.md` document the current architecture and product behavior. |

### Current gaps and limits

- **Discovery exists, but ECU attribution is lost.** `readSupportedPids`
  merges all valid ECU bitmaps into one `Set`, and the adapter is configured
  with headers off (`ATH0`). Consequently, source ECU IDs are unavailable and
  support advertised by different ECUs cannot be distinguished. The chain is
  bounded at `0xE0`; any further range must be confirmed as applicable before
  adding it, rather than requested speculatively.
- **Discovery validation is partial.** The bitmap parser checks service, base
  PID, and a minimum of four data bytes, but accepts extra bytes and does not
  retain a per-ECU response or a structured error for each range. Individual
  live reads match service and PID but do not validate the complete
  specification-defined response length before decoding.
- **The parameter inventory is partly hardcoded.** `LIVE_PIDS` contains 14
  Mode 01 decoders; `PID_NAMES` is a partial name list. The picker is limited
  to these known decoders plus an undecoded list, not a full searchable
  catalog with descriptions, expected lengths, ECU source, or last-reading
  state. Supported PIDs describe standardized OBD-II data availability, not
  every physical sensor installed in a car.
- **Monitoring is manual, not automatic.** Users choose gauges and can use
  presets; fresh connections select the old default set, limited to the
  detected vehicle's supported decoders. Polling is sequential and already
  avoids overlapping serial requests, but uses a fixed fast/slow cadence
  rather than priorities or a configurable automatic mode.
- **Missing live data has little context.** A missing or failed read becomes
  `null`; the UI shows a dash but does not distinguish unsupported,
  undecoded, temporarily unresponsive, malformed, or stale data. The polling
  loop catches read errors as null, so it does not expose the error type,
  raw response, or request duration to the interface or recording.
- **DTC coverage is limited.** The app reads stored Mode 03, pending Mode 07,
  and permanent Mode 0A codes, plus Mode 01 status. It does not retrieve freeze
  frames (Mode 02) or emissions readiness data. Codes are labeled by service
  and by ECU source when available, but have no first/last observation times.
  Clearing is a separate, explicitly confirmed Mode 04 action.
- **Recording is not yet a flight recorder.** Samples are held in page memory
  until the user saves a CSV. Dropouts are omitted; rows lack raw replies,
  ECU source, request duration, connection/error events, and separate
  monotonic time. There is no rolling pre-event buffer, event detection,
  post-event capture, JSON export, or crash recovery. The existing “lost”
  state is only a UI/drive-lock signal, not a recorded event.
- **Replay is CSV-focused.** It plots known gauge samples and reports unknown
  PIDs, but has no event markers, freeze-frame display, comparison between
  sessions, or communication-state timeline. The existing report is a scan
  report, not a diagnostic-session report.
- **Simulator coverage is useful but incomplete.** Existing scenarios
  exercise multi-ECU discovery and communication loss, but do not yet model
  distinct ECU attribution, Mode 07/0A, freeze frames, malformed live
  replies, or a deterministic set of the requested intermittent-fault
  scenarios.

### Components to reuse and changes recommended

- Keep `js/serial.js` as the transport boundary and `js/elm327.js` as the
  single serialized command queue. Extend their result/error metadata only
  where the feature needs it; do not introduce parallel writers or a second
  queue.
- Evolve `js/obd.js` into a typed-by-convention diagnostic catalog: retain
  existing decoder definitions and gauge keys, but add explicit metadata,
  response validators, and separate service-specific decoders. Keep DOM code
  out of this module so deterministic Node tests remain possible.
- Preserve per-ECU response identity before composing vehicle-level
  availability. Avoid a global OR-only support map; expose both ECU-specific
  capabilities and a safe vehicle-level view for the UI.
- Extend `js/app.js` as the orchestration/state boundary, but move polling
  policy and recording/event logic into pure modules where practical. Keep
  `js/ui.js`, `js/gauge-picker.js`, and `js/replay.js` responsible for
  rendering and user interaction, not protocol interpretation.
- Extend `js/recorder.js` and the existing replay pipeline instead of
  replacing them. Preserve existing CSV compatibility while defining a
  versioned export shape for richer recordings.
- Expand `js/demo.js` and the existing Node test-script pattern with fixed
  fixtures. Keep demos useful for current workflows and ensure ordinary
  automated tests never need a real car.
- Update `README.md`, the How-to guide, and the design documentation only
  alongside user-visible behavior; keep authoritative PID formula/source
  references close to the decoder tests or catalog documentation.

## Recommended implementation stages

Stages are ordered by dependency. Each stage is a separately reviewable
change; do not combine all stages into a single release-sized patch.

### Stage 1 — Protocol parsing and source-aware PID discovery

**Scope:** preserve response headers/ECU identity through parsing where the
adapter and protocol expose them; validate positive service/PID and exact
bitmap payload shape; represent each ECU's supported ranges separately;
retain current handling of older adapters and partial discovery; define
structured discovery outcomes. Investigate and document which upper ranges,
including `0x1C0` if applicable, are valid for the targeted standard before
extending the bounded chain.

**Acceptance:** known bitmaps decode with leading zeroes and correct bit
ordering; wrong service/base, truncated/overlong payloads, malformed lines,
`NO DATA`, timeout, and unsupported commands do not become false support;
multiple ECU maps remain distinct; continuation is requested only when
advertised; failure at a later range preserves valid earlier results; no
infinite or duplicate requests.

**Tests:** deterministic response fixtures for each boundary, with and
without headers, one/multiple ECUs, older non-CAN formats, and all supported
continuation pages. Re-run `scripts/test-supported-pids.mjs`.

### Stage 2 — Decoder catalog and parameter status model

**Scope:** add one authoritative catalog for standardized PIDs, including
name, description, category, unit, expected payload size, decoder status,
monitoring eligibility, and priority. Keep existing gauge definitions
compatible. Implement commonly useful decoders only after checking
specification definitions, scaling, signedness, and response length against
reliable technical sources. Start with `011C`, `0121`, `0131`, `0142`, and
well-defined fuel/air, equivalence-ratio, pressure, oxygen, and catalyst
temperature PIDs. Keep adapter voltage clearly separate from ECU module
voltage.

**Acceptance:** each decoder has formula and response-length fixtures;
malformed/short data never produces a numeric zero or a successful reading;
catalog states distinguish unsupported, supported-undecoded, supported but
not responding, malformed, and valid reading. Current gauge keys/units and
old replay files continue to work.

**Tests:** table-driven decoder boundary/formula tests, including signed and
multi-byte values; tests for response validation and state transitions.

### Stage 3 — Vehicle parameter catalog and automatic monitoring

**Scope:** populate a searchable, categorized catalog from actual discovery
and decoder metadata. Add explicit Auto and Manual modes. Auto selects only
supported, decoded, continuously monitorable parameters; Manual retains
individual choices and current presets. Introduce a sequential prioritized
scheduler with conservative defaults, stale/error states, and a clear route
to stop/cancel polling. Do not poll discovery/status-only or unsupported
parameters as continuous sensors.

**Acceptance:** the UI labels support and decoder state honestly, shows last
valid value/time and source when known, and marks demo readings as simulated.
Auto and Manual cannot overlap requests; Auto respects eligibility and
limits ECU load; users can return to existing manual behavior. The 2001
Chrysler PT Cruiser example is handled by reported capabilities, not a
vehicle-specific branch.

**Tests:** scheduler ordering/cadence, no overlap, cancellation/reconnect,
old-protocol latency, all-supported selection, manual selection persistence
for a connection, and unavailable/stale rendering.

### Stage 4 — Stored, pending, and permanent DTC status

**Scope:** generalize DTC parsing to retain service and ECU source, then query
Modes 03, 07, and 0A where supported. Preserve the existing offline
description lookup and explicit Mode 04 confirmation. Show unsupported
services as unavailable, not as an empty “no codes” result.

**Acceptance:** each displayed code is labeled stored, pending, or
permanent, with source service/ECU when known; unsupported Mode 0A does not
fail the scan; no routine scan clears codes. Existing DTC descriptions and
print report remain available.

**Tests:** CAN and legacy code payload fixtures, empty versus unsupported
service responses, malformed responses, duplicates, and multi-ECU results.

### Stage 5 — Freeze-frame retrieval

**Scope:** implement Mode 02 record/parameter discovery and decoding using
the shared catalog where PID semantics are identical. Associate a record
with a DTC only where the returned protocol data supports that association.
Add a viewer that includes only returned values.

**Acceptance:** no missing record or parameter is fabricated; unsupported
and unavailable are distinct; the viewer identifies record, code
association (if present), units, source, and data timestamp/context.

**Tests:** supported, partial, empty, unsupported, malformed, and
multi-frame fixtures plus decoder reuse tests.

### Stage 6 — Flight recorder, event capture, and recovery

**Scope:** extend recordings with wall-clock and monotonic sample times,
PID/value/unit, source, raw response, duration, protocol, adapter and
connection/error events. Add a bounded rolling buffer, configurable
pre/post-event windows (initial proposal: 30 seconds before and 60 seconds
after), user markers, and conservative event markers. Persist incrementally
in browser storage (IndexedDB is the leading option) with explicit storage
status, limits, recovery, and deletion/export behavior. Preserve the current
CSV format for legacy/manual exports and add a versioned JSON export for
full-fidelity sessions.

**Acceptance:** a communication loss records an explicit event and preserves
the last real samples; missing values are never fabricated; sequential
samples are not labeled simultaneous; a suspected stall uses contextual
evidence and is labeled uncertain; recording survives page interruption to
the extent browser storage permits, with any persistence failure clearly
surfaced.

**Tests:** injected clock and deterministic fault fixtures for rolling
windows, pre/post capture, event ordering, request duration/errors,
interrupted persistence recovery, storage limits, CSV/JSON round trips, and
legacy CSV compatibility.

### Stage 7 — Diagnostic visualization and report integration

**Scope:** add catalog/status tables, timestamp-aware charts, communication
gaps and event markers, freeze-frame and DTC-status presentation, and
session comparison. Extend replay to consume the versioned session format
while retaining CSV replay. Add selected diagnostic context to reports only
when the underlying data was actually captured.

**Acceptance:** charts use original per-sample timestamps and visibly retain
gaps; no line or table implies an unavailable measurement; comparison
handles different sampling rates without silently interpolating; printable
reports identify service/status/source and carry existing disclaimers.

**Tests:** chart data transforms with irregular samples/gaps, comparison
without fabricated samples, replay fixtures for old/new formats, and report
rendering with partial data.

### Stage 8 — Simulator, regression completion, and documentation

**Scope:** add deterministic scenarios for advertised ranges, per-ECU
support, supported-undecoded PIDs, `NO DATA`, malformed replies, connection
loss/recovery, DTC service support, freeze-frame absence, interrupted
recording, normal idle, gradual RPM drop, and abrupt shutdown. Document
discovery, services, monitoring modes/priorities, unavailable readings,
generic OBD-II limits, recording/export, and adding decoders. Include the
2001 PT Cruiser as an illustrative older-protocol example, without embedding
its specifics in the generic engine.

**Acceptance:** all listed scenarios can run without hardware; existing
demos and workflows remain compatible; docs do not promise diagnosis of a
specific component or claim physical hardware validation.

**Tests:** run all existing scripts plus new deterministic suites; perform
manual demo smoke tests for scan, live data, disconnect, record, export, and
replay. Hardware validation, if performed later, is reported separately.

## Cross-cutting risks and guardrails

| Risk | Mitigation |
| --- | --- |
| Header handling differs across legacy protocols/adapters | Make source identity optional; validate each supported protocol's response layout with fixtures; do not make ECU attribution a prerequisite for useful decoded values. |
| Broad automatic polling saturates older ECUs | Use a single queue, conservative priorities/cadence, measured request latency, and explicit Auto eligibility; test slow J1850/ISO cases. |
| Standards formulas or payload layouts are misapplied | Add a decoder only with a verified definition, byte count, signedness, and formula test; do not infer values from names. |
| “Supported” is confused with “sensor installed” or “working” | Label the catalog as standardized OBD-II parameters and show support, decoder, response, and freshness as separate facts. |
| Event heuristics overstate a failure | Use “suspected”/“communication lost” labels, multiple contextual signals where available, and preserve user markers; never diagnose a component from generic data alone. |
| Browser storage quota, eviction, or crash limits reliability | Chunk writes, bound retention, surface storage/permission/quota failures, and offer immediate export; describe browser persistence as best-effort, not guaranteed durability. |
| Rich recordings break existing replay/users' files | Keep legacy CSV parsing and export behavior; version the richer format and test old/new round trips. |
| Privacy expectations change with persistent local data | Keep all data local; explain persistence and provide explicit clear/delete controls before enabling durable session storage. |

## Baseline verification

The existing regression scripts were run during this audit:

| Command | Result |
| --- | --- |
| `node scripts/test-supported-pids.mjs` | 14/14 passed |
| `node scripts/test-recorder.mjs` | 21/21 passed |
| `node scripts/test-replay.mjs` | 9/9 passed |
| `node scripts/test-smartbauder.mjs` | 20/20 passed |

These are software tests using fake adapters/fixtures; they do not verify
compatibility with physical vehicles or adapters.

## Implementation progress

Following the user's direction to proceed, the current working tree includes:

- The update banner now links to a contact page embedding the supplied Google
  Form. The iframe is responsive up to its original 640 px width; the contact
  page is included in the service-worker shell. Google Forms receives
  submitted responses.
- Supported-PID discovery can temporarily enable ELM headers, retain known
  CAN/legacy ECU sources, build per-ECU support maps, strictly validate the
  four-byte support bitmap, and restore compact/header-off formatting after
  discovery. Unsupported header controls fall back to source-unknown discovery.
- The Mode 01 decoder registry now carries expected payload lengths and adds
  common fuel pressure, distance, rail pressure, catalyst temperature, module
  voltage, equivalence ratio, ambient temperature, oil temperature, and OBD
  standards compliance decoding. Malformed lengths raise an explicit
  `MALFORMED_RESPONSE`. The control-module voltage is kept distinct from
  adapter voltage.
- The gauge picker preserves the former manual default, adds automatic
  supported/decoded monitoring with priority intervals, and exposes a
  searchable categorized parameter catalog. The live-data panel also has a
  collapsible value/status/last-success table. The multi-ECU demo returns
  examples of newly decoded parameters.
- The scan now queries stored, pending, and permanent DTC services separately.
  Unavailable services are shown explicitly; displayed codes retain their
  status and ECU source where header data is available. CAN single- and
  multi-frame replies are parsed per ECU, and the print report includes service
  availability. Mode 04 remains a separate confirmed action.
- Formula references consulted: the SAE J1979 Digital Annex is the normative
  source (<https://saemobilus.sae.org/standards/j1979da_202510-j1979-da-digital-annex-e-e-diagnostic-test-modes>).
  Public PID tables used for cross-checking include
  <https://en.wikipedia.org/wiki/OBD-II_PIDs>. The limited decoder set is not
  a claim that every possible PID has been implemented or tested on hardware.

The remaining major stages are Mode 02 freeze-frame retrieval, durable rolling
flight recording with event capture, timestamp/gap-aware session visualization
and comparisons, and expanded deterministic simulator coverage/documentation.
Decoder formulas beyond the currently tested set still require source-by-source
verification before they are added.

## Review request

The staged plan remains the reference for the remaining work. No claim of
physical vehicle or adapter compatibility has been made; only the local demo
flow and deterministic software tests have been exercised so far.
