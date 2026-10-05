# Native Office conversion

Tauri converts **PPTX → PDF**, **DOC → DOCX** and **RTF → DOCX** with a
bundled, source-built LOWA (LibreOffice WASM). It does not discover or execute
installed LibreOffice, Python, Chromium, Playwright, a CDN or a cloud converter.
DOCX/PDF do not need conversion. XLS/XLSX retain the existing spreadsheet path.

## Architecture and lifecycle

Provider-neutral binary reads supply local or SFTP bytes to the serialized
Rust `ConversionBroker`. On the first request it verifies the pinned assets,
creates an ephemeral **127.0.0.1** HTTP origin and one hidden, incognito Tauri
WebView. ZetaJS starts LOWA in that WebView's worker. The direct headless
`XLoadable` model loader uses explicit filters; macros and document updates are
disabled, and interaction requests abort. The interactive WebView never loads
LOWA. macOS background throttling is disabled for the converter.

The converter and its HTTP origin are absent at startup. Successful requests
reuse one warm generation serially. `office::IDLE_TIMEOUT` is the single
production idle constant: **90 seconds** after the last completed request the
WebView is destroyed. No replacement is created until destruction is confirmed.
A teardown failure is reported and prevents a second LOWA instance.

Conversion is bounded by a native watchdog (**90 seconds**, including queue
wait). Closing a preview/tab aborts its request; the active converter is
natively destroyed. Queued cancellation does not destroy another request's
converter. Native generation and request IDs bind input/output routes. Stale,
duplicate and closed-generation results are rejected. Frontend generation
checks prevent late reads/conversions from changing a closed or newer view.
Inputs are limited to 64 MiB by the broker and **32 MiB** by the current provider
binary API. No conversion cache is maintained.

The origin has an opaque per-instance token, a closed route table, host/origin
checks and bounded HTTP input. Responses set COOP `same-origin`, COEP
`require-corp`, CORP `same-origin`, `no-store`, `nosniff` and CSP with
`connect-src 'self'`. External connections, frames, forms and new windows are
blocked. Every Tauri IPC invocation from converter windows is denied.
WASM evaluation allowances apply only to this private converter document.

## Product behavior

Normal PPTX open and Quick Look share this backend and reuse `PdfViewer` with
in-memory PDF bytes. Thumbnails, navigation, keyboard controls, zoom/fit,
selection and search are inherited from PDF.js. Presentations are read-only;
there is no presentation editor or user-visible temporary output. Fullscreen
follows the existing viewer's capabilities. Export PDF is not added.

DOC/RTF open uses the existing Word reader/editor after conversion. The original
source is unchanged; the imported editor tab is dirty and first Save requires
**Save As DOCX**. Quick Look uses the existing read-only Word surface and has no
Save action or editor registration. Layout and unsupported Office features can
change during conversion. Cached chart values and font availability matter;
these conversions are not a lossless Microsoft Office round-trip guarantee.

Browser/SEA still intentionally uses the Node backend's optional installed
LibreOffice converter for DOC/RTF. Its discovery (including
`VESPERWIND_LIBREOFFICE`) remains in `server/documentConversion.js`.
Browser/SEA PPTX conversion is unsupported. Native Tauri never falls back to
that backend or installed `soffice`.

## Pinned payload and provenance

`src-tauri/vendor/lowa/ASSETS.json` lists exact byte sizes and SHA-256 for every
runtime file. Its SHA-256 is the converter build identity returned with outputs:
`3535f71caafa356c07ea849a1c71941cf32d36d943bfcf52746c7ba8f010a50d`.
The current runtime files total **66,097,255 bytes (63.04 MiB)**, excluding the
manifest itself. The four accepted Brotli engine files total
**47,921,150 bytes (45.70 MiB)**:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| soffice.js.br | 126773 | 69b23250a4c01738decf3c0494cada8ab6125c8074a21d1250080f20c5626595 |
| soffice.wasm.br | 33214184 | e291393a84b7c4065a6472b5bd6bce621200aa08c61a32df1832fbe320697e32 |
| soffice.data.br | 14577174 | da9139da30381ff3d5263154d0467b670869fea34422744a070de698e42b4113 |
| soffice.data.js.metadata.br | 3019 | f3928b051ac6233a50b9963c056bedf32c0de1bc9e2fb31ed22f6a0fe2216929 |

The engine is the accepted **128 MiB initial → 512 MiB maximum growable heap**
profile, with conversion-only services, trimmed VFS and no full CDN UI package.
This heap limit is not a total process-memory limit. The VFS retains 119 fonts;
their names, copyright strings and hashes are in `FONT-INVENTORY.json`.
The additional 16,467,736-byte Noto Sans CJK JP Regular font is the full research
source font, replacing the corpus-specific subset for general document coverage.
Its exact hash is in ASSETS.json; its OFL text and embedded copyright remain
bundled. Its upstream is `notofonts/noto-cjk`.

