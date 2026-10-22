# WOBD Recording Format — Feasibility Study

**Date:** October 21, 2026 (revision 2)
**Status:** Revision 2 approved by the project owner (architecture: IndexedDB working store, `.wobd` ZIP with JSONL chunks, CSV retained, streaming import, render-time downsampling, no SQLite). **Approval of the specification is not implementation approval, and nothing in the repository implements it.** All measurements come from throwaway prototypes (Node scripts and a headless-browser test page) that were deleted; they are evidence, not production code. Production code must be written, reviewed, and tested separately, and every [measured-*] figure must be re-measured against it.
**Companion to:** [Advanced-Diagnostics-Plan.md](./Advanced-Diagnostics-Plan.md), F4 / F6 / F7 / F8.

**Revision 2 resolves six review items:** streaming import and chart downsampling (§7.8), the exact ZIP implementation and browser matrix (§7.7), lossless CSV migration (§7.9), distinct gap states (§7.10), performance fixtures and measured-versus-assumed labeling (§7.11), and repository tracking (§7.12). Evidence labels used throughout: **[measured-real]** from the real PT Cruiser recording, **[measured-synthetic]** from synthetic fixtures built by tiling that recording, **[measured-browser]** from headless Chromium 154 and Firefox 158 on Linux, and **[assumed]** for everything not yet measured (notably all CAN rates, enriched data, and Safari).

## 1. Summary and recommendation

| Decision | Recommendation |
| --- | --- |
| Working store during recording | **IndexedDB**, with chunked records whose payload is already the export encoding. |
| Full-fidelity file format | **Documented, versioned `.wobd` ZIP archive**: JSON metadata plus chunked **JSON Lines** telemetry. |
| Interchange / legacy | **CSV stays supported forever** for import and export. It is never auto-converted or deleted. |
| SQLite | **Do not adopt now.** Revisit only if cross-session queries become a real requirement (triggers in §6). |
| Chunk encoding | **JSON Lines, not custom binary.** Measured: after deflate, binary is no smaller (§3.2). |
| ZIP container | **In-house ZIP reader/writer (~250 lines, no third-party library)** that owns the container; the browser supplies only raw deflate (`CompressionStream`/`DecompressionStream('deflate-raw')`), plus `crypto.subtle` and in-house CRC-32. `CompressionStream` alone is **not** a ZIP implementation (§7.7). |
| Import | **Streaming** for CSV and `.wobd`; peak memory scales with the compact in-memory columns, not the file size (§7.8). |
| Charts | Render-time **min/max-per-pixel downsampling over untouched raw samples** (§7.8). |
| CSV migration | **Lossless by construction**: original bytes embedded verbatim by default, plus row-level preservation of every field (§7.9). |
| Gaps | Distinct, evidence-labeled states; **a gap or missing RPM never implies an engine stall** (§7.10). |

Rationale: WOBD is a no-build, dependency-free static site. In the prototype the `.wobd` approach was **≈21–29× smaller than CSV** [measured-synthetic] (§4), is debuggable with any unzip tool, and needs no WASM, no cross-origin-isolation headers, and no schema-bearing binary blob. A second storage engine is unnecessary because IndexedDB is already required for crash recovery.

## 2. Baseline: what WOBD records today

Read from [recorder.js](../js/recorder.js), [replay-data.js](../js/replay-data.js), and the real recording `reports/vlinker-fs-usb/chrysler/2001/pt-cruiser/wobd-recording-2026-10-02-192055.csv`.

- **Model:** one CSV row per valid reading: `timestamp, elapsed_ms, pid, name, value, unit, protocol, baud`. `protocol` and `baud` are repeated on every row. Dropouts are skipped, never written as blanks.
- **Whole recording in RAM:** `Recording.rows` holds everything until `toCsv()` builds a single string. A crash or reload loses the recording.
- **Whole-file import:** `parseRecording()` reads the full text, builds an array of string-arrays for every row, then builds per-PID series. `MAX_FILE_BYTES` is 20 MiB.
- **Measured real file** (PT Cruiser, J1850 VPW, 9 prioritized PIDs): 3,035 rows, 251,096 bytes, 446.9 s → **82.7 B/row, 6.79 rows/s**, median inter-row gap 144 ms. The file is one continuous 7.4-minute capture; the 17- and 28-minute recordings mentioned elsewhere in the plan are not in the repository, so the tests below should not assume they exist.

## 3. Measurements

All figures were measured on the real file above unless marked *hypothetical*.

