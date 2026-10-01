# macOS owned video output research

Research date: 2026-10-02. Library baseline: mpv 0.41.0
(`2c219aa822df18a1b7fd9abe3e151cd93ad67307`), FFmpeg 8.0,
libplacebo 7.351.0 (`3188549fba13bbdf3a5a98de2a38c2e71f04e21e`).
Source feasibility is distinct from application, display and codec acceptance.

## 1. Current Vesperwind architecture

`src-tauri/src/mpv/mod.rs` loads the bundled C ABI. `player.rs` owns the control
thread, custom provider stream, mpv handle, lifecycle and common player snapshot.
`presentation.rs` separates rendering from commands/events. `render.rs` owns
Render API callbacks, its rendering thread, context and frame/swap counters.
`stream.rs` keeps the opaque `vesperwind://` local/SFTP source contract.

macOS: `surface_macos.rs` owns an AppKit NSOpenGLView/context; `vo=libmpv`
feeds the public OpenGL Render API (`vo_gpu`, not gpu-next). The optional FP16
surface uses a linear Display-P3 target, EDR and current NSScreen headroom.
Decoder policy is auto-copy-safe. A transparent controls WKWebView remains above
video, above the main Wry WebView. Native fullscreen and transition covers are
application owned. Shutdown joins rendering before destroying context/surface.

Windows: a child HWND is passed through wid; gpu-next/D3D11 owns its GPU device
and DXGI swapchain. auto-safe permits direct D3D11VA. Startup/VO failure retries
with the WGL Render API, while source/decoder failures do not. Strict d3d11/wgl
overrides exist. HDR checks actual video-target-params as well as display state.
This primary/fallback structure is reusable without changing the Vue player API.

## 2. Pinned upstream macvk

