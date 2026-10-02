# macOS application acceptance — 2026-10-02

Base: `main` at `48b455bf47b4af8a88fd228d38e0df668cad55f0`, with the
uncommitted stabilization changes described below. Tests use Vesperwind's actual
Tauri `.app`, its provider stream, native video view and controls WKWebView.
Standalone probe results are not included as application evidence here.

**Status: experimental; fullscreen composition acceptance is incomplete.**
The paused fullscreen solid-color frame and intermittent white top/right strips
were reproduced. Completing round trips, reporting correct geometry or passing
unit tests does not establish that these defects are resolved.

## Host and assets

- Apple M4, arm64, macOS 27.0.1 (26A434).
- One MSI MD271UL: physical 5120×2880, logical 2560×1440, 60 Hz, backing scale 2.
- Actual current/potential EDR headroom: 1.0 / 1.0.
- Generated non-DRM local assets in `/private/tmp/vesperwind-acceptance/`:
  `h264-aac.mp4` (two AAC tracks), `hevc-eac3.mp4`, `pq-vui-ac3.mp4`
  (HEVC Main10, BT.2020/PQ, AC-3), `hlg-vui-aac.mp4`
  (HEVC Main10, BT.2020/HLG, AAC).
- `hevc-pq-ac3.mp4` has container PQ tags but its actual decoded transfer was
  BT.1886. It is **not** PQ acceptance evidence. The x265 VUI-tagged assets above
  were generated subsequently and the application's decoded transfer checked.
- These are test patterns and tones, not reference color or spoken lip-sync assets.

## Confirmed in the application

Strict `VESPERWIND_MPV_MACOS_BACKEND=macvk` showed H.264 and HEVC video in the
modal. The main WKWebView remains beneath video; the transparent controls WKWebView
is above it. Play/pause, seek, Previous/Next source, Info, audio-track menu, mute
and volume controls were clickable. Windowed video stayed within the panel and
the top rounded corners were visible. No separate native player window is used.

Retina geometry was observed at 1098×651 logical / 2196×1302 drawable pixels
and, after window resize, 1098×1033.5 / 2196×2067. Paused HEVC remained visible
after resize. Fullscreen model geometry and VO target reached 2560×1440 logical /
5120×2880 drawable, radius 0; **this did not prevent the composition defects**.

Local source switching replaced the frame and terminated the old mpv/VO. After
closing paused playback, the native surface disappeared from the accessibility
tree; logs show Vulkan teardown followed by view removal and layer release.
Reopening HEVC and PQ in the same application worked. Fullscreen close was tested
as Exit fullscreen → Close (the fullscreen close icon exits fullscreen).

Closing during injected VO startup cancelled opening before its ten-second
timeout, removed the host and did not start fallback afterward. Reopening the
player after cancellation worked. Close during seek/source-switch/native Space
animation remains a separate stress acceptance item.

## Backend evidence

| Path | current-vo | current-gpu-context | hwdec-current | current-ao | Audio decoder |
| --- | --- | --- | --- | --- | --- |
| Strict MacVk H.264 | gpu-next | macvk-embedded | videotoolbox | coreaudio | aac |
| Strict MacVk HEVC | gpu-next | macvk-embedded | videotoolbox | coreaudio | eac3 |
| MacVk PQ / HLG Main10 | gpu-next | macvk-embedded | videotoolbox | coreaudio | ac3 / aac |
| Strict OpenGL H.264 / HEVC | libmpv | null | videotoolbox-copy | coreaudio | aac / eac3 |
| Auto after injected VO failure | libmpv | null | videotoolbox-copy | coreaudio | aac |

MacVk SDR output: `video-target-params` pixel format `rgb10a2`, BT.709,
gamma2.2, RGB/full range; CAMetalLayer RGB10A2Unorm (90),
`kCGColorSpaceSRGB`, `wantsExtendedDynamicRangeContent=false`, EDR metadata absent.
`systemDolbyVisionOutput=false`.

Representative playing diagnostics (seconds; counters are per session):

| Session / observation | avsync | Dropped | Decoder dropped | Delayed |
| --- | ---: | ---: | ---: | ---: |
| H.264 after 20 fullscreen round trips | 0.000012291 | 0 | 0 | 0 |
| HEVC after paused close/reopen | 0.000005791 | 0 | 0 | 0 |
| PQ playing | 0.000007 | 2 | 0 | 0 |
| HLG playing | 0.000008958 | 8 | 0 | 0 |

OpenGL observations included dropped frames (H.264 up to 25, HEVC 23), with
decoder-dropped and delayed counters 0. The auto-fallback session initially had
0 drops / avsync 0.0000104, but a later long occluded run reached 887 dropped
frames. These are measured samples, not a zero-drop guarantee or performance
acceptance. AAC track switching, mute/unmute, volume (0.49), pause/resume, seek
and source switching were exercised; E-AC-3 and AC-3 reached CoreAudio in the app.
Audible quality and subjective lip sync have not been verified.

## Fullscreen investigation

Ten paused and ten playing enter/exit round trips completed in one debug
application session (`macvk-cover-app.log`), with pause state retained and
playback time advancing in the playing set. Seeking and switching source within
fullscreen, then leaving/reopening, were also exercised. Representative images
were inspected; intermediate captures were not all reviewed, so this is not
proof of absence of individual flashes.

Solid red/purple fill was reproduced while paused. Separate first-entry
fullscreen images showed white top/right strips even though AppKit model bounds
and `video-target-params` were correct. Video and controls were both offset;
opening Info without resuming playback could repair the composite. This argues
against a non-keyframe decode explanation, but does not by itself establish the
exact cause of the solid-color frame.

