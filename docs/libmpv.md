# Native libmpv integration

## Implementation status

The Tauri backend owns one native player and exposes the same player contract used
by the Vue media viewer. libmpv receives an opaque
`vesperwind://<source-id>` URL. Its custom stream callbacks delegate `open`, `read`,
64-bit `seek`, `size`, cancellation, and `close` to Vesperwind's provider content
layer. Local and SFTP sources therefore follow the same path, and SSH credentials
never enter the URL, WebView, or mpv configuration.

macOS now has an **experimental** owned renderer: an application-owned NSView /
CAMetalLayer is passed through `wid` to the downstream `macvk-embedded` Vulkan
context. `vo=gpu-next` delegates rendering to libplacebo / pinned MoltenVK / Metal.
The existing controls WKWebView remains above video. The common player commands,
provider streams, fullscreen sequencing and Vue API are unchanged.

`VESPERWIND_MPV_MACOS_BACKEND=auto|macvk|opengl` selects automatic startup/VO
fallback, strict Metal diagnostics, or the established OpenGL renderer. `auto`
is the default. Strict `macvk` returns presentation errors without falling back;
source/decoder failures do not trigger renderer retry. Actual `current-vo` and
`current-gpu-context` must match before video startup succeeds.

The Metal backend remains experimental. Paused fullscreen composition, physical
HDR color accuracy, display changes and concurrent close/seek/source switching
require validation in the actual application and on the target display.

See [the upstream references and alternatives](macos-video-backend-research.md) for
embedding, VideoToolbox texture import, HDR limitations, Dolby Vision and public
AVFoundation findings. No AVFoundation player or custom video renderer was added.

For the retained OpenGL fallback, Vesperwind creates an `NSOpenGLView` above the main Wry webview, owns its OpenGL
context, and renders through libmpv's Render API on a dedicated thread. A second,
transparent child WKWebView sits above the OpenGL view and owns all native-player
chrome. The resulting order is media-controls WebView → NSOpenGLView → main WebView;
CSS z-index is not used to cross native compositor boundaries. The view
first requests an AppKit 64-bit floating-point pixel format (`NSOpenGLPFAColorFloat`
plus a color size of 64) and opts into EDR. If AppKit cannot provide that format,
creation falls back to the normal SDR pixel format instead of aborting playback.
The lightweight overlay has its own Vite entry point, subscribes to the existing
player state, and sends commands through the same frontend API boundary. It does not
own a second player. Its dropdowns, Info panel, close/fullscreen buttons, and
autohiding controls never resize the video surface. The child WebView is parked at
an off-window 1×1 rectangle while inactive because hiding a child WebView can hide
the parent window on current macOS/Wry. `macOSPrivateApi` is required for transparent
WKWebView composition.

The main Vue viewer synchronizes both native layers only during viewer open/close,
window resize, actual viewport changes, fullscreen transitions, and display scale
changes. AppKit geometry mutation and OpenGL render/swap operations share one lock;
the renderer is joined before its context and surface are destroyed.
Closing or switching a source tears down the previous stream, presentation, and
mpv handle.

Native fullscreen transitions fade the controls WebView to black, hide the
native video, and hold the opaque cover for 150 ms before resizing either sibling.
The cover expands to the viewport and follows native parent-window resizing
while ordinary geometry updates are suspended. Video remains hidden for a fixed
500 ms after the fullscreen change. The viewer then applies the final geometry
once, restores video beneath the opaque cover without raising its Windows HWND
above it, and fades back in. Neither
video-frame counters nor repeated size/readiness polling control this timing.
Windows and macOS share this sequence; reduced motion skips fades but retains
the fixed holds. The updated macOS transition still needs visual validation.
Transition steps have bounded waits, and the overlay has its own watchdog to
remove an abandoned cover and restore controls. On Windows, HWND layout never
waits for the render mutex: the graphics driver may synchronously message the
window during buffer presentation. The WGL context remains on the render thread.

