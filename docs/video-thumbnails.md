# Video seek and thumbnail previews

Video arrows seek ±10 seconds. `src/player/seekController.js` anchors a burst to
its first keypress and updates the feedback immediately. After 180 ms without a
new press it sends one absolute seek. Pending positions saturate at 0/duration;
reversing at either edge responds immediately. Commit, explicit slider seek,
source change, error, transition and unmount reset the burst. Inputs, sliders,
editable content, menus and modified shortcuts retain their own keyboard behavior.
File navigation buttons remain available; arrows still navigate non-video viewers.

## Frontend boundary

The call chain is:

```
CustomMediaPlayer / VideoProgressRange
  → useThumbnailPreview
  → video.getThumbnail({ path, time, width, providerId?, sourceHdr?, signal? })
  → thumbnailService (bounded cache and latest-request queue)
  → backend.request('video:thumbnail', { path, time, width })
  → tauriTransport
  → video_thumbnail
  → ThumbnailManager
  → application-owned FFmpeg CLI
```

Vue components never invoke a native thumbnail command directly. The web player
uses media-chrome's `mediapreviewrequest` timestamps, including its drag behavior.
The native overlay uses the existing range styling through `VideoProgressRange`;
it shows the drag position immediately and commits playback seek on `change`.
Overlay context includes the provider and source path, independent of the
`vesperwind-media` streaming URL used for playback.

`useThumbnailPreview` samples the latest pointer position every 100 ms. Each new
position invalidates the previous response; leaving, cancellation, source change
and unmount abort its signal and hide the preview. Abort signals are local to the
service; an already running FFmpeg finishes under the Rust timeout and its stale
result is ignored. The service runs one request at a time, retaining only the
latest pending request. Its LRU holds at most 32 frames and 4 MiB of data URL
characters, using half-second buckets and separate keys for source and size.
The cache lives in a WebView and is cleared on source changes. Rust additionally
limits extraction to one running operation across all WebViews: contended calls
return `unavailable/busy` immediately, rather than queueing process launches.

The renderer consumes only `{ status: 'ready', url, time }` or
`{ status: 'unavailable', reason }` under the response's `thumbnail` field.
`url` currently contains a JPEG data URL. A future thumbnail index/sprite provider
can select a frame in the service, resolve it to the same frame URL contract and
keep the Vue controls unchanged. Transport/backend failures follow the existing
`{ ok: false, error }` API convention and leave a time-only preview.

Remote providers return a time-only preview without requesting extraction. Browser
runtime also returns a time-only fallback: there is no server/system-FFmpeg route.
Local HDR sources reach the extractor through the same API as SDR. Rust probes
only the first video stream with the bundled FFmpeg and caches its metadata against
canonical path, file size and mtime (8 sources). HDR10/PQ with BT.2020 and HLG with
BT.2020 produce SDR BT.709 JPEG previews. FFmpeg 8.0's built-in libswscale color
management uses `scale` with `out_transfer=bt709`, `out_primaries=bt709`,
`out_color_matrix=bt709` and `intent=perceptual`: transfer conversion, perceptual
tone mapping and gamut mapping happen together with resizing. This needs neither
zimg nor libplacebo, and avoids applying a second tone mapper after that conversion.
The decoded output's BT.709 tags are verified via the final `showinfo`; HDR side
data is removed before encoding. Conversion failure leaves a time-only fallback.

Dolby Vision with a PQ/HLG BT.2020 compatible base layer may use this conversion;
RPU or enhancement-layer reconstruction is not claimed. Profile 5, unsupported
transfer functions and HDR metadata without sufficient color tags keep the
`unsupported-hdr` fallback. If HDR is discovered only while decoding an untagged
header, that request also falls back. Untagged ordinary video follows the existing
SDR assumption. Preview conversion does not change the main player's HDR output.

## Extractor

`src-tauri/src/media/thumbnail.rs` resolves existing local files through the shared
filesystem resolver, including Finder aliases and configured-root restrictions.
FFmpeg receives separate `Command` arguments, never a shell command string.
Input protocols are restricted to `file,pipe`, standard input is disconnected,
only the first video stream is decoded, and audio/subtitles are skipped.

Input-side `-ss` performs an accurate seek to the requested timestamp. The last
bucket is clamped just before EOF. One frame is scaled proportionally to the
requested width (64–480 px), bounded to 270 px height, with even dimensions and
square pixels, encoded as JPEG, and returned via `image2pipe` stdout. There are
no thumbnail temporary files. CPU decode/filter/encode threads are bounded;
each subprocess has a 12-second deadline, 512 KiB image and 128 KiB stderr limits.
Pipes are drained concurrently to avoid deadlocks; oversized/timed-out children
are killed, waited for, and readers joined. Windows subprocesses hide their console.

## Pinned sidecar build and distribution

No runtime environment variable, system installation or `$PATH` lookup can select
FFmpeg. The supported version is exactly FFmpeg **8.0** (optional build suffix).
The CLI is version-checked once per manager before extraction.

A native macOS/Linux recipe is included:

```sh
bash scripts/build-thumbnail-ffmpeg.sh
```

It downloads FFmpeg's `n8.0` source archive, verifies the same SHA256 already pinned
by the project's libmpv build, disables GPL/nonfree/autodetected external libraries
and networking, and statically links libav dependencies. Generated binaries are
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

Behavioral tests cover accumulated/mixed seeks, edge saturation, lifecycle reset,
failed seeks, key exclusions, remote suppression, HDR request routing, cache
eviction, cancellation, and a flood of requests with only one active and one
pending generation.

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml media::thumbnail --lib
# After building the pinned sidecar: real stdout JPEG, EOF, HDR10/HLG-to-BT.709 pixels and concurrency.
cargo test --manifest-path src-tauri/Cargo.toml media::thumbnail --lib -- --include-ignored
```

The real-frame test synthesizes its own inputs with the pinned CLI, including a
filename with spaces/shell metacharacters and 10-bit PQ/HLG BT.2020 inputs encoded
from a known SDR test pattern. It checks the manager's conversion policy, BT.709
output tags and actual raw RGB pixel changes after tone mapping. It runs only
when explicitly requested with the staged sidecar. Cross-platform packaged runtime,
signing/notarization, and physical playback validation are separate acceptance
checks; local tests do not establish those outcomes.

FFmpeg options follow the [FFmpeg CLI documentation](https://www.ffmpeg.org/ffmpeg.html)
and [filter documentation](https://www.ffmpeg.org/ffmpeg-filters.html). Binary naming
and packaging follow [Tauri's sidecar contract](https://v2.tauri.app/develop/sidecar/).

The HDR10 movie on the external drive still requires an acceptance check after
unlocking the machine: inspect previews at dark, bright and saturated scenes,
compare timestamps with playback, exercise rapid hover/drag, and confirm HDR
playback output remains unchanged. Synthetic CLI fixtures do not establish visual
fidelity on that movie.