The [pinned Vulkan context](https://github.com/mpv-player/mpv/blob/2c219aa822df18a1b7fd9abe3e151cd93ad67307/video/out/vulkan/context_mac.m)
creates VK_EXT_metal_surface over MacCommon.layer and uses mpv's existing Vulkan
RA/swapchain helpers. It requires an initialized NSApplication and constructs
MacCommon, which creates its own view/window. It does not inspect WinID.
`mac_common.swift` and `mac/metal_layer.swift` supply standalone AppKit window
management, display-link timing and diagnostic layer subclasses. Meson requires
Cocoa + Swift + Vulkan for that context. Simply changing Vesperwind's vo options
would therefore create the wrong windowing architecture.

`vo_gpu_next.c` can use this RA context with libplacebo directly. Vulkan support
requires libplacebo's Vulkan feature and Vulkan headers/API >= 1.3.238. A GLSL
to SPIR-V compiler is needed at runtime. The public client API can control an
owned VO; the public caller-owned Render API still does not expose gpu-next.

## 3. mpv PR #7857

[PR #7857](https://github.com/mpv-player/mpv/pull/7857) was closed unmerged on
2023-11-20. Its separate moltenvk context interprets wid as CAMetalLayer*, creates
VkMetalSurfaceEXT and delegates rendering to the existing Vulkan RA. Review
discusses changing wid semantics from NSView to layer and whether a separate
context is appropriate. Maintainers did not reject layer-pointer semantics as
technically impossible. There is a reviewed width/height typo in reconfig,
reports of black screens/GPU timeouts, and a later unresolved HDR colorspace
report. The recorded thread does not establish one definitive closure reason;
it is not evidence that embedding is unsupported by Metal.

Its obsolete build integration, missing resize notifications and insufficient
HDR negotiation make a verbatim backport unsuitable.

## 4. MPVKit

[MPVKit's patch](https://github.com/mpvkit/MPVKit/blob/f82e06d4f5ef4fc4aa9faba3782a462dbbef870c/Sources/BuildScripts/patch/libmpv/0001-player-add-moltenvk-context.patch)
is a modern Meson adaptation: moltenvk feature, independent Vulkan context,
CAMetalLayer* through WinID, VkMetalSurfaceCreateInfoEXT, FIFO and the current
`ra_ctx_params` API. It avoids Cocoa/Swift window ownership. Reconfig reads
drawableSize; control returns VO_NOTIMPL. Thus initial layout alone is insufficient
for a Vesperwind paused resize: a resize event/reconfig path is still necessary.
The host must keep the layer alive until Vulkan swapchain/surface destruction.
MPVKit's Apple framework packaging is evidence for the mechanism, not a drop-in
replacement for our LGPL shared dylib closure or exact version pins.

## 5. Plex

[Plex release/0.37 context](https://github.com/plexinc/mpv/blob/41f0485b19c80b630bc8b530065054809a28f130/video/out/vulkan/context_moltenvk.m)
adds a CALayerDelegate that updates VO dimensions and wakes resize/expose events.
This fixes the missing live resize signal. However, it installs a delegate on the
host's layer and writes VO fields from a Core Animation callback; neither is a
good contract for an AppKit backing layer owned by Vesperwind. Delegate/context
teardown must also synchronize callback lifetime. We retain its requirement
(resize + redraw when paused), not that cross-thread implementation.

## 6. Current upstream status

GitHub API/search and master at `3186d369f9f090cd1363be0ac46a037824b702c6`
still show [macvk wid embedding as unfinished](https://github.com/mpv-player/mpv/issues/13608).
The current context_mac.m still constructs MacCommon without WinID embedding.
New [PR #17221](https://github.com/mpv-player/mpv/pull/17221) is open and restores
NSView embedding in Cocoa-CB/OpenGL; it is not a gpu-next/Metal solution and pulls
in the Cocoa/Swift layer. No newer matching macvk/CAMetalLayer upstream candidate
was found in the queried issues/PRs. This is a dated search result, not a claim
that no unpublished implementation exists.

## 7. NSView versus CAMetalLayer embedding

NSView embedding would require adapting MacCommon to skip standalone app/window
setup, delegate fullscreen and input to the host, and maintain Swift/AppKit
ownership. It is possible, but larger than the surface requirement.

CAMetalLayer embedding is the smaller contract. Vesperwind creates an NSView with
a CAMetalLayer, retains both, sets frame/contentsScale/drawableSize on the main
thread and preserves controls > host > main WebView. A downstream context named
`macvk-embedded` documents wid as CAMetalLayer* cast to intptr_t. Distinct naming
prevents accidentally passing a layer pointer to upstream macvk's NSView/window
code. Vulkan/libplacebo/MoltenVK own rendering and presentation.

For the first experiment, bounded VO-thread size polling can detect changed
drawableSize and set resize/expose events, including paused playback, without
overwriting AppKit's layer delegate or retaining a callback into a destroyed VO.
No rendering, pixel conversion or drawable presentation belongs in Rust.

## 8. Build and distribution

Keep OpenGL/Render API enabled. Add the embedded context, Vulkan, videotoolbox-pl
and a SPIR-V compiler to the existing LGPL source build; keep Cocoa/Swift disabled.
Use pinned MoltenVK 1.3.0 (`49b97f26ae013b9e5bfb3098ee5dea5e4f58e9e8`), including
its pinned ExternalRevisions. Directly link Vulkan calls to libMoltenVK rather
than a general loader. This eliminates an ICD JSON/search-path dependency and
system Vulkan installation. libplacebo's vk-proc-addr must be enabled so it uses
that linked implementation instead of dlopen of a user's libvulkan.

Build glslang from pinned source with its default resource limits library and
static compiler components; shaderc is unnecessary in this variant. MoltenVK
incorporates SPIRV-Cross/SPIRV-Tools/cereal internally. The dynamic closure adds
libMoltenVK; static compiler dependencies do not become user-installed dylibs.
Vulkan-Headers are build inputs. FFmpeg Vulkan Video decoding is not required
for VideoToolbox texture import.

MoltenVK and its incorporated dependencies have permissive licenses, distinct
from the LGPL mpv/FFmpeg/libplacebo libraries. Package all notices and exact source
revisions, retain shared/relinkable LGPL libraries and local patches in the source
offer, and verify the complete Mach-O closure, deployment targets, signatures and
exhaustive checksums. Rewrite local non-system imports to @loader_path. Sign
inside-out with the application's Developer ID for hardened runtime/notarization;
ad-hoc development signatures do not demonstrate release acceptance. No private
API, entitlements bypass or system MoltenVK lookup is required. Legal review of
the distributed notices/source offer remains a release check.

## 9. Hardware decoding

[mpv's pinned hwdec_vt_pl.m](https://github.com/mpv-player/mpv/blob/2c219aa822df18a1b7fd9abe3e151cd93ad67307/video/out/hwdec/hwdec_vt_pl.m)
checks PL_HANDLE_MTL_TEX import support, obtains the Metal device through
vkExportMetalObjectsEXT when available, creates CVMetalTextureCache textures from
CVPixelBuffer planes, and imports those textures into libplacebo. The matching
libplacebo Vulkan implementation imports via VK_EXT_metal_objects. This avoids
the mandatory CPU copy-back stage; GPU conversions/copies and synchronization
may still exist, so do not promise universal zero-copy.

`videotoolbox-pl` is a build feature/interop mapper, not a separate hwdec option.
The actual decoder is named videotoolbox. Request auto-safe only for the owned
backend; retain auto-copy-safe for Render API. Import/device/pixel-format failures
must permit mpv's decoder fallback. Report hwdec-current and decoded pixelformat,
never infer direct decoding merely from the request or VideoToolbox build macros.
HEVC Main10 acceptance requires actual decoded surfaces, not just codec support.

## 10. HDR10 / HLG

[MoltenVK 1.3.0 swapchain](https://github.com/KhronosGroup/MoltenVK/blob/49b97f26ae013b9e5bfb3098ee5dea5e4f58e9e8/MoltenVK/MoltenVK/GPUObjects/MVKSwapchain.mm)
sets CAMetalLayer pixelFormat and maps Vulkan colorspace to CGColorSpace and EDR.
PQ maps to ITU-R 2100 PQ; HLG maps to ITU-R 2100 HLG. Its HDR metadata entry point
builds CAEDRMetadata from mastering/light-level information. libplacebo's Vulkan
swapchain negotiates formats/colorspaces and applies hints/metadata. The Swift
MetalLayer principally logs changes and works around drawable-size quirks;
it is not a required custom HDR renderer.

Use source-aware PQ/BT.2020 target hints on an EDR-capable display, with peak
adapted to current headroom; convert HLG through libplacebo. Keep SDR requests
on displays without current usable headroom. Do not reuse the OpenGL linear P3
settings indiscriminately: pinned libplacebo rejects extended-sRGB swapchain
spaces and maps the old DCI-P3-linear alias differently from Display-P3. PQ is a
more explicit initial experiment. Actual negotiated video-target-params must
agree with the layer's pixel format, CGColorSpace and EDR flag before reporting
HDR active. Layer EDR opt-in alone proves neither HDR pixels nor physical output.

Refresh current screen/headroom and observed layer state after layout and during
playback. Display migration, fullscreen, hotplug, sleep/wake and brightness changes
need real acceptance. Vulkan may need swapchain recreation after device/surface
loss; first-stage fallback covers initialization, not seamless midstream recovery.
The old FP16 EDR path remains the independent recovery/diagnostic backend.

## 11. Dolby Vision / libplacebo

Both existing platform scripts explicitly disable dovi/libdovi. Git history and
docs establish a staged HDR10/base-layer scope; they do not establish that built-in
dovi requires a GPL dependency. [libplacebo's build](https://github.com/haasn/libplacebo/blob/3188549fba13bbdf3a5a98de2a38c2e71f04e21e/src/meson.build)
has independent options: dovi enables its own reshaping shaders, while libdovi adds
an external parser. With FFmpeg 8 parsed AVDOVIMetadata, built-in reshaping can
operate without libdovi. Keep libdovi disabled; expose a deliberate optional dovi
build for subsequent evaluation, retaining disabled as the first-stage baseline.

mpv maps AV_FRAME_DATA_DOVI_METADATA only when libplacebo supports it and the RPU
does not require an enhancement-layer residual. [mp_image.c](https://github.com/mpv-player/mpv/blob/2c219aa822df18a1b7fd9abe3e151cd93ad67307/video/mp_image.c)
checks disable_residual_flag before mapping. Parsed RPU presence, mapping/reshaping
and output signalling are separate facts. FFmpeg side data is not interchangeable
with Apple's opaque per-frame display attachments.

| Input | Base layer | Built-in libplacebo path to evaluate | Output claim |
| --- | --- | --- | --- |
| 8.1 | HDR10-compatible | parsed RPU + reshaping, if retained by decoder | HDR/EDR, not native DV signalling |
| 8.4 | HLG-compatible | same, verify FFmpeg/VT per-frame metadata | HDR/EDR, not native DV signalling |
| 5 | no HDR10-compatible fallback | RPU/nonlinear reshaping required for correct colors | unsupported until verified |
| 7 MEL | compatible HDR10 BL | possible RPU path where residual is disabled; no EL reconstruction | distinguish BL fallback from reshaping |
| 7 FEL | compatible HDR10 BL | residual/EL reconstruction is outside this path | BL fallback only; no FEL claim |

libplacebo's pinned Vulkan swapchain explicitly does not map
VK_COLOR_SPACE_DOLBYVISION_EXT. Built-in reshaping is not Dolby Vision link/output
signalling. Info must keep unavailable RPU evidence as unknown rather than false.

## 12. Public Apple AVFoundation / Dolby Vision

[Apple's Dolby Vision guide](https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf)
documents automatic Profile 8.4 rendering through AVPlayer+AVPlayerLayer and
AVSampleBufferDisplayLayer. The latter needs HDR-suitable >=10-bit buffers and
per-frame metadata; VTDecompressionSession's propagation option defaults true.
This guide originated with iOS capture; macOS support must also be checked against
the public SDK/device APIs, not extrapolated to every DV profile.
eligibleForHDRPlayback (macOS 10.15+) indicates device/display eligibility, not
actual current presentation. containsHDRVideo identifies HDR track content,
not Dolby Vision profile or verified output.

[AVSampleBufferDisplayLayer](https://developer.apple.com/documentation/avfoundation/avsamplebufferdisplaylayer)
publicly accepts compressed and uncompressed frames on macOS. An HEVC compressed
CMSampleBuffer needs VPS/SPS/PPS, length-prefixed samples, CMVideoFormatDescription,
correct times/decode order and container color/codec extensions. Preserve DV NAL
units and configuration during FFmpeg demux; an arbitrary HEVC Main10 format
description does not establish DV recognition. A decoded path must retain VT's
native per-frame HDR display metadata rather than reconstructing it from a guessed
dictionary. [TN3145](https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata)
also requires preserving ambient viewing environment where present.

[Apple HLS appendix](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices-appendixes)
signals 8.1 as a PQ-compatible HEVC base plus dvh1.08.xx/db1p supplemental codec;
8.4 uses HLG plus dvh1.08.xx/db4h. The HLS authoring specification covers Profile 5
as well. HLS signalling is not sufficient evidence that any raw MKV compressed
buffer is accepted as Dolby Vision by a display layer.

mpv's public client/Render API does not export compressed packets or decoded
CVPixelBuffers with Apple attachments to the application. Keeping mpv demux/audio
would require a new VO/packet handoff and A/V clock, seek flush, backpressure,
device-loss recovery and subtitle composition. FFmpeg preserves encoded payload
and can expose DV configuration/RPU, but public docs reviewed here do not provide
a general FFmpeg-RPU-to-Apple-attachment conversion contract. This path is
theoretically promising for 8.4; at current evidence it is effectively a second
presentation/player integration, not a small replacement for the existing VO.
Do not implement it in this stage.

AVPlayer is useful as a public native reference for supported MOV/MP4/HLS assets.
It is not a universal MKV/mpv replacement. SFTP requires a resource-loader bridge
or remuxing; native codec/container limits remain. Embedded ASS/fonts, external
subtitles, arbitrary audio codecs and mpv track semantics need new adapters or
renderers. Remuxing/segmenting for network seeks has latency and metadata risks.
No hybrid backend is justified before controlled native-reference comparisons.
No private APIs, FairPlay bypass or Apple TV internals were investigated.

## 13. Comparison

| Backend | Rendering owner | Existing player/streams/tracks | HDR/DV opportunity | Cost / main risk |
| --- | --- | --- | --- | --- |
| OpenGL Render API | Vesperwind presentation loop + mpv vo_gpu | retained | custom FP16 EDR; no current DV reshaping | established fallback, mandatory copy-back |
| gpu-next / embedded macvk | mpv/libplacebo/MoltenVK | retained | negotiated HDR/EDR, direct VT texture import, future built-in RPU | small downstream context + larger dependency closure |
| AVSampleBufferDisplayLayer | Apple layer + custom packet/frame pipeline | substantial integration needed | documented native 8.4 with preserved Apple metadata | timebase, subtitles, flush/backpressure, metadata handoff |
| AVPlayerLayer | AVPlayer | new adapters/native format limits | public automatic HDR/DV for eligible assets | MKV/SFTP/codec/subtitle mismatch |

## 14. Recommendation and implementation boundary

Implement the CAMetalLayer-pointer downstream context as an experimental owned
backend, default auto attempt with explicit macvk/opengl strict overrides, and
startup/VO-only fallback to the existing Render API. Preserve all common stream,
player command, Vue controls, z-order and fullscreen code. Keep requested options,
mpv actual VO/target and observed layer state separate in diagnostics. Do not
invent presented-frame counters for owned VO.

Affected areas: `src-tauri/src/mpv/{mod,presentation,player,surface*}.rs`, optional
native dependency features, `scripts/build-libmpv-macos.sh`, a pinned mpv patch,
GPU dependency build recipe, bundle verifier/manifest, and Info's shared formatter.
No alternative AVFoundation player is introduced. First stage keeps dovi disabled,
but records an optional built-in dovi build without adding libdovi.

Acceptance must record actual vo=gpu-next, Vulkan context and Metal surface, then
resize (including paused), play/pause/seek, fullscreen/controls, source switching,
shutdown and strict OpenGL fallback. Separate format matrix: H.264, HEVC 8-bit,
HEVC Main10 SDR, HDR10, HLG, DV 8.1, 8.4, 5; MEL/FEL are distinct future checks.
Compilation and synthetic policy tests do not prove visible video or HDR fidelity.


### Observed Vulkan SDR negotiation

The native probe confirmed a pinned libplacebo WSI selection detail: requesting
BT.709 + gamma2.2 selects an Adobe RGB nonlinear swapchain because matching the
transfer scores higher than matching primaries. With strict target hints mpv
correctly reports Adobe primaries, rather than pretending BT.709 was negotiated.
The embedded Metal policy therefore uses BT.709 + sRGB for SDR. The OpenGL and
Windows policies are unchanged. HDR requests still use PQ + BT.2020.


### Implementation and observed checks (2026-10-02)

Implemented the experimental host/context, auto/macvk/opengl runtime override,
startup fallback, native diagnostics, pinned source recipe and dylib verifier.
OpenGL surface implementation was moved intact to surface_opengl_macos.rs.
No Vue renderer selection or player command API changes are required.

The final source recipe built mpv/FFmpeg/libplacebo/MoltenVK/glslang and passed
closure, checksum, architecture, macOS 12 deployment and development signature
verification. The VO context was then rebuilt with a source-reconfiguration fix:
resize polling compares drawableSize with actual VO dimensions, because mpv
resets dwidth/dheight to source dimensions when a new decoder configures. Testing
only changes to a cached host size would miss this paused source-switch case.

Native public-client probe on Apple M4 passed all five generated, non-DRM clips:
H.264, HEVC 8-bit, HEVC Main10 SDR, HEVC Main10 PQ/BT.2020 and HEVC Main10
HLG/BT.2020. All reported hwdec-current=videotoolbox; Main10 reported p010 native
decoder surfaces. Each clip passed paused resize and play/pause/seek; all clips
were switched through the same player for three create/destroy cycles.
The probe waits for FILE_LOADED + VIDEO_RECONFIG, rather than mistaking the
previous source's vo-configured state for the new source's readiness.

Actual SDR negotiation is rgb10a2 / BT.709 / gamma2.2 on the sRGB Vulkan surface
(pinned libplacebo intentionally maps SRGB_NONLINEAR to its monitor gamma2.2).
PQ hints negotiated RGB10A2Unorm (Metal 90), kCGColorSpaceITUR_2100_PQ,
wantsExtendedDynamicRangeContent=true and EDRMetadata present. These are
observations of GPU/layer state, not colorimetric or Dolby Vision acceptance.
MoltenVK reports a primitive-restart capability warning during pipeline creation;
the smoke operations complete. Shader startup can exceed 300ms; the probe uses
bounded waits instead of assuming a warm shader cache.

Rust mpv checks and frontend regression tests passed. The existing Info panel was
visually inspected in headless Chrome with Metal, OpenGL fallback and unknown
state fixtures. Those fixtures validate layout, not real runtime GPU evidence.

Still pending: real Tauri native-video composition and controls z-order,
fullscreen transitions, real application automatic fallback, listening/audio,
SFTP application playback, physical HDR10/HLG color accuracy, moving between
SDR/HDR displays, hotplug, sleep/wake and brightness/headroom changes. Dolby Vision
8.1/8.4/5 and MEL/FEL media were not tested. No native system Dolby Vision output
is implemented or claimed. The experimental backend is not release accepted.


The retained OpenGL Render API also rendered a synthetic H.264 file with the new
bundle for three context/handle lifetimes: current-vo=libmpv,
hwdec-current=videotoolbox-copy, three rendered/swapped frames per cycle. This
checks library/render compatibility; application auto-fallback and the FP16 EDR
physical output remain separate acceptance checks.


The final probe also observed actual SDR layer colorspace kCGColorSpaceSRGB with
EDR disabled and current/potential headroom both 1.0 on the available screen.
Consequently, the PQ layer hint experiment does not prove usable display HDR
headroom. Active playback shutdown with the host hidden completed in all three
lifetimes. Application fullscreen/overlay behavior still requires its own check.