The macOS native cover follows the AppKit root view above both native siblings.
Metal host geometry uses a non-animated CA transaction. Covered WKWebView rAF
callbacks can be suspended, so startup/presentation deadlines run independently
of them. Do not synchronously call AppKit display or CATransaction::flush from a
Tauri main-thread task: reentrant Tao drawing can deadlock its dispatch mutex.

Debug macOS application fallback can be exercised with
`VESPERWIND_MPV_TEST_MACVK_STARTUP_FAILURE=1`: an unusable MacVk host extent causes
actual VO startup failure, while OpenGL retains valid geometry. It neither alters
source/codec nor participates in release builds (`cfg(debug_assertions)`).

The backend currently reports duration, position, pause/play state, volume, mute,
audio/subtitle track metadata, selected tracks, and subtitle delay. Embedded ASS
subtitles and embedded fonts are handled by libass/libmpv. Automatic external
subtitle discovery is not guaranteed for opaque provider streams and remains
planned work.

Browser and Node SEA modes continue to use HTML/media-chrome. Tauri audio uses
the bundled libmpv audio-only session and shared native control loop, without a
rendering surface or child WebView. Windows has the common player and
stream implementation, an mpv-owned D3D11 HDR10-capable child HWND with WGL SDR fallback, and a pinned source-built x64
DLL closure. See [Windows build and media checks](build-windows.md) for the
decoder/audio/application verification procedure. Windows HDR10 display validation is still **not verified**;
hardware decoding depends on the media, GPU and driver.

## HDR and color pipeline

The native player reads mpv's decoded video parameters instead of inferring HDR
from a filename. Diagnostics report transfer function, primaries, pixel format,
estimated bit depth, HDR10 mastering/CLL values when present, Dolby Vision profile,
decoder/hardware-decoder state, render surface format, and actual output mode.

The experimental Metal backend requests a PQ/BT.2020 target for HDR sources when
the current display has EDR headroom, and resets SDR sources/displays to
BT.709/sRGB. HLG is mapped to PQ by libplacebo. HDR is reported active only
with a verified mpv target, actual high-depth Metal format, actual PQ layer
colorspace, wantsExtendedDynamicRangeContent and current display headroom.
CAEDRMetadata presence is reported independently. Requested options are not proof
of presented light levels. Physical display moves, brightness changes, hotplug,
sleep/wake and HDR color accuracy still need application/display acceptance.

For the OpenGL fallback, the EDR path is:

1. decode HDR10/PQ or HLG through the normal libmpv video pipeline;
2. ask mpv's OpenGL renderer for a linear Display-P3 target and a floating-point
   intermediate format;
3. render to an AppKit FP16 OpenGL backbuffer, passing `GL_RGBA16F` and 16-bit
   surface depth to the public libmpv Render API;
4. opt the `NSOpenGLView` into EDR and adapt `target-peak` to the current
   `NSScreen.maximumExtendedDynamicRangeColorComponentValue`;
5. poll the window's current screen so moving the viewer between displays,
   fullscreen transitions, power/brightness changes, and EDR-headroom changes
   update the output decision.

In the OpenGL fallback, an HDR source is labelled **HDR output active** only when the source metadata is
HDR, the FP16 EDR surface exists, and the current screen reports headroom above
1.0. Otherwise the UI says **SDR fallback** and reports the reason. `target-peak`
uses mpv's 203-nit reference white multiplied by current EDR headroom; HDR content
is mapped to that currently available range rather than blindly clipped.

The pinned mpv 0.41 public Render API uses `vo=libmpv` with its OpenGL `vo_gpu`
backend. It is not `vo=gpu-next`, and Vesperwind does not claim that gpu-next
swapchain color-space signalling is active. The OpenGL fallback EDR implementation
uses the supported OpenGL Render API and AppKit's documented FP16 EDR surface
instead of setting gpu-next-only options.

### HDR format matrix