Core revision: `efaf0670b4d055f838a2849becb10f08aa06a257`.
Emscripten 3.1.65 revision: `949ee1d40467b80e90a9fdc67155d443426fef2d`.
ZetaJS revision: `b3dec98af5dc4c059a260afd6db0bf0fe38c6384`.
`BUILD-INFO.json` preserves the accepted engine recipe and receipt;
`FS-INVENTORY.json` records its VFS. LibreOffice retains MPL-2.0 and its upstream
license notices, ZetaJS uses MIT, and fonts/selected dependencies retain their
actual individual licenses. Vesperwind's MIT license does not relicense LOWA.
Full texts are under `licenses/`; source pins, the exact production patch,
modified source forms, download list/hashes and rebuild scripts are under
`vendor/lowa-build/`. See `THIRD_PARTY_NOTICES.md`.

Normal builds only verify pinned artifacts with `scripts/check-lowa-assets.mjs`.
They never run the LibreOffice source build. Tauri resources include the payload
in macOS and Windows bundles. To rebuild/update, follow
[`vendor/lowa-build/README.md`](../vendor/lowa-build/README.md), review notices,
run both native acceptance corpora, then regenerate the manifest explicitly with
`node scripts/update-lowa-manifest.mjs`. A bit-identical rebuild has not been
established. Do not substitute a mutable CDN payload.

## Integrated acceptance and resource measurements

The macOS arm64 bundled debug `.app` completed the production native regression
with exit code **0**, ten PDF/DOCX outputs, PDF.js operator/text/geometry readback
and existing Word reader readback. The native runner also probes a separate
owned network origin from inside the converter WebView to verify CSP rejection.
It verified lazy startup, warm reuse, actual
90-second idle destruction, reconstruction, native hard cancellation and recovery.
The compact receipt is [`office-native-acceptance.json`](office-native-acceptance.json).

| Observation | Integrated macOS value |
| --- | ---: |
| Cold conversion including initialization | 9.464 s |
| Engine initialization | 8.541 s |
| Warm conversion median | 288 ms |
| Before LOWA, median summed RSS | 348.70 MiB |
| Warm, median summed RSS | 1373.64 MiB |
| After idle teardown, median summed RSS | 279.17 MiB |
| Peak summed RSS | 1632.999 MiB |
| Idle teardown from last conversion | 90.070 s |

RSS is sampled at 250 ms for the app plus newly appearing WebKit processes.
WebKit XPC processes are owned by launchd, so temporal attribution can include
other apps, and summed RSS can double-count shared pages. These are observations,
not a memory budget or an isolated engine heap measurement.

The supplied same-engine Windows research corpus completed five instances, four
destroy/reconstruct cycles and **80 accepted outputs (60 PDF, 20 DOCX)**. Its
`code: null` was a runner bookkeeping defect, not a LOWA failure; the concise
receipt is `vendor/lowa-build/windows-accepted-corpus.json`. New production
Windows CI builds/tests the real app and uses a corrected
`System.Diagnostics.Process` runner that captures a real exit code and requires
both the `finished` event and reader acceptance. Interactive Windows acceptance
remains a separate manual check by the user.

Run `cargo build --manifest-path src-tauri/Cargo.toml`, then
`node scripts/native-smoke.mjs /absolute/new/output-directory` on macOS, or
`./scripts/run-native-smoke.ps1 -Output C:/absolute/new/output-directory` on
Windows. `VESPERWIND_NATIVE_BINARY` selects a bundled macOS app executable.
The opt-in native regression is debug-only and uses the production managers.
Production fixtures under `test/fixtures/office` are small owned CC0 documents;
no real protected system location is touched.

The full interactive macOS checklist (Quick Look slide navigation, Word Save As
and displayed deletion error/Close) is still pending: the CUA kernel rejected
this session's symlinked writable root, System Events lacked Accessibility
permission, and screen capture yielded no usable image. Native engine/helper
acceptance and frontend regressions do not replace that visual acceptance.

## Research cleanup

`docs/office-research-cleanup.json` records the named disposable paths removed
after moving production assets, notices, exact source forms/recipes, fixtures and
regressions. The Office research tree and its three obsolete reports are removed.
The mounted source/build scratch was emptied and detached, and its 13.57 GB
backing image removed. Alternate payloads, CDN downloads, candidate harnesses,
transfer data and generated comparisons are removed from `/private/tmp`.
The external directory `/Volumes/WD 1TB/vesperwind-lowa-build` still contains
source/SDK download archives and an unmodified Emscripten source checkout:
automatic approval review rejected deleting that entire directory. These paths
are recorded as `externalRemaining` in the cleanup receipt and remain pending
explicit authorization. The repository and runtime do not depend on them.
The root `.gitignore` had no research-only rules, so it is unchanged. The eight
nested Office research rules disappeared with its `.gitignore`; legitimate
project ignores remain. No `git clean` or reset was used.