Changes apply host frames, drawable size and clipping in one non-animated
Core Animation transaction. Waiting on the covered main WebView's rAF was
removed; both startup and overlay presentation have independent deadlines when
WKWebView suspends animation frames. Native cover callbacks use generation
guards so stale queued callbacks cannot reveal a newer transition.

An experimental synchronous repaint/`CATransaction::flush()` caused a real
main-thread deadlock. A process sample showed CA commit → NSView display → Tao
draw_rect/event handler → wait for Tao's already-held dispatch mutex. All explicit
flush/display calls were removed. Repaint is requested with `setNeedsDisplay`
for the next run-loop pass. The final path still needs repeated paused fullscreen
visual verification; the earlier 20-cycle result cannot validate subsequent fixes.

## Controlled application fallback

In **debug macOS builds only**, set
`VESPERWIND_MPV_TEST_MACVK_STARTUP_FAILURE=1`. It gives the MacVk presentation host
zero-sized startup bounds while retaining its CAMetalLayer safely; the real
media/codec/provider stream is unchanged, and OpenGL receives the original valid
geometry. MoltenVK sees an unusable surface extent; VO does not configure within
ten seconds. The code is excluded by `cfg(debug_assertions)` in release builds.

- `auto`: MacVk failed during actual VO startup; OpenGL then played the valid
  H.264 asset. `presentationFallbackReason` was:
  `Owned video presentation initialization failed (libmpv-owned gpu-next / Vulkan / MoltenVK / Metal): video output did not configure within 10 seconds`.
- Strict `macvk`: the same injected failure showed a diagnosable player error
  and accessible Close control; no OpenGL handle was created.
- Closing while injected opening was pending stopped it without a late fallback.

Logs: `auto-vo-final-app.log`, `strict-vo-failure-app.log`,
`auto-cancel-fixed-app.log` in the evidence directory. Release exclusion follows
the compiled configuration; physical release launch with the variable remains
pending until that build is exercised.

## Display/HDR

SDR → actual PQ → actual HLG → SDR was exercised without restarting Vesperwind.
PQ/HLG decoded transfers were `pq` / `hlg`, primaries BT.2020, hwdec videotoolbox.
On this SDR display, both were correctly reported as HDR-to-SDR fallback:
BT.709/gamma2.2 output, Metal format 90, sRGB CGColorSpace, EDR false,
metadata absent, current/potential headroom 1.0/1.0.

Actual windowed PQ/HLG target node:

```json
{"pixelformat":"rgb10a2","w":2196,"h":1235,"dw":2196,"dh":1235,"aspect":1.778138,"aspect-name":"16:9","par":"nan","sar":1.778138,"sar-name":"16:9","colormatrix":"rgb","colorlevels":"full","primaries":"bt.709","gamma":"gamma2.2","sig-peak":1.0,"light":"auto","chroma-location":"unknown","stereo-in":"mono","rotate":0,"alpha":"straight","min-luma":0.203,"max-luma":203,"max-cll":0,"max-fall":0}
```

Physical HDR10/PQ/HLG presentation, reference colors, display movement, brightness
headroom changes, hotplug and sleep/wake remain pending: no second/HDR display was
available. No Dolby Vision assets or controlled dovi build were tested.

## Lifetime audit and remaining risks

The Metal host owns retains for the root, container, view and CAMetalLayer.
Addresses are dereferenced on the main thread; no explicit unsafe Send/Sync impl
is needed. Queued tasks retain the host through Arc. Retirement prevents pending
geometry/show tasks from restoring a closing surface. mpv termination and Vulkan
teardown precede final host release and NSView removal. A timed-out create drops
its fully owned surface on the main thread if the reply cannot be delivered.
The player registry mutex is released before blocking AppKit/control operations;
opening has cancellation and a generation-specific reservation guard. Late
frontend replies cannot restore a closed session. Hidden Bootstrap modals unmount
the media child, ensuring Close actually releases the player.

Source switching now cancels a session that is still opening. Session/source
generations reject its late reply or transport failure, and late state events are
ignored during Closing. Multiple switches waiting on the same close open only
the newest source; stale component continuations cannot reattach the overlay.
These final guards passed regression tests but still need application stress
verification with close/seek/fullscreen happening concurrently.

If the main loop refuses final cleanup scheduling during process shutdown, final
retains may leak until process exit; they are not released on a wrong thread.
No exhaustive Instruments leak check has been performed.

No identified SFTP **test** source was available. Remote open/seek/thumbnail
coexistence, local↔SFTP switching, close and bounded-memory acceptance remain
pending. The SFTP protocol layer was not changed.

## Validation

- Frontend: `npm test`, 261 passed, 0 failed (7.24 s). Filesystem-watcher tests
  required the native permission environment; the sandboxed run missed events.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml`, 63 passed, 2 ignored,
  0 failed; main and doc-test targets also passed.
- macOS bundle verifier passed for mpv 0.41.0 and its pinned dependency closure.
- Vite + debug and release Tauri `.app` builds passed: final debug Vite 24.69 s /
  Rust 9.14 s, release Vite 26.56 s / Rust 56.55 s. Both produced a macOS `.app`;
  no DMG or production signing/notarization acceptance is claimed.
  Final rebuilt-app visual
  acceptance remains pending: the Mac locked again and computer-use could not
  unlock it. The requested manual unlock has not yet been followed by a successful
  UI observation. Release startup with the failure-injection variable also remains
  a physical acceptance item; its name and injection message are absent from the
  compiled release executable.
- No commit, push, new player framework or network provider. OpenGL fallback is
  retained. Unrelated concurrent CSS/CI changes are not part of this stabilization.