| Format | macOS status | Windows status |
| --- | --- | --- |
| HDR10 / HEVC Main10, BT.2020 PQ | Experimental Metal PQ/BT.2020 target with OpenGL FP16 EDR fallback; actual application HDR-display validation pending | D3D11 PQ/BT.2020 output policy implemented; actual RGB10A2/PQ target checked through mpv. HDR display/HDMI validation: **not verified** |
| HLG | Metal maps HLG to PQ; OpenGL retains its linear EDR path. Actual application HDR-display validation pending | SDR tone mapping; native HLG output planned after HDR10 validation |
| Dolby Vision profile 8.x | gpu-next applies libplacebo's built-in RPU reshaping (verified on a real 8.1 file: `colormatrix=dolbyvision`, VideoToolbox, Metal). The OpenGL fallback keeps the base layer | Script builds `dovi=enabled`; the committed artifact predates it, so the HDR10/HLG base layer is used until the rebuild |
| Dolby Vision profile 5 | Same mapping and reshaping path as profile 8 (residual disabled); not yet verified with a real file. Without gpu-next, Info reports incorrect colors | As profile 8.x; without reshaping Info reports incorrect colors |
| Dolby Vision profile 7 | MEL/FEL is classified from the first frame's RPU. mpv 0.41 maps only residual-disabled RPUs, so MEL/FEL streams play the HDR10 base layer; no enhancement-layer reconstruction | As macOS |

Profile 8.1 has an HDR10-compatible base layer and Profile 8.4 has an
HLG-compatible base layer. Successful playback of such a file can therefore
come from the compatible base layer rather than Dolby Vision processing. The
profile number alone does not establish base-layer compatibility; see Dolby's
[profile compatibility reference](https://ott.dolby.com/browser_test_kit/help_files/topics/r_resources.html).

Both build scripts configure libplacebo with `-Ddovi=enabled -Dlibdovi=disabled`.
The built-in `dovi` code (LGPL-2.1+) reshapes from FFmpeg's parsed
`AVDOVIMetadata`; the external `libdovi` parser is never built. The macOS bundle
was rebuilt this way. The Windows manifest entry records the recipe
(`buildRecipeLibplaceboOptions`, dovi enabled) separately from the committed
artifact (`requiredLibplaceboOptions`, still `-Ddovi=disabled`, with
`artifactPendingRebuild: true`) until `build-libmpv-windows.ps1` rebuilds it; see
docs/build-windows.md. `scripts/libmpv-dovi.js` makes both
bundle verifiers require the manifest, the `doviProcessing` note and the
artifact's own evidence (`pl_has_dovi`/`pl_has_libdovi`, and a compiled
`PL_HAVE_LAV_DOLBY_VISION` check from `scripts/probe-libmpv-dovi.c`) to agree.

Diagnostics expose `dolbyVision` as separate facts:

- Source: profile and level from mpv; compatibility id, RPU/EL/BL flags from
  the FFmpeg configuration record; `disable_residual_flag` and MEL/FEL from the
  first frame's RPU as FFmpeg parsed it. The pinned FFmpeg sidecar reads these
  for local files only; anything without evidence (remote files, a missing
  sidecar) stays unknown. A profile number never implies a compatibility id,
  an RPU or an enhancement-layer kind. Vesperwind does not parse bitstreams.
- Processing: `rpuProcessingActive` is true only when mpv mapped the RPU
  (`video-params/colormatrix=dolbyvision`) and `current-vo` is `gpu-next`.
  A base-layer fallback is reported as "RPU not applied".
- Enhancement layer: present/MEL/FEL/unknown;
  `enhancementLayerProcessingActive` is always false with mpv 0.41.
- Output: HDR/SDR presentation stays in the existing output diagnostics.
  `systemOutputActive` and `systemDolbyVisionOutput` are always false: no
  Dolby Vision display signalling is negotiated.

The player logs one `dolby-vision ...` line whenever this state changes, never
per frame. `scripts/probe-libmpv-dovi-runtime.m` (built like the embedding probe
below) prints the same mpv properties for one file, and
`node scripts/media-dolby-vision-acceptance.mjs /absolute/movie.mkv` records the
application's diagnostics, Info rows and log line through the
`--media-ui-regression` driver. HDR-capable physical displays still require
validation of the actual VO, target, layer colorspace, EDR headroom and visible
output.

