# Building Vesperwind on Windows

Windows Tauri builds need the following tools before `npm ci` and the native
build. Use the MSVC toolchain for the same architecture as your Node.js install.

| Requirement | Why it is needed |
| --- | --- |
| 64-bit Node.js 22.13+ and npm | Frontend build and native Node dependencies |
| Visual Studio Build Tools with **Desktop development with C++**, MSVC, and a Windows SDK | Tauri/Rust linking and native Node modules |
| Python 3 | `node-gyp` when installing native Node modules such as `node-pty` |
| Rust stable with `x86_64-pc-windows-msvc` | Tauri's Rust backend on 64-bit Windows |
| Microsoft Edge WebView2 Runtime | Tauri's Windows webview; it may already be installed |
| Strawberry Perl | Compiling vendored OpenSSL for the SSH/SFTP backend |

The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) explain the
C++ Build Tools, WebView2, and Rust setup. Follow the
[node-gyp Windows instructions](https://github.com/nodejs/node-gyp#on-windows)
for Python and the C++ workload.

## Rust target and Strawberry Perl

Install Rust with the MSVC host toolchain. On 64-bit Windows, verify or add its
target in PowerShell:

```powershell
rustup show active-toolchain
rustup target add x86_64-pc-windows-msvc
```

Vesperwind's `src-tauri/Cargo.toml` enables `ssh2`'s `vendored-openssl` feature.
The vendored OpenSSL build requires Perl. Install Strawberry Perl with:

```powershell
winget install -e --id StrawberryPerl.StrawberryPerl
```

Open a **new terminal** so its PATH includes Perl, then verify:

```powershell
perl -v
where.exe perl
```

If `where.exe perl` finds several copies, make sure Strawberry Perl is the one
used for the build. The [OpenSSL Rust crate's build notes](https://docs.rs/openssl/latest/openssl/#vendored)
describe the C compiler, Perl, and make requirements for vendored OpenSSL.

## Build

```powershell
npm ci
```

Then run `npm run dev:tauri` for development or `npm run build:tauri` for a
production native build.

Use the default build command on this Windows machine without an explicit
`--target` or `CARGO_BUILD_TARGET`. Installers are written to
`src-tauri/target/release/bundle/msi` and
`src-tauri/target/release/bundle/nsis`. An explicit target instead writes them
under `src-tauri/target/x86_64-pc-windows-msvc/release/bundle`; it does not update
installers left in the default directory.

Application source files are in `src-tauri/src` and the shared frontend in `src`;
`target` contains generated files, not a separate Windows source checkout. Keep
one default Cargo output tree: `target/debug` for development/tests and
`target/release` for optimized application builds and installers. Their caches
serve different profiles and are reused by subsequent builds. Local validation
reports and logs belong in the ignored `target/local-checks` directory.

Windows release executables use the GUI subsystem and open without a separate
console window. Debug builds keep the console for development diagnostics.

Windows uses the in-app toolbar and does not create Tauri's default native menu
bar. A Win32 menu remains visible when the window enters fullscreen; changing
its visibility afterward also changes the client height. Menu creation belongs
to application initialization, not video overlay updates, so images and videos
share the same fullscreen window behavior. Existing macOS and Linux menus are
preserved.

Both npm Tauri commands run `scripts/check-native-prereqs.mjs` first. On Windows,
it checks that `perl -v` succeeds and shows the Strawberry Perl installation
command before Cargo starts if Perl is missing. It does not verify the other
prerequisites or distinguish Strawberry Perl from another working Perl install.

If a build fails in `openssl-sys` after installing Strawberry Perl, restart the
terminal and confirm the `perl -v` and `where.exe perl` results before retrying.
If Tauri cannot start its webview, install or repair the
[WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

The Windows native surface uses the common libmpv player API with a Win32 child
window, mpv-owned gpu-next/D3D11 SDR and a WGL/OpenGL fallback. Advanced Color/DXGI
queries are diagnostics only; neither backend currently presents HDR. The Node SEA packaging path
is currently macOS-only; use Tauri for a Windows native build.

## Rebuilding the Windows libmpv runtime

The application remains an x86_64 MSVC build. Its dynamically loaded C-ABI media
libraries are built separately with MSYS2 UCRT64 GCC/MinGW. MSYS2 is a build-time
dependency only. Do not install a prebuilt mpv package or copy codec DLLs from PATH.

Install MSYS2 outside this repository, update it with `pacman -Syu` (restart the
shell and repeat after a core-runtime update), then install these build tools:

```sh
pacman -S --needed make git diffutils patch mingw-w64-ucrt-x86_64-gcc \
  mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-meson \
  mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf \
  mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-shaderc \
  mingw-w64-ucrt-x86_64-spirv-cross
```

From PowerShell at the project root:

```powershell
.\scripts\build-libmpv-windows.ps1 -MsysRoot C:\msys64 -BuildRoot C:\Temp\vesperwind-libmpv-windows
node scripts/verify-libmpv-bundle.js windows
```

Use a short ASCII build path outside the repository. The wrapper does not install
MSYS2 or change the machine PATH. Use a fresh BuildRoot when changing source pins,
toolchain or general build flags; completed stages are reused on an interrupted build.
For the same source/toolchain pins, `-PresentationOnly` explicitly reconfigures
mpv/libplacebo and reuses the completed codec/font prefix. It fails if that prefix
is absent. The shader toolchain package pins are recorded in `manifest.json`;
the verifier rejects a bundle built with different revisions.
The source archive hashes are in `scripts/libmpv-windows-sources.json`; libplacebo
and its submodules are verified by Git revisions. The macOS source patches are
not applied. `BUILD-INFO.txt` records the exact installed toolchain package set,
source revisions, configure/Meson flags and the FFmpeg H.264/HEVC D3D11VA probe.
This is a reproducible source procedure, not a claim of bit-identical output
across different compiler/package versions.

Packaging follows normal and delay-load PE imports recursively. Only libraries
built in the private prefix and explicitly permitted compiler/shader support DLLs can
be copied; other dependencies must belong to the Windows system allowlist.
`mpv.exe` is never built or packaged. The verifier checks x86_64 PE32+, closure,
build evidence, source pins, absence of local build paths, license/source-offer
files and checksums covering every file. It needs only Node.js, not MSYS2.

The production loader searches `vendor/libmpv/windows/mpv-2.dll` relative to the
EXE, as used by Tauri's Windows resource layout, as well as its existing bundle
locations. `LoadLibraryExW` resolves dependencies from the DLL directory and
System32, excluding PATH/current-directory fallbacks. The explicit development
override `VESPERWIND_LIBMPV_PATH` must identify the entry DLL.

## Playback validation

Windows defaults to mpv-owned `wid + gpu-next + D3D11` with an RGBA8 BT.709
swapchain. WGL Render API is retained as automatic startup fallback. For separate
application checks set `VESPERWIND_MPV_WINDOWS_BACKEND=d3d11` or `wgl`; `auto`
is the default. Strict `d3d11` mode must not silently pass via WGL. Check renderer
and fallback diagnostics as well as the mpv log when proving the selected path.
The executable embeds Windows 10/11 compatibility so mpv's VersionHelpers can
select the correct DXGI behavior.

The native surface is always SDR, including when Windows Advanced Color is on.
HDR input must display **SDR fallback**. D3D11VA availability at build time does
not prove hardware decode on a particular GPU; inspect **hwdec-current** in Info.
The requested policy is `auto-copy-safe`, with software fallback.

The existing ignored real-file API smoke test also runs on Windows:

```powershell
$env:VESPERWIND_MPV_SMOKE_FILE = 'C:\media\sample.mp4'
$env:VESPERWIND_MPV_EXPECT_AUDIO_OUTPUT = 'wasapi'
cargo test --manifest-path src-tauri/Cargo.toml bundled_libmpv_decodes_a_real_provider_stream -- --ignored --nocapture
```

This test uses `vo=null`: it checks decoding, the opaque provider stream, audio
state, pause/resume and forward/backward seek, not D3D11/WGL presentation. Set
`VESPERWIND_MPV_SMOKE_EOF=1` to check automatic rewind and replay, including mpv's
keep-open behavior. Set
`VESPERWIND_MPV_EXPECT_HWDEC=d3d11va-copy` only when testing known supported media
on a capable GPU. The actual D3D11/WGL overlay, subtitles, fullscreen, source switching,
close/reopen, audible audio and end-of-file behavior require the application smoke
pass. Repeat Local/SFTP playback in the installed application with a minimal PATH,
and confirm loaded DLL paths belong to its own bundle. Do not put credentials in
test URLs or logs.

Keep machine-specific validation reports and logs outside versioned documentation.
Do not include personal filenames, user-profile paths or credentials in reports
intended for publication. The ignored `src-tauri/target` directory can hold local
test results, organized under `src-tauri/target/local-checks`.