### 3.1 Compression of the current CSV

| Encoding | Bytes | Ratio vs CSV |
| --- | --- | --- |
| CSV (current) | 251,096 | 1× |
| CSV + deflate (level 6, what ZIP/`CompressionStream` give) | 33,810 | 7.4× |
| CSV + gzip 9 | 32,459 | 7.7× |
| CSV + xz | 24,432 | 10.3× |

### 3.2 Compact encodings of the same data

Dictionary-coded PID, delta-encoded elapsed time, raw value:

| Encoding | Uncompressed | Deflated | Per row deflated |
| --- | --- | --- | --- |
| JSON Lines `[dt_ms, pid_id, value]` | 40,710 B (13.4 B/row) | 9,563 B | **3.15 B** |
| Fixed binary (`uint32 dt, uint8 pid, float32 value`) | 27,315 B (9 B/row) | 9,750 B | 3.21 B |

**Finding:** a custom binary layout buys nothing once deflate is applied, and it costs debuggability, forward compatibility, and parser safety. JSON Lines is the clear choice. Caveat: this recording is a short, steady idle/drive with quantized values; longer, more varied drives will compress less, so plan for roughly **3–8 B/row** deflated, not 3.15.

### 3.3 Memory of the current parser (measured, Node, synthetic tiling of the real file)

| Rows | CSV size | Parse time | Added RSS |
| --- | --- | --- | --- |
| 24,280 (≈1 h at 6.8 rows/s) | 2.0 MB | 112 ms | ≈43 MB |
| 103,190 | 8.7 MB | 453 ms | ≈89 MB |

Roughly 10× the file size in RAM [measured-synthetic]. Superseded and extended by the larger measured runs in §4: the current parser peaked at about **+241 MB (7 h, 6.8 rows/s) and +983 MB (7 h, 30 rows/s)** above the Node baseline, which replaces my earlier extrapolation of ≈150 MB and ≈600 MB.

## 4. Sizes, memory, and timing for 1, 3, and 7 hours

### 4.1 Measured prototype results [measured-synthetic]

Six deterministic fixtures were generated by tiling the real recording's row sequence (PID mix, names, units, status strings) with ±1 % value noise and timing jitter. Scenario **A** uses the **measured** real rate (6.79 rows/s, J1850 VPW). Scenario **B** uses **30 rows/s, which is [assumed]**; WOBD has no measured CAN rate. Each stage ran in its own Node 20.20.1 process on the development machine; "peak" is `maxRSS` minus the 40 MB Node baseline. These are **not** browser or ChromeOS numbers.

| Fixture | Rows | CSV | Current parser peak¹ | Streaming import peak | Streaming import | `.wobd` size | CSV ÷ `.wobd` | Bytes/row | Export | Read + verify² | Downsample 13 PIDs → 1,200 px |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 1 h | 24,444 | 2.3 MB | n/r | +17 MB | 103 ms | 0.11 MB | 21× | 4.45 | 138 ms | 29 ms | 4 ms |
| A 3 h | 73,332 | 6.9 MB | +120 MB | +27 MB | 234 ms | 0.33 MB | 21× | 4.44 | 302 ms | 122 ms | 10 ms |
| A 7 h | 171,108 | 16.2 MB | +241 MB | +43 MB | 485 ms | 0.76 MB | 21× | 4.44 | 562 ms | 245 ms | 11 ms |
| B 1 h | 108,000 | 10.1 MB | n/r | +37 MB | 311 ms | 0.35 MB | 29× | 3.23 | 225 ms | 37 ms | 13 ms |
| B 3 h | 324,000 | 30.4 MB ⚠ | +432 MB | +66 MB | 852 ms | 1.04 MB | 29× | 3.22 | 507 ms | 96 ms | 17 ms |
| B 7 h | 756,000 | 71.5 MB ⚠ | **+983 MB** | **+81 MB** | 1.9 s | 2.44 MB | 29× | 3.22 | 1.1 s | 212 ms | 34 ms |

¹ `parseRecording()` from [replay-data.js](../js/replay-data.js) on the whole file; n/r = not run. ⚠ = over the current 20 MiB cap, so the replay page would refuse it today. ² The prototype reader materialized every decoded entry at once to check it; the real importer decodes one chunk at a time (§7.8), so this overstates reader memory.

All 756,000 rows read back from the B 7 h archive, and every other archive read back its full row count. The prototype's streaming store holds 17 B/row (`Float64` time, `Uint8` PID id, `Float64` value): 12.9 MB at 756,000 rows, which is why peak memory above is dominated by buffer doubling and the transient decode, not by the file.