The Windows path requires HDR to be active on the player's monitor. Info separates
source, decode, processing, presentation and output summaries; the full diagnostic
snapshot retains the underlying metadata. Requested settings are insufficient:
actual `video-target-params` must confirm PQ, BT.2020 and `rgb10a2`. DXGI color-space
mapping is labelled Expected; HDR metadata delivery and physical HDMI output need
external verification. There is no Windows FP16 scRGB path in this stage.

### Windows HDR10 PQ / BT.2020 output

The Windows surface now queries the monitor containing the player through
`DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2` when supported, with the legacy
`DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` fallback, `DISPLAYCONFIG_SDR_WHITE_LEVEL`,
and `IDXGIOutput6::GetDesc1`. The modern query distinguishes HDR capability,
the user's HDR setting, Advanced Color activity and active HDR mode. Active HDR
also requires the DXGI output to report PQ/BT.2020. Advanced Color/WCG alone is
not treated as HDR. Legacy APIs can prove active HDR, but HDR capability on a
disabled Advanced Color display may remain **not verified**. Query failure
selects SDR conservatively; cached HDR capability is never used as proof.

The new backend passes a child HWND through `wid` and lets mpv's `gpu-next`
own the D3D11 device and swapchain. It does not use the caller-owned Render API.
Initial `d3d11-output-format=rgba8` is a best-effort SDR preference in gpu-next,
not a fixed HDR format. `d3d11-output-csp=srgb` keeps initial presentation SDR.
`target-colorspace-hint=yes`, `target-colorspace-hint-mode=target` and
`target-colorspace-hint-strict=yes` let libplacebo negotiate its own swapchain
and render to the returned color space. Source PQ/BT.2020 plus verified active
Windows HDR selects `target-trc=pq`, `target-prim=bt.2020`, `target-peak=auto`.
All other cases, including SDR on an HDR desktop and HLG in this stage, select
BT.709/gamma 2.2 and `target-peak=203`. Primaries change first when leaving HDR;
transfer changes first when entering it, avoiding a transient wide-gamut SDR
hint that pinned libplacebo would map to FP16 scRGB. Decoder selection remains
`hwdec=auto-safe` with direct D3D11VA surfaces; HDR adds no RAM copy-back.
Automatic startup/VO initialization
failure retries through the existing WGL Render API; source/decoder errors do
not trigger that retry. `VESPERWIND_MPV_WINDOWS_BACKEND=auto|d3d11|wgl` selects
automatic or strict diagnostic modes. The Info diagnostics retain any startup
fallback reason. Owned VO has no public per-Present callback, so its Render API
frame counters remain zero rather than fabricating presentation evidence.

The pinned upstream path is used without changes to mpv 0.41.0, FFmpeg 8.0 or
libplacebo 7.351.0. mpv creates the DXGI swapchain and libplacebo wraps it, selects
`DXGI_FORMAT_R10G10B10A2_UNORM` / `DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020`,
checks format/color-space support, calls `SetColorSpace1`, resizes buffers and
calls `Present`. Vesperwind does not implement another DXGI renderer.
libplacebo's `set_swapchain_metadata` calls `SetHDRMetaData(HDR10)` with mastering
primaries/white point, min/max mastering luminance, MaxCLL and MaxFALL from the
negotiated hint; SDR clears metadata with type `NONE`. Hint mode `target`
merges display parameters and source metadata, and upstream may infer missing
values or adjust light levels for display mapping. This is not claimed to be
bitstream metadata passthrough. Runtime diagnostics distinguish exposed source
metadata from mpv target metadata; missing source values are not invented by
Vesperwind. Info shows compact playback summaries, without raw luminance values,
DXGI enum names or performance counters. Detailed evidence remains in the runtime
diagnostic snapshot and optional mpv log. Unknown audio layouts such as
`undefined8` appear as `8 channels`; selected tracks use a checkmark. Native
scrollbars use the same thin, theme-aware style in the main and media windows.

