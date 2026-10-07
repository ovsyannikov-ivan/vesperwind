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
| CMake 3.20+ | Building the pinned libarchive/zlib archive sidecar |

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
npm run build:archives
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
window, mpv-owned gpu-next/D3D11 with HDR10 PQ/BT.2020 policy and a WGL/OpenGL SDR fallback.
Real HDR-display validation remains not verified; see [libmpv output diagnostics](libmpv.md).
The Node SEA packaging path
is currently macOS-only; use Tauri for a Windows native build.

## Rebuilding the Windows libmpv runtime

The application remains an x86_64 MSVC build. Its dynamically loaded C-ABI media
libraries are built separately with MSYS2 UCRT64 GCC/MinGW. MSYS2 is a build-time
dependency only. Do not install a prebuilt mpv package or copy codec DLLs from PATH.

From the project root:

```powershell
npm ci
npm run build:libmpv
```

That is the whole procedure. The command prepares MSYS2 and its build tools,
builds the bundle into `src-tauri/vendor/libmpv/windows`, updates BUILD-INFO,
SHA256SUMS and the manifest, and verifies the result. If it stops, it prints one
message naming what it could not do itself (for example: no Rust toolchain, no
`winget` to install MSYS2, too little disk space); fix that and run the same
command again.

Optional flags: `npm run build:libmpv -- --clean` discards the build cache and
rebuilds everything; `-- --dry-run` prints the chosen MSYS2, cache and build mode.

### Advanced: what the command does

- **MSYS2.** It looks in `MSYS2_ROOT`, `C:\msys64`, Chocolatey's
  `C:\tools\msys64`, Scoop, `%LOCALAPPDATA%\msys64`, the folder of
  `msys2_shell.cmd` on PATH and the uninstall registry. Without MSYS2 it runs
  `winget install MSYS2.MSYS2` (Windows may ask for permission) and continues.
- **Build tools.** It compares the installed packages with the ones the build
  script needs (`make git diffutils curl tar` and UCRT64 `gcc cmake meson ninja
  pkgconf nasm python shaderc spirv-cross`) and installs only the missing ones
  with pacman after updating MSYS2. It then runs
  `scripts/libmpv-build/check-ucrt64.sh` in the UCRT64 environment and requires every
  tool and `gcc -dumpmachine` = `x86_64-w64-mingw32`.
- **HTTPS inspection.** MSYS2 uses its own CA bundle. When a corporate proxy or
  antivirus re-signs HTTPS, its mirrors fail with "self-signed certificate in
  certificate chain". The command detects this and adds the certificates
  Windows already trusts to MSYS2's trust anchors
  (`etc/pki/ca-trust/source/anchors/vesperwind-windows-trusted.crt`), never
  anything Windows itself does not trust.
- **Build cache.** `%LOCALAPPDATA%\Vesperwind\build\libmpv`, or
  `C:\vesperwind-build\libmpv` when that path is not short ASCII without spaces.
  `VESPERWIND_LIBMPV_BUILD_DIR` overrides it. Nothing heavy is stored in the
  repository.
- **Full or incremental.** If the cache holds a completed FFmpeg/FreeType/
  FriBidi/HarfBuzz/libass prefix built from the current source pins and the
  current GCC, with Schannel, HTTPS, HLS and D3D11VA, only libplacebo and mpv are
  rebuilt (configured from scratch, so changed Meson options such as `-Ddovi`
  always apply). Otherwise a full build runs: stages from other pins or another
  toolchain are discarded, an interrupted build of the same pins resumes, and
  verified source archives are kept.
- **Script.** UCRT64 is entered through its environment variables and PATH,
  running the internal `scripts/build-libmpv-windows.sh` as a file; no login
  shell or nested quoting is involved. Do not run that script directly.
- **CI.** With `CI`, `GITHUB_ACTIONS`, `TF_BUILD` or `--ci`, nothing is installed:
  a missing prerequisite fails with the same message.

`manifest.json` separates the build recipe (`buildRecipeLibplaceboOptions`) from
the checked-in artifact (`requiredLibplaceboOptions`, `doviProcessing`). While
they differ, `artifactPendingRebuild` is true and the verifier accepts the old
artifact as what it is. Packaging records libplacebo's resolved Meson options,
`pl_has_dovi`/`pl_has_libdovi`, the `PL_HAVE_LAV_DOLBY_VISION` check and the
installed toolchain packages in BUILD-INFO, rewrites the Windows manifest entry
from them (refusing a build that does not match the recipe), regenerates
SHA256SUMS and verifies the result. The verifier rejects a bundle whose recorded
shader toolchain packages differ from the manifest.
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

Windows defaults to mpv-owned `wid + gpu-next + D3D11`, starting with RGBA8 BT.709
and negotiating RGB10A2 PQ/BT.2020 for HDR10 sources on active HDR displays.
WGL Render API is retained as automatic startup fallback. For separate
application checks set `VESPERWIND_MPV_WINDOWS_BACKEND=d3d11` or `wgl`; `auto`
is the default. Strict `d3d11` mode must not silently pass via WGL. Check renderer
and fallback diagnostics as well as the mpv log when proving the selected path.
The executable embeds Windows 10/11 compatibility so mpv's VersionHelpers can
select the correct DXGI behavior.

With Windows HDR off, HDR input must display **SDR fallback**. With HDR on,
check actual mpv target PQ/BT.2020 and `rgb10a2`; requested options alone do not
prove negotiated output. DXGI metadata delivery and Philips/HDMI checks remain
**not verified**. SDR input must stay BT.709 on the HDR desktop.
D3D11VA availability at build time does
not prove hardware decode on a particular GPU; inspect **hwdec-current** in Info.
Owned D3D11 requests `auto-safe` and direct decoder surfaces; WGL requests
`auto-copy-safe`, both with software fallback.

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