Caveats that bound these numbers: the fixtures are periodic with only mild noise, so compression may be **optimistic** for a real, varied drive (the real file alone gave 3.15 B/row; synthetic gave 3.2–4.4); keep the **3–8 B/row** planning range. Numeric values were written as JavaScript numbers, which does not preserve original text such as `0.50` (see §7.9).

### 4.2 Enriched sessions [assumed]

Raw adapter replies, per-row latency/quality, and GPS are not in any measured recording. Assumed sizes: ≈45 B/row JSON and ≈12 B/row deflated for per-row enrichment; GPS at ≈0.67 fixes/s, ≈100 B/fix JSON and ≈28 B deflated. Projection: 7 h at scenario A is ≈9.4 MB JSON → ≈2.5 MB `.wobd`; at scenario B ≈35.7 MB → ≈9.5 MB. Treat these as planning budgets to be replaced by measurements (§7.11).

### 4.3 Conclusions

- The current CSV path already fails the 20 MiB cap at **3 h on a fast vehicle [assumed rate]**, and without the cap it would need about **1 GB** at 7 h [measured-synthetic]. A streaming importer needed **+81 MB** for the same file.
- Even the worst assumed case (7 h, fast CAN, raw replies, GPS) is **≈10 MB as a `.wobd`**, so a finished export can be assembled as an in-memory `Blob`; streaming to disk is an optimization, not a requirement.
- **IndexedDB layout matters more than file format.** One IndexedDB record per sample would cost an estimated 150–300 B/row of overhead [assumed; browser-dependent] — ≈43 MB at 7 h scenario A and ≈190 MB at B. Storing **chunk records whose payload is the JSONL bytes** costs the 13–45 B/row above, keeps size accounting exact, and lets export compress without transcoding.

## 5. Comparison

Ratings are relative. ✔ good, ◐ adequate with caveats, ✖ poor.

| Criterion | 1. CSV + JSON sidecars | 2. `.wobd` ZIP (chunked JSONL + JSON) | 3. SQLite (WASM) |
| --- | --- | --- | --- |
| **File size** | ✖ 82.7 B/row [measured-real]; ZIP-ing separately is manual | ✔ ≈3–8 B/row deflated; ≈21–29× smaller than CSV [measured-synthetic] | ◐ 4 KiB pages, typically similar to CSV or somewhat smaller [assumed]; **not compressed** unless wrapped again |
| **Compression** | ✖ none built in | ✔ per-entry deflate; store for already-compressed parts | ✖ none built in |
| **Browser compatibility** | ✔ everything | ◐ **Verified:** Chromium 154 and Firefox 158 [measured-browser]. **Documented minimums:** `deflate-raw` streams in Chrome/Edge 103, Firefox 113, Safari 16.4 [per web sources; re-verify at implementation]. **Gap:** Web Serial exists from Chrome/Edge 89, so Chrome 89–102 can record but not compress or decompress; handled by a stored-entry fallback and an explicit refusal message (§7.7). Safari **not tested** | ◐ needs Worker + WASM; persistent OPFS VFS needs cross-origin isolation headers (COOP/COEP) that also constrain third-party resources such as Mapbox; header-free `opfs-sahpool` is single-connection and less portable across browsers [assumed] |
| **Memory** | ✖ whole file as text and rows: +983 MB at 7 h / 30 rows/s [measured-synthetic] unless a streaming parser is added | ✔ streaming import +81 MB at the same size [measured-synthetic]; chunk-at-a-time decode | ✔ pages on demand [assumed] |
| **Streaming import** | ◐ possible only with a new streaming CSV parser (prototyped, §7.8) | ✔ read central directory via `File.slice`, then decode chunk by chunk | ✔ but only inside the SQLite VFS, so the file must be copied into it first |
| **Streaming export** | ✔ trivial append | ✔ per-chunk entries; finished file is small enough to build as a Blob; optional `showSaveFilePicker` streaming where available | ◐ serialize the DB image; size is uncompressed |
| **Incremental persistence** | ✖ not applicable; sidecars drift | ✔ via IndexedDB working store; archive is written at export | ✔ native transactions, but the browser still needs durable storage behind it (OPFS), so it is a *replacement* for IndexedDB, not an addition |
| **Corruption recovery** | ✔ a truncated CSV loses only the tail, and line-based salvage is easy; ✖ sidecar and CSV can silently diverge | ◐ ZIP's central directory is at the end, so a truncated archive is hard to read (confirmed: the prototype rejects it, §7.7); **mitigated** because the archive is an export artifact and IndexedDB is the recovery source; per-entry CRC-32 plus manifest SHA-256 detect damage; a flipped byte in deflated data was rejected by the inflater [measured-browser] | ✔ journal/WAL recovery is mature, but a damaged image can be partly or wholly unreadable |
| **Security validation of untrusted files** | ◐ simple, but CSV/formula injection and giant files need handling | ◐ ZIP-specific risks are known and enumerable (§7); every payload is plain JSON validated by our own code | ✖ largest surface: an untrusted database file reaches the SQL engine; mitigations exist (`trusted_schema=OFF`, defensive mode, limits) but must be maintained |
| **Long-term maintenance** | ✔ minimal | ◐ we own a small reader/writer (~few hundred lines) and a spec; no third-party churn | ✖ vendored ~1 MB WASM plus glue, CSP `wasm-unsafe-eval`, service-worker cache bloat, upgrade and security-patch duty, no build system to manage it |
| **Human inspectability** | ✔ spreadsheet | ✔ any unzip tool, plain-text JSON/JSONL | ✖ needs a SQLite tool |
| **Fits no-build static hosting** | ✔ | ✔ | ◐ possible but awkward |