Pinned source references:
[mpv D3D11 context](https://github.com/mpv-player/mpv/blob/2c219aa822df18a1b7fd9abe3e151cd93ad67307/video/out/d3d11/context.c),
[gpu-next target and hints](https://github.com/mpv-player/mpv/blob/2c219aa822df18a1b7fd9abe3e151cd93ad67307/video/out/vo_gpu_next.c),
[libplacebo DXGI negotiation and metadata](https://github.com/haasn/libplacebo/blob/3188549fba13bbdf3a5a98de2a38c2e71f04e21e/src/d3d11/swapchain.c).

**Evidence levels:** requested target options are separate from actual
`video-target-params`. gpu-next sets that property after rendering, using the
actual backbuffer format (`rgb10a2`, `rgba8`, etc.) and negotiated target color.
HDR output is labelled active only when policy, current display state, current
requested rendering options and the PQ/BT.2020 `rgb10a2` target agree. The DXGI
format is mapped from that actual backbuffer name using the pinned format table.
The DXGI color-space enum is labelled **Expected**, not directly queried:
libmpv has no client getter for the last `SetColorSpace1` result. Neither
`SetHDRMetaData` acknowledgement nor physical HDMI color state is exposed;
metadata delivery remains **not verified**, even if target metadata is present.
The upstream log line “New swap chain configuration received from hint” is
printed before negotiation and must not be used alone as proof.

The DLLs and their checksums/build provenance are unchanged. The original
`windows/BUILD-INFO.txt` records the application policy at the time the runtime
was packaged (SDR); that historical string does not limit the library's HDR
capabilities. Current application policy is recorded in `manifest.json`, and
future packaging copies those descriptions from the manifest.

The current monitor/Windows state is re-queried every two seconds. Policy changes
update target options on the existing VO and request its normal redraw, including
when paused; a stale HDR target on an SDR output cannot keep the HDR-active flag.
Output mismatch is labelled unverified rather than claiming successful HDR.
Display migration and live HDR toggles on real HDR hardware are **not verified**.
If negotiation remains in fallback (including libplacebo's sticky 8-bit fallback),
close and reopen the viewer to recreate the player/VO. The fixed opaque fullscreen
holds and audio/stream lifecycle are unchanged.

**Manual acceptance remains pending:** Philips HDR ON/OFF, SDR on the HDR desktop,
HDR/SDR monitor migration, live HDR toggle, physical HDR output and HDR metadata
delivery. Automated policy tests do not replace those checks. Compare frame-drop,
decoder-drop and delayed-frame counters over a steady playback interval, excluding
startup/seek/fullscreen, and confirm `hwdec-current=d3d11va` with decoded `d3d11`
surfaces. Check tracks, seek, subtitles, fullscreen and WGL separately. Runtime
diagnostics also include `video-sync` and `avsync`; mpv's optional log records
presentation errors. Never infer HDR from source metadata or a TV popup alone.

After manual HDR10 validation, the separate future stages are HLG and a reviewed FP16 scRGB
path. Windows defines scRGB 1.0 as 80 nits while the pinned libplacebo path uses
a 203-nit reference, requiring a backport or coordinated library update first.
Dolby Vision RPU reshaping without `libdovi` is enabled (see above). Profile 7 FEL
reconstruction needs mpv's enhancement-layer pairing (`demux/dovi_split.c`,
`filters/f_enhancement_pair.c`) and libplacebo API 367, both unreleased after
mpv 0.41.0 / libplacebo 7.360.1; vendor Dolby Vision HDMI signalling is out of
scope. Compatible base-layer playback is not Dolby Vision output.

## Bundled macOS runtime

`src-tauri/vendor/libmpv/macos` contains an arm64 development runtime built from
the following pinned sources:

| Component | Version | Configuration / license used |
| --- | --- | --- |
| mpv/libmpv | 0.41.0, commit `2c219aa822df18a1b7fd9abe3e151cd93ad67307` | shared libmpv, `gpl=false`, no cplayer; LGPLv2.1+ source selection |
| FFmpeg | 8.0 | shared, LGPLv2.1+, `--disable-gpl --disable-nonfree --disable-version3` |
| libplacebo | 7.351.0, commit `3188549fba13bbdf3a5a98de2a38c2e71f04e21e` | OpenGL renderer, LGPLv2.1+ |
| libass | 0.17.4 | ISC; CoreText font provider |
| FreeType | 2.14.1 | FreeType License |
| FriBidi | 1.0.16 | LGPLv2.1+ |
| HarfBuzz | 11.5.0 | MIT |

The build contains no external `mpv` executable and does not search Homebrew,
mpv.app, or the host PATH at runtime. All non-system dylibs use `@loader_path` and
are bundled beside `libmpv.2.dylib`. The remaining system dependencies are macOS
frameworks/libraries, including OpenGL, CoreText, CoreAudio, AudioUnit, and
AudioToolbox.

The checked-in artifact was rebuilt with Xcode 27.0 (build 27A266a) and the macOS
27.0 SDK. FFmpeg has VideoToolbox enabled for H.264 and HEVC while retaining the
LGPL-compatible `--disable-gpl --disable-nonfree --disable-version3` constraints.
mpv's direct VideoToolbox/OpenGL interop remains disabled. Vesperwind requests
`hwdec=auto-copy-safe`, so supported streams use the safe `videotoolbox-copy` path
into the caller-owned OpenGL Render API and unsupported codecs or failed hardware
initialization fall back to software. `macos/BUILD-INFO.txt` records the exact SDK,
configuration macros, FFmpeg hardware-device probe, and decoder availability; the
bundle verifier checks that evidence and its checksum. Runtime `hwdec-current` is
reported in the player's Info panel rather than inferred from build configuration.
HDR output remains independent from decoder selection.

Xcode 27 no longer ships macOS OpenAL headers, so this bundle uses mpv's native
CoreAudio output instead of the previous deprecated OpenAL compatibility patch.
The pinned mpv CoreAudio channel-map call fails with `paramErr` on macOS 27,
which can disable the selected AAC track. `scripts/patches/mpv-macos27-coreaudio.patch`
reverts that call until upstream provides a compatible fix. The runtime also
includes AVFoundation and requests `ao=coreaudio,avfoundation`, so it can play
audio when CoreAudio initialization fails on another system. CoreAudio remains
preferred because AVFoundation has an upstream end-of-playback truncation report.
The build script includes mpv's existing CoreFoundation string helper in the
headless CoreAudio source set; upstream normally adds that implementation only
with its Cocoa UI feature. No OpenAL shim, latency patch, header copy, or OpenAL
runtime dependency remains.
Native video explicitly selects `vo=libmpv`, ensuring decoded frames are presented
through the caller-owned Render API surface rather than probing a standalone mpv
GPU window.

This bundle targets macOS 12 or newer and is arm64-only. A universal/x86_64 bundle,
Developer ID signature and notarization remain release blockers for macOS.

## Bundled Windows runtime

`src-tauri/vendor/libmpv/windows` contains the same seven pinned media-library
versions listed above, built with MSYS2 UCRT64 GCC 16.2.0 (Rev4). The application
uses `x86_64-pc-windows-msvc`; the media boundary is the public C ABI. The upstream
`libmpv-2.dll` is packaged under the existing `mpv-2.dll` entry name. No prebuilt
mpv DLL or `mpv.exe` is used. libass uses DirectWrite; mpv enables WASAPI, OpenGL, D3D11,
Win32 threads and D3D hardware decode. FFmpeg enables H.264/HEVC D3D11VA and DXVA2
while disabling GPL, non-free and version-3-only features. See `BUILD-INFO.txt`
for all source hashes, submodule revisions, compiler packages and build flags.

The 18-DLL closure includes avcodec, avformat, avfilter, avutil, swresample,
swscale, libplacebo, libass, FreeType, FriBidi, HarfBuzz, GNU libiconv and GCC
runtime support, shaderc and SPIRV-Cross. shaderc incorporates glslang and
SPIRV-Tools; package revisions and their license texts are recorded. All non-system
dependencies are colocated. The PE verifier
checks normal and delay-load imports, x64 PE32+ DLL headers, an explicit Windows
system-library allowlist, absence of local build paths, feature evidence,
license/source-offer files and exhaustive SHA-256 checksums. Runtime loading uses
an absolute entry path with `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` and
`LOAD_LIBRARY_SEARCH_SYSTEM32`, so codec dependencies cannot come from PATH.

Windows defaults to the mpv-owned D3D11 backend with HDR10 policy and retains the public libmpv
OpenGL Render API with an RGBA8 SDR backbuffer as fallback.
Its native layer order is controls WebView2 → video child → main WebView2. Native
window ordering is explicit; CSS z-index cannot order separate HWNDs. The owned
backend uses `hwdec=auto-safe` and can import D3D11VA surfaces directly; the
OpenGL fallback retains `auto-copy-safe`. A 4K HEVC GUI check reported `d3d11va`
on Intel UHD Graphics 630. Hardware decoding does not imply HDR output: HDR input
still uses SDR fallback when Windows HDR is inactive. The existing performance settings use bilinear downscaling without the
antialiasing correction pass and disables per-frame HDR peak analysis; tone
mapping still uses source metadata and output dithering remains enabled.

Blocking media operations run on workers, while native WebView callbacks remain
on the window thread. Playback time updates every 100 ms; tracks and diagnostics
refresh once per second. Geometry updates coalesce to the newest pending bounds,
and overlay coverage compares physical pixels across independently zoomed WebViews.

Rebuild instructions are in [Windows build prerequisites](build-windows.md).
The source build root and MSYS2 installation must remain outside the repository.
The build procedure is reproducible with the recorded packages; bit-identical
output across different toolchain versions is not claimed. The existing macOS
runtime and platform-specific source patches remain unchanged.

## Rebuilding

Requirements are full Xcode (not Command Line Tools alone), Python 3, CMake, Git, and network access
to the pinned upstream repositories. Run:

```bash
./scripts/build-libmpv-macos.sh
node scripts/verify-libmpv-bundle.js macos
```

`VESPERWIND_LIBMPV_BUILD_DIR` can select another temporary build directory. The
script accepts `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, verifies
that `xcodebuild` and the full macOS SDK are available, verifies archive SHA-256
values, records the two required compatibility
configuration inputs, builds every dynamic dependency, rewrites install names, applies
ad-hoc development signatures, copies license texts, and creates bundle checksums.

For development only, `VESPERWIND_LIBMPV_PATH` may point the loader at an explicit
libmpv path. The production loader otherwise searches only Vesperwind bundle
locations.

## Licensing and distribution

The MIT license in the repository root applies to Vesperwind's own source code. It
does not relicense libmpv or its dependencies.

mpv is GPLv2+ by default. `-Dgpl=false` selects its intended LGPLv2.1+ source set,
but redistribution compliance also depends on every linked library and FFmpeg
feature. This build deliberately excludes mpv GPL sources and FFmpeg GPL, non-free,
and version-3-only components. Adding a codec or dependency requires a fresh
license review; GPL-only components must not be enabled without the owner's explicit
approval and a compatible project licensing decision.

The bundle includes:

- the applicable license/copyright texts in each platform's `LICENSES` directory;
- exact source versions, archive hashes, configure flags, and local changes in the
  checked-in build script and manifest;
- a source/relinking offer and SHA-256 manifest beside the platform libraries;
- dynamically replaceable LGPL libraries, with no anti-relinking measure.

This is an engineering compliance review, not legal advice. Final public binaries
should receive legal review and be re-signed after all dylib/install-name changes.
On macOS, remove Finder/resource-fork extended attributes from the completed app
bundle (`xattr -cr Vesperwind.app`) before applying the final Developer ID signature;
an ad-hoc development signature does not replace signing and notarization.

## Manual release checks

Before calling native playback ready, test a signed application on an unlocked
machine with local and SFTP MP4/MKV files, embedded ASS/fonts, multiple audio and
subtitle tracks, forward/backward seeking, fullscreen enter/exit, close/reopen, and
source switching. For HDR, use known HDR10 and HLG samples on a MacBook Pro XDR;
confirm visible highlight headroom, correct non-gray blacks, natural skin tones,
correct fullscreen round trips, and automatic SDR fallback on a non-EDR screen.
Exercise display movement and brightness/power changes while watching the built-in
diagnostics. Dolby Vision profiles 5/7/8 must be checked separately with
`media-dolby-vision-acceptance.mjs`; reshaping is not native Dolby Vision output. Observe memory while seeking in a
several-hundred-megabyte remote file; it must not grow with total file size. Repeat
the SDR playback matrix on Windows independently of the future DXGI HDR work.


## Experimental macOS Metal build and checks

Run `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/build-libmpv-macos.sh`.
The default recipe builds Vulkan/MoltenVK with the embedded context and retains
OpenGL. `VESPERWIND_LIBMPV_MACOS_PRESENTATION=opengl` builds the earlier minimal
closure. MoltenVK 1.3.0 and glslang 15.1.0 are pinned and checksum verified; the
MoltenVK dependency refs, notices and build feature evidence accompany the dylibs.
The private Vulkan pkg-config entry links libMoltenVK directly. No system loader,
ICD JSON, Cocoa/Swift mpv application UI or external mpv process is required.

libplacebo's built-in Dolby Vision reshaping is always built (`dovi=enabled`,
`libdovi=disabled`); the build fails unless the installed libplacebo reports
`pl_has_dovi=1 pl_has_libdovi=0` and mpv's headers define
`PL_HAVE_LAV_DOLBY_VISION`. It does not enable native Dolby Vision output or
Profile 7 FEL decoding. The profile/level, processed-RPU evidence and base-layer
fallback are independent from HDR output diagnostics. Unknown raw RPU state is
not reported absent.

`node scripts/verify-libmpv-bundle.js macos` checks checksums, the complete dylib
closure, architectures, deployment targets, signatures and Metal build notices.
Release builds still need Developer ID signing, hardened-runtime and notarization
acceptance; development ad-hoc signatures do not establish that.

A small public-client embedding probe is included in `scripts/probe-libmpv-macvk.m`:

```sh
xcrun clang -isysroot "$(xcrun --sdk macosx --show-sdk-path)" \
  -I/private/tmp/vesperwind-libmpv-build/prefix/include \
  -Lsrc-tauri/vendor/libmpv/macos -lmpv.2 \
  -Wl,-rpath,"$PWD/src-tauri/vendor/libmpv/macos" \
  -framework AppKit -framework QuartzCore scripts/probe-libmpv-macvk.m \
  -o /private/tmp/vesperwind-macvk-probe
install_name_tool -change @loader_path/libmpv.2.dylib @rpath/libmpv.2.dylib /private/tmp/vesperwind-macvk-probe
codesign --force --sign - /private/tmp/vesperwind-macvk-probe
/private/tmp/vesperwind-macvk-probe /absolute/path/video.mkv /absolute/path/another.mp4
```

It checks actual VO/context, paused resize, play/pause/seek, source switching and
three complete lifetimes; its HDR hint inspection is not a physical HDR test.
It does not validate Tauri z-order, controls or native fullscreen. Run those in
the real application with both strict overrides and automatic fallback.


## Track presentation, media OSD and resume

Track labels share `src/utils/mediaInfo.js` across Info, menus and OSD. Language
always accompanies a meaningful title; duplicate language/title is removed without
modifying file metadata. Existing language aliases are retained, with offline
Intl DisplayNames and raw-code fallback. mpv codec-profile is used to distinguish
confirmed DTS-HD MA/HRA from generic DTS; profiles may only become available after
a track has decoded. Channel layout is independent of codec: mono/1 -> 1.0 mono,
stereo/2 -> 2.0, common six/eight-channel counts -> 5.1/7.1 only when a useful explicit
layout is absent. Exotic explicit layouts remain unchanged.

`MediaOsd.vue` renders the same small top-left, pointer-transparent plate in normal
and fullscreen overlay WebViews. Explicit Play/Pause and actual selected-track
confirmation produce messages; initial autoplay does not. A shared 1.8-second
replacement timer rejects stale events, has no message queue and honors reduced
motion. Confirmed restore displays Play with actual restored position, without a
second autoplay notification. OSD is independent of controls auto-hide and does
not enable mpv's built-in OSD or alter native renderers.

See [video thumbnail previews](video-thumbnails.md) and
[SQLite position history](media-history.md).
