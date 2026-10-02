# On-demand video thumbnails

## Hover behavior

Every pointer movement immediately updates timestamp and hides the displayed
image. It restarts a **250 ms dwell timer**, including movements within the same
half-second cache bucket. Extraction and cache lookup run only after that timer
expires. Pointer leave/cancel, source change, modal close and component unmount
invalidate the revision, clear dwell and abort the active request.

Pending or unsupported requests display timestamp only: no rectangle, placeholder,
spinner or image icon. A detached `Image` loads and decodes the complete JPEG
before its URL enters Vue state. Only then is the image inserted and faded in over
180 ms; reduced-motion disables the transition. Removal is immediate, without a
leave animation. Cached images follow the same dwell and decode-before-show UX.
Remote/SFTP and runtimes without the native backend stay time-only.

## One short-lived extraction

The native open hook registers lifecycle ownership. Hover extraction resolves
the source and generates one JPEG after dwell.

After dwell, a cache miss uses bundled pinned FFmpeg with **input-side `-ss`**,
`-map 0:v:0`, `-frames:v 1`, scaling and MJPEG on stdout. Audio, subtitles and data
are skipped. Decode/filter/encode thread counts remain one. Maximum output is
512 KiB JPEG, bounded stderr is 128 KiB, and a run has a 12-second deadline.
The process is killed/reaped on cancellation or limit, and both pipe readers join.
These output caps are not a total decoder-memory cap. The decoder lives only for
one request, rather than the duration of the film.

Version validation runs once on the first cache miss. A bounded header-only probe
resolves duration and the first video stream's HDR policy once per source size/mtime
identity, on demand. Incomplete
startup playback tags cannot bypass this original HDR validation. Version
validation/probe/extraction are serialized; at most one FFmpeg child exists.
No process starts merely on open or while the dwell timer is being reset.

## Cancellation and cache

The frontend retains one active extraction and one replaceable latest pending
position. Superseded/aborted pending work is dropped, not accumulated. Revision and
AbortSignal checks reject results before and after JPEG decoding.

The existing `video:thumbnail` command accepts an opaque request ID and a cancel
flag. Cancel marks the matching request's native atomic flag; the child runner
polls it every 10 ms and performs kill/wait/join. A bounded 32-ID cancellation
record handles cancel-before-start IPC races without canceling a newer ID.
Rust `try_lock` prevents another WebView from queuing extraction behind the active
worker; busy falls back to time only. Source close/shutdown also cancel and wait.

The JavaScript LRU is at most 32 entries and 4 MiB of image-URL string
storage (UTF-16 accounted). Buckets are `floor(time * 2) / 2`; width and source path
are part of the key. Hits refresh recency, oldest entries are evicted, oversized
responses are not cached, and source reset/unmount clears the cache. JPEGs travel
as `data:image/jpeg;base64,...` response. No disk thumbnails or
SQLite thumbnail rows are written.

## HDR and source security

Extraction uses local filesystem/root checks, argument-array process
launch (no shell), pinned app-owned FFmpeg only (no PATH), `file,pipe` protocol
whitelist and disconnected stdin. Windows uses no-console/below-normal priority;
Unix requests nice 10. CPU priority is not a disk-I/O isolation guarantee.

HDR10/PQ and HLG with BT.2020, including a compatible Dolby Vision base layer, use
FFmpeg 8.0 libswscale perceptual transfer/tone/gamut conversion to BT.709. Resize,
`out_transfer=bt709`, `out_primaries=bt709`, `out_color_matrix=bt709`, and removal of
HDR side data remain intact. Input/output showinfo checks reject unexpected HDR
or a non-BT.709 conversion. DV profile 5 and insufficient supported HDR metadata
stay time-only. No RPU/enhancement-layer reconstruction is claimed. Main playback
HDR and renderer configuration are unchanged.

## Pinned sidecar build and distribution

No runtime environment variable, system installation or `$PATH` lookup can select
FFmpeg. The supported version is exactly FFmpeg **8.0** (optional build suffix).
The CLI is version-checked once per manager, on the first actual hover extraction.

A native macOS/Linux recipe is included:

```sh
bash scripts/build-thumbnail-ffmpeg.sh
```

It downloads FFmpeg's `n8.0` source archive, verifies the same SHA256 already pinned
by the project's libmpv build, disables GPL/nonfree/autodetected external libraries
and networking, and statically links libav dependencies. On macOS it explicitly
enables public VideoToolbox support, but on-demand extraction uses the original
single-thread software decoder settings. Generated binaries are
ignored by Git. Development loads only
`src-tauri/binaries/ffmpeg-<target-triple>[.exe]` or an app-adjacent sidecar. Release
loads only the app-adjacent `ffmpeg[.exe]`; no source-tree fallback exists in release.

The recipe produces the LGPL license and source/build information alongside the
binary. Distribution remains an explicit build choice so source checkouts without
staged binaries still build and show the lightweight fallback:

```sh
npm run build:tauri -- --config src-tauri/tauri.ffmpeg.conf.json
```

The overlay config adds Tauri `externalBin: ["binaries/ffmpeg"]` and includes the
license/build information while preserving libmpv resources. Stage a binary for
each requested target triple before bundling. Tauri renames the target-specific
sidecar to `ffmpeg` in the installed bundle.

For Windows, stage a separately reproducible FFmpeg 8.0 CLI with its licenses and
build/source information; the native Unix recipe does not cross-compile Windows.
A static build avoids non-OS runtime DLLs. If a future shared build is selected,
package its complete libav/transitive library closure, configure loader paths
relative to the executable, and include checksums/licenses/source offers. On macOS
use executable-relative rpaths and sign/notarize the sidecar and dylibs with the app;
on Windows place required DLLs next to the executable. Never rely on library search
paths from the user's environment or silently borrow the system FFmpeg.

## Validation

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml media::thumbnail --lib -- --include-ignored --nocapture
```

Frontend tests exercise movement floods, exact dwell/reset, extraction and image-
decode stale races, source reset/unmount, actual rendered timestamp-only markup,
ready-image markup/fade, image loader cancellation and LRU/concurrency behavior.
Rust tests preserve input-side seek/one-frame arguments, HDR validation, local-only
policy, bounded output, cancellation races and single-worker refusal. Explicit
integration tests decode real SDR/PQ/HLG fixtures and cancel a real FFmpeg child.
Automated checks cover extraction and UI state; hover latency and visual behavior
need verification in the actual Tauri application.