**Verdict.** Option 1 is only adequate as an interchange format. Option 3 solves problems WOBD does not yet have (ad hoc querying across many sessions) while adding the largest security and maintenance burden. Option 2 meets every stated requirement with the smallest footprint.

## 6. When to revisit SQLite

Reconsider only if one of these becomes an approved requirement: multi-session comparison or search over many stored sessions that outgrows simple per-session loading; query-heavy report generation; or a measured IndexedDB performance problem on real sessions. If so, add it as an **optional, lazily loaded analysis module** that imports from `.wobd`, not as the persistence layer.

## 7. Recommended design

### 7.1 Working store (IndexedDB)

Not a file format; versioned separately with `onupgradeneeded`.

| Store | Key | Contents |
| --- | --- | --- |
| `meta` | `"schema"` | IndexedDB schema version, app version. |
| `sessions` | `session_id` | Metadata, status (`open`/`closed`/`recovered`), estimated bytes, redaction flags. |
| `segments` | `[session_id, segment_seq]` | `segment_id`, start/end UTC, start/end reason, status (`open`/`closed`/`recovered`/`corrupt-tail`), `last_sample_seq`. |
| `chunks` | `[session_id, segment_seq, chunk_seq]` | `payload` (Uint8Array, exactly the JSONL bytes written into `.wobd`), `sample_seq0`, `count`, `t0_mono`, `t1_mono`, `utc0`, `bytes`, CRC-32. |
| `events` / `locations` / `annotations` | session + sequence | Same encoding as the archive entries. Annotations are a separate layer so source measurements are never edited. |
| `quarantine` | `[session_id, …]` | Chunks or records that failed validation on recovery; excluded from the timeline, exportable for support. |

- Flush a chunk every ~1–5 s (or N rows); compact to ~60 s chunks at stop or when idle. Each flush is one transaction that writes the chunk **and** updates the segment's `last_sample_seq`.
- Size accounting is exact: `est_bytes = Σ chunk.bytes`.

### 7.2 `.wobd` archive layout

A ZIP file (extension `.wobd`, media type `application/vnd.wobd.session+zip`, to be confirmed). **Entry order:** `mimetype` first and uncompressed, so the type can be sniffed without a full parse; `manifest.json` **last**, because it lists every other entry's size, CRC-32 and SHA-256 and so can only be written after them.

```
mimetype                       stored, "application/vnd.wobd.session+zip"
session.json                   vehicle as confirmed (VIN excluded by default), adapter, protocol/baud,
                               time anchor (utc_start, offset, source), selected PIDs, data-quality notes
dictionary.json                PID id → { pid, name, unit, style, digits, ecu_id, decoded }, ECU table
                               (raw source id + inferred-name confidence); preserves PIDs WOBD cannot decode
segments.json                  segment table: ids, seq, start/end, reasons, status
telemetry/seg-0001/chunk-000001.jsonl   [ {chunk header}, [dt_mono_ms, pid_id, value, quality?, latency_ms?] ... ]
events/events-000001.jsonl     connection events, gap evidence (§7.10), clock_adjustment/regression, storage events,
                               automatic events
annotations.json               user annotations (separate layer, see F4); may be absent
locations/loc-000001.jsonl     optional; omitted entirely when location export is declined
raw/raw-000001.jsonl           optional raw adapter replies; omitted by default
legacy/source.csv              original CSV bytes, verbatim; default for converted legacy files (§7.9)
legacy/residual.jsonl          CSV records that are not telemetry rows, with every raw field (§7.9)
legacy/columns.json            original header names/order, extra columns, delimiter, line ending, BOM (§7.9)
manifest.json                  LAST: format version, session_id, writer app/version, status complete|partial,
                               redactions applied, entry list with size, count, CRC-32, SHA-256
```

