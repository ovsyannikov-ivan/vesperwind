# Native libmpv integration

## Implementation status

The Tauri backend owns one native player and exposes the same player contract used
by the Vue media viewer. libmpv receives an opaque
`vesperwind://<source-id>` URL. Its custom stream callbacks delegate `open`, `read`,
64-bit `seek`, `size`, cancellation, and `close` to Vesperwind's provider content
layer. Local and SFTP sources therefore follow the same path, and SSH credentials
never enter the URL, WebView, or mpv configuration.

On macOS, Vesperwind creates an `NSOpenGLView` above the main Wry webview, owns its OpenGL
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
Closing or switching a source tears down the previous stream, render context, and
mpv handle.

The backend currently reports duration, position, pause/play state, volume, mute,
audio/subtitle track metadata, selected tracks, and subtitle delay. Embedded ASS
subtitles and embedded fonts are handled by libass/libmpv. Automatic external
subtitle discovery is not guaranteed for opaque provider streams and remains
planned work.

Browser and Node SEA modes continue to use HTML/media-chrome. Audio also remains on
the established persistent web player for now. Windows has the common player and
stream implementation, but the native surface and reviewed DLL bundle are not yet
release-ready.

## HDR and color pipeline

The native player reads mpv's decoded video parameters instead of inferring HDR
from a filename. Diagnostics report transfer function, primaries, pixel format,
estimated bit depth, HDR10 mastering/CLL values when present, Dolby Vision profile,
decoder/hardware-decoder state, render surface format, and actual output mode.

On macOS, the EDR path is:

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

An HDR source is labelled **HDR output active** only when the source metadata is
HDR, the FP16 EDR surface exists, and the current screen reports headroom above
1.0. Otherwise the UI says **SDR fallback** and reports the reason. `target-peak`
uses mpv's 203-nit reference white multiplied by current EDR headroom; HDR content
is mapped to that currently available range rather than blindly clipped.

The pinned mpv 0.41 public Render API uses `vo=libmpv` with its OpenGL `vo_gpu`
backend. It is not `vo=gpu-next`, and Vesperwind does not claim that gpu-next
swapchain color-space signalling is active. The EDR implementation deliberately
uses the supported OpenGL Render API and AppKit's documented FP16 EDR surface
instead of setting gpu-next-only options.

### HDR format matrix

| Format | macOS EDR status | Windows status |
| --- | --- | --- |
| HDR10 / HEVC Main10, BT.2020 PQ | Implemented in the FP16 EDR path; manual XDR playback validation still required | Source detection works; native HDR output blocked on the DXGI renderer described below |
| HLG | Implemented through the same linear EDR target; manual XDR playback validation still required | Source detection works; native HDR output blocked on the DXGI renderer |
| Dolby Vision profile 5 | Profile metadata is detected, but the bundled libplacebo build has `dovi`/`libdovi` disabled; correct RPU reshaping is not claimed | Not supported |
| Dolby Vision profile 7 | Profile metadata is detected; an HDR10 base layer may be usable, but RPU, MEL, FEL, and enhancement-layer reconstruction are not claimed | Not supported |
| Dolby Vision profile 8 | Profile metadata is detected; a compatible base layer may be usable, but RPU processing is not claimed | Not supported |

### Windows Advanced Color blocker

The Windows surface now queries the monitor containing the player through
`DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO`, `DISPLAYCONFIG_SDR_WHITE_LEVEL`, and
`IDXGIOutput6::GetDesc1`. This reports whether Advanced Color is supported and
enabled, bits per color, display luminance, and the OS SDR reference-white level.
It is capability/diagnostic work only: the current surface is still WGL RGBA8 and
therefore always reports native HDR output as unavailable.

This cannot be completed by calling `SetColorSpace1` on the current surface.
Windows HDR composition requires a DXGI flip-model swapchain such as
`R16G16B16A16_FLOAT` scRGB (plus SDR-white scaling) or an HDR10 10-bit swapchain.
mpv 0.41's public caller-owned Render API exposes OpenGL and software targets, not
a caller-owned D3D11 texture. mpv's own `gpu-next + D3D11` path can own such a
swapchain, but that is a different window/presentation owner and cannot be embedded
in the existing Tauri geometry contract through the public Render API. Completing
Windows HDR therefore requires a dedicated D3D11/libplacebo presentation backend
(or a reviewed downstream libmpv external-target API), plus D3D11VA interop and
multi-monitor swapchain recreation. Until then, HDR sources are deliberately
tone-mapped to SDR and never labelled as HDR output.

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
The build script includes mpv's existing CoreFoundation string helper in the
headless CoreAudio source set; upstream normally adds that implementation only
with its Cocoa UI feature. No OpenAL shim, latency patch, header copy, or OpenAL
runtime dependency remains.
Native video explicitly selects `vo=libmpv`, ensuring decoded frames are presented
through the caller-owned Render API surface rather than probing a standalone mpv
GPU window.

This bundle targets macOS 12 or newer and is arm64-only. A universal/x86_64 bundle,
Developer ID signature, notarization, and Windows DLL closure are release blockers.

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

- the applicable license/copyright texts in `macos/LICENSES`;
- exact source versions, archive hashes, configure flags, and local changes in the
  checked-in build script and manifest;
- a source/relinking offer and SHA-256 manifest beside the dylibs;
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
diagnostics. Dolby Vision profiles 5/7/8 must be checked separately and must not be
reported as fully supported. Observe memory while seeking in a
several-hundred-megabyte remote file; it must not grow with total file size. Repeat
the complete matrix on Windows after the DXGI renderer and DLL bundle are
implemented.