- **Every entry is bounded** (candidate: ≤ 4 MiB uncompressed). Telemetry, events, locations, raw replies, and the embedded legacy CSV are split into numbered parts rather than written as one huge file. This keeps one-shot `crypto.subtle.digest` usable and keeps import memory bounded (§7.7).

- Chunk header line: `{"v":1,"seg":1,"chunk":1,"seq0":<first sample_seq>,"mono0":<ms>,"utc0":<ms>,"n":<rows>}`. `sample_seq` for row *i* is `seq0 + i`, so contiguity is checkable without storing it per row.
- Missing or unsupported readings use an explicit `quality` code (or an event), never `0` and never an omitted row presented as zero.
- Row values may be numbers or status strings, matching today's `style: 'status'` PIDs.

### 7.3 Versioning

- `manifest.json` carries `"format": {"name":"wobd","major":1,"minor":0}`; every JSON file carries its own `"schema"` field.
- **Major** = breaking. A reader must refuse an unknown major with a clear message. **Minor** = additive. Readers ignore unknown fields and unknown entries, and may preserve them on re-export.
- Writers always write only the latest version.
- **Migrations are pure functions** `vN → vN+1` applied on import to an in-memory model. The source file is never rewritten in place.
- Freeze one fixture archive per released version and keep it in the tests forever.
- The format is documented in the repository (a spec file alongside this study) before the writer ships.

### 7.4 Migration path preserving existing CSV recordings

1. **No forced migration.** The current CSV importer and exporter remain, unchanged and tested against the real PT Cruiser file.
2. Add a **unified in-memory session model**. CSV import and `.wobd` import both produce it (see F4 for timestamp rules and legacy annotations).
3. **"Save as .wobd"** is an optional, explicit action on an imported CSV. It is **lossless by construction** (§7.9): the original bytes are embedded verbatim by default, and every record, unknown PID, extra column, original timestamp, and undecoded value is also preserved structurally.
4. **CSV export** from any session remains available. For a native session it is a *projection*; fields CSV cannot hold (events, locations, raw replies, quality states) are exported to separate files or omitted with a stated notice.
5. **Round-trip test:** see §7.9 for the exact byte-level and field-level criteria.
6. Independent of format work, a **streaming CSV parser** and a revised size cap fix the 3-hour fast-CAN limit for legacy files cheaply (§7.8 measured it: +81 MB versus +983 MB at 7 h / 30 rows/s). Treat it as a small P1 item, separate from the `.wobd` format.

### 7.5 Security validation on import

The importer treats every file as hostile.

- **ZIP structure:** require standard ZIP only. Reject zip64, encryption, split archives, and compression methods other than store/deflate. Cross-check each local header against the central directory. Reject duplicate names, trailing-data tricks, and overlapping entries.
- **Names:** allow only an explicit whitelist pattern of known paths. Reject `..`, absolute paths, backslashes, and anything else. Entries are never written to a filesystem path.
- **Limits:** enforce maximum entry count, per-entry and total **uncompressed** size. Track actual bytes while inflating and stop at the declared size; do not trust declared sizes. **Compression-ratio limit (revised from the first draft):** the prototype's 200× ratio limit wrongly rejected a legitimate, browser-written archive whose data was highly repetitive [measured-browser], and an idle car with constant readings can produce such data. Rely on the absolute caps (entry ≤ 4 MiB, total ≤ a stated session budget, entries ≤ 20,000) as the primary defense; treat a high ratio as a *warning* shown to the user, not a rejection, and reject only when the declared sizes themselves exceed the caps.
- **Integrity:** verify CRC-32 per entry and SHA-256 from the manifest. On mismatch, mark the data `damaged`, quarantine it, and let the user decide.
- **Content:** parse JSON with strict own validators (types, ranges, string lengths, finite numbers, known enums). Ignore `__proto__`/`constructor` keys. Render text with the existing DOM helpers, never `innerHTML`.
- **Privacy checks:** tests scan produced archives to prove that VIN, coordinates, and raw replies are absent when excluded.
- **CSV export:** neutralize cells beginning with `=`, `+`, `-`, `@` for **user-entered** text (annotations). Do not alter numeric readings.

### 7.6 Storage recovery is best-effort, and quota handling is independent of warnings

This clarification should be copied into F6 and applies to every format choice.

- **Recovery is best-effort, never guaranteed.** Browsers may evict data under storage pressure or when the user clears site data; a persistent-storage grant is not an absolute guarantee; a tab, browser, or OS crash can lose recent writes (IndexedDB durability is "relaxed" by default in Chromium, so the newest batches may not be on disk); private or restricted modes can make storage unavailable or tiny. The UI must say "WOBD will try to recover your recording", never promise it.
- **Warnings are advisory only.** `navigator.storage.estimate()` is approximate and can be coarse, and quota can be consumed by other tabs or disk pressure at any moment. Crossing, or not crossing, 70 % or 90 % must **not** gate error handling.
- **Every write path handles failure unconditionally**: `QuotaExceededError`, transaction `abort`, `UnknownError`, versionchange or blocked events, and a closed database. This behavior must work with warnings disabled and with an estimate that claims plenty of room.
- **Failure behavior** is defined independently: emit a `storage_write_failed` event, stop or visibly degrade persistence (optional data first, then core), keep a bounded in-memory tail, never discard already-stored chunks, and immediately offer **Export what was recorded**. Writes never retry in a tight loop.
- **Recovery outcomes** are reported by category: recovered fully, recovered with quarantined tail, partially recoverable (export raw), unrecoverable. Nothing is deleted without explicit consent.
- Tests simulate quota failure with the warning logic disabled, and again with the estimate reporting abundant space.

### 7.7 ZIP implementation and browser compatibility

`CompressionStream` / `DecompressionStream` provide only **raw deflate** (`deflate-raw`). They do not read or write ZIP structure (local headers, central directory, CRC-32, end record). The container is therefore ours.

**Decision: in-house ZIP reader and writer (~250 lines, no third-party dependency)** restricted to a strict subset.

| Need | API |
|---|---|
| Read a file slice without loading it all | `File.slice(a, b).arrayBuffer()` |
| Deflate / inflate an entry | `new CompressionStream('deflate-raw')`, `new DecompressionStream('deflate-raw')` |
| UTF-8 names and JSON/JSONL | `TextEncoder`, `TextDecoder` |
| SHA-256 (manifest) | `crypto.subtle.digest` (one-shot, hence the 4 MiB entry bound) |
| CRC-32 | in-house table implementation (verified against Python `zipfile` and Info-ZIP `unzip`) |
| Save | `Blob` + object URL download; `showSaveFilePicker` only as an optional enhancement (absent in Firefox) |

- **Writer rules:** no data descriptors (sizes and CRC in the local header); UTF-8 flag 0x0800; methods 0 and 8 only; no zip64, encryption, or multi-disk; whitelisted entry names; fixed DOS timestamp for reproducible bytes.
- **Reader rules:** locate the end-of-central-directory record in the last ≤ 65,557 bytes; cross-check each local header against the central directory; reject duplicate names, `..` or absolute paths, flag bits 0 and 3, and unsupported methods; cap inflated bytes by the declared size and abort via `reader.cancel()`; enforce total and entry-count caps; verify CRC-32 and the manifest SHA-256.
- **Feature detection:** `try { new CompressionStream('deflate-raw') }`, not `typeof`.

**Browser matrix**

| Capability | Minimum | Status |
|---|---|---|
| `deflate-raw` Compression/DecompressionStream | Chrome/Edge 103, Firefox 113, Safari 16.4 | [web-sourced, re-verify at implementation] |
| `Blob.stream` / `File.slice` | Chrome ~77 | web-sourced |
| Web Serial (recording) | Chrome/Edge 89, Opera 75 | web-sourced |
| Chromium 154 and Firefox 158 (headless, Linux) | read a Node-built archive (63/63 entries pass CRC and size, 24,444 rows), reject truncated/corrupt deflate, stop a 40 MiB zero bomb in 23–32 ms, write an archive that passes Python `zipfile.testzip()` and `unzip -tq` | [measured-browser] |
| Safari | not tested | **unverified** |

- **Known gap:** Chrome/Edge 89–102 can record via Web Serial but lack `deflate-raw` streams. Proposed behavior: write **stored (method 0)** entries there, which any reader accepts; refuse to read deflated entries with a clear "update your browser" message; CSV import/export keeps working. Bundling a vendored inflate library (e.g. fflate) is an optional later fallback; its size has not been verified here.
- Supported browsers per the README are Chrome, Edge, Opera; review and import in other browsers is best-effort.

### 7.8 Streaming import/export and chart downsampling

**CSV import (replaces `parseRecording`'s whole-file `text()` + `split`):**

`File.stream()` (or `slice`) → `TextDecoder` with `{stream: true}` → incremental, quote-aware CSV state machine that handles `""` and `\r\n` across chunk boundaries → columnar typed arrays with doubling growth (Float64 time, Uint8 PID id, Float64 value ≈ 17 B/row). Prototyped and working [measured-synthetic].

**`.wobd` import:** read the central directory via `File.slice`; validate; then decode **one entry at a time** into the same columns. The decoded archive is never held whole.

**Budget and limits:** 756,000 rows (7 h at 30 rows/s) ≈ 13 MB in columns; measured streaming-import peaks are in §4.1 (+81 MB at 7 h scenario B, versus +983 MB for the current parser). Above a stated row cap (decision pending), fall back to windowed access backed by IndexedDB rather than refusing. The 20 MiB file cap becomes a streaming-aware cap (decision pending).

**Replay chart downsampling (render-time only):**

- Per visible window, per series: min/max (optionally first/last) per pixel bucket, found by binary search on time. Cost measured at 34 ms for 13 PIDs over 756,000 rows.
- **Raw samples are never modified, dropped, or replaced.** Downsampling produces a view; exports, reports and statistics read raw data.
- Empty buckets and recording gaps render as breaks, never as connected lines.
- Categorical/status PIDs use run-length segments, not min/max.
- When samples per pixel < ~1 (zoomed in), draw raw points; tooltips resolve to the nearest raw sample.
- No precomputed pyramid in v1.

### 7.9 Lossless CSV migration

**What `parseRecording` silently drops or alters today:** rows with unknown PIDs (only names are reported); rows with non-finite elapsed time, empty values, or non-numeric values on numeric PIDs; all extra columns; raw value text (`Number()` turns `0.50` into `0.5` and `1e3` into `1000`); original timestamp text (only the first valid one feeds `startedAt`); `protocol`/`baud` after the first row; and original row order (series are sorted by time). Replay shows only the unknown PID names.

**Migration rules (the replay parser itself is not changed to drop less; migration uses a separate lossless reader):**

1. Embed the original bytes verbatim as `legacy/source.csv` (split into ≤ 4 MiB parts if large). Default **on**.
2. Independently preserve every CSV record structurally: telemetry samples carry `source_row` and, when it differs from the parsed form, the raw value text; any record that is not a clean telemetry sample becomes a `legacy/residual.jsonl` entry with every raw field.
3. Extra columns, header order, delimiter, quoting, BOM, and line endings are recorded in `legacy/columns.json`.
4. Unknown PIDs get dictionary entries (`decoded: false`) with raw value text; they are never dropped.
5. Original timestamp text is kept per row where non-canonical; the unified-timeline mapping of F4 is derived, never overwriting it.
6. A **migration report** is shown with counts by reason (preserved as telemetry, preserved as residual, normalized, malformed, duplicate, out-of-order).
7. Omitting `legacy/source.csv` requires explicit confirmation, and structural preservation must then be complete.

**Tests:** converting with the embedded source and exporting back yields byte-identical CSV; with the source omitted, re-parsing gives field-identical records under the same lossless reader. Fixtures: unknown PIDs, extra columns, empty/non-numeric values, malformed, duplicate, and out-of-order rows, status strings, `0.50` and `1e3` text, non-canonical timestamps, BOM and CRLF.

### 7.10 Recording gaps

Gaps are stored as explicit events, in distinct states, never as inferred measurements:

| State | Evidence | Class |
|---|---|---|
| `user_stop`, `user_pause` | user action | recorded |
| `adapter_disconnect`, `adapter_reconnect` | serial events | recorded |
| `communication_interruption` | adapter alive, no valid PID reply for ≥ `LOST_AFTER_MS` (10 s, already in `DriveLock`) | recorded |
| `bus_error`, `no_data` | adapter response | recorded |
| `crash_inferred` | segment open with no end record | inferred |
| `device_sleep_suspected` | wall-clock jump vs monotonic mismatch | inferred |
| `unknown_gap` | missing time, no evidence | unknown |
| `annotated_ignition_off` | user annotation | user-annotated |

- Where evidence permits, the most specific state is used; otherwise `unknown_gap`. States are never merged to look tidier.
- User annotations are a separate layer and never rewrite stored events.
- **A gap, or missing RPM readings, must never be classified as an engine stall.** Key-off and stall look identical from the data alone, and a zero-RPM reading is a measurement, not a gap. Any "suspected stall" belongs to F5 and requires fresh, valid RPM readings falling to 0 with ignition context.

### 7.11 Performance and integrity test plan

**Fixtures** (seeded, deterministic): 1 h, 3 h, 7 h in three scenarios.

| Scenario | Rate | Label |
|---|---|---|
| A | 6.79 rows/s (the one real recording) | measured rate, synthetic length |
| B | 30 rows/s | **assumed** CAN |
| C | B plus latency, quality, raw replies, GPS at 0.67 Hz | **assumed** |

**Metrics per fixture:** peak memory; import duration; export duration; compression ratio; integrity (CRC-32, SHA-256, round-trip hash); recovery from interrupted writes (`fake-indexeddb` for logic, real Chrome for durability); hostile ZIP fixtures (bomb, traversal, duplicate names, mismatched headers, bad CRC, truncated, oversized entry count).

**Candidate budgets** (calibrated from the prototype, to be confirmed): 7 h scenario B streaming import below 150 MB above baseline (measured 81 MB); `.wobd` ≤ 3.5 MB for 7 h scenario B (measured 2.44 MB).

**Measured vs assumed:** only the 6.79 rows/s rate, the compression ratios of the real file, and the Node/Chromium/Firefox prototype results are measured. Every CAN rate, enriched-data size, Safari behavior, and ChromeOS memory figure is assumed until measured on a real device.

### 7.12 Repository tracking

- `.gitignore` ignores `Docs/*` with explicit negations per tracked document. `!Docs/Recording-Format-Study.md` was added, so this study tracks normally.
- `Docs/WebAppDesignDoc-WOBD.md` and `.wrangler/` stay ignored on purpose; verified with `git check-ignore`.
- `.assetsignore` already excludes `Docs`, so documents are not published with the site.
- The real fixture source CSV is tracked under `reports/`. Generated fixtures are produced by seeded script, not committed.
- Nothing is committed yet.

## 8. Recommended plan changes (for review)

1. **F6:** adopt IndexedDB working store, `.wobd` ZIP with in-house reader/writer (§7.7), CSV retained, §7.6 best-effort and quota independence, and §7.10 gap states with the no-stall rule.
2. **F4:** unified session model; lossless CSV migration (§7.9); streaming import and render-time downsampling (§7.8).
3. **F5:** guardrail that a recording gap or missing RPM is never a stall.
4. **F8:** reports read the unified model, so they work for `.wobd` and legacy CSV.
5. **Delivery table:** (a) streaming CSV parser and revised cap, (b) IndexedDB persistence and recovery, (c) `.wobd` writer/reader plus spec and fixtures.
6. **Tests:** §7.11 fixtures and budgets, hostile-ZIP fixtures, lossless round-trip tests.

## 9. Open decisions

- Media type, extension, File Handling API.
- Whether per-row `latency_ms` and `quality` are stored by default (largest enriched-size lever).
- Compaction chunk duration (~60 s candidate) and absolute import caps (entries 20,000, entry 4 MiB, total, row cap).
- Chrome/Edge 89–102: stored-entry fallback plus refusal message, versus bundling an inflate library.
- Whether the ratio check is a warning only (proposed) or removed.
- Resolved: embed `legacy/source.csv` by default.

## 10. Method and limits

- Measured on the one real recording; longer sessions are synthetic tiling with noise, labeled as such.
- Memory is Node `maxRSS` minus a 40 MB baseline; browser heaps differ.
- Browser behavior was tested on headless Chromium 154 and Firefox 158 on Linux only. Safari and ChromeOS were not tested.
- Minimum-version figures came from web sources and must be re-verified.
- No application code was modified.

## 11. Blockers

None block approval of the specification. Before implementation or release:

1. Safari and real ChromeOS verification are outstanding.
2. No measured CAN rate or long varied drive exists; scenario B and C are assumptions.
3. Real-browser IndexedDB durability under crash is untested.
4. The Chrome/Edge 89–102 policy needs a decision.
