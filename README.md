# Vesperwind

Vesperwind is a cross-platform, desktop-first dual-pane file manager and remote
workspace. It keeps file management at the center, then adds the tools needed to
work with those files: SSH/SFTP, document tabs, terminals, PDF and media viewers,
and an editor.

> **Project status:** early alpha and under active development. Vesperwind is not
> production-ready, and there are no official GitHub Release installers yet.

## What it can do

- Manage local files in a Commander-style dual-pane interface.
- Filter and sort each file panel independently, and search names and paths
  recursively across local or SFTP folders. Search streams results in batches
  and can be cancelled without losing the current tree view.
- Connect to SSH/SFTP hosts, including hosts on custom ports, with persistent
  connection profiles, host-key verification, and keepalive handling. Passwords
  and private-key passphrases are kept in memory for the current session only.
- Browse SFTP files and transfer files and folders between local and remote
  panels. Copy, move, rename, delete, drag-and-drop, keyboard actions, and context
  menus share the same file-operation layer.
- Edit local and remote text files in a multi-tab Monaco workspace. The dark
  editor theme is a generated port of Visual Studio Code's official Dark 2026
  theme. The workspace has a file tree, minimap, cursor status, and per-tab
  indentation controls.
- Edit DOCX documents and XLSX/XLS spreadsheets in document tabs. DOC and RTF
  files can be imported into a new DOCX document.
- Read PDFs with lazy page rendering, thumbnails, page navigation, zoom, text
  selection, and search. Remote PDFs use byte-range access instead of being
  downloaded into memory first.
- View local and remote images and play audio/video through the same
  provider-neutral content API.
- Use multiple tabs of real local PTY terminals and SSH terminals.

The browser and Node SEA modes use the HTML/media-chrome player. Tauri contains an
**experimental** native libmpv video backend with a custom local/SFTP stream and
native OpenGL on macOS and D3D11/WGL surfaces on Windows. On macOS it has an
experimental FP16 Extended Dynamic Range path for HDR10 and HLG, with live EDR
headroom and fallback diagnostics. Dolby Vision metadata is reported, but full RPU
or enhancement-layer processing is not bundled. Its arm64 development bundle is
not yet a signed or notarized release. Windows includes a source-built x64 LGPL
DLL closure, WASAPI audio and direct D3D11VA hardware surfaces, with an mpv-owned
gpu-next/D3D11 HDR10-capable surface and an automatic WGL SDR fallback.
The Windows runtime is built and bundled, rather than a planned build;
native playback and MSI/NSIS packaging have passed local smoke checks. Windows
HDR10 PQ/BT.2020 output policy and negotiated-target diagnostics are implemented;
real HDR-display validation remains **not verified**. See [Native libmpv integration](docs/libmpv.md)
for the exact build, HDR matrix, and licensing status.

### HDR and Dolby Vision

| Capability | Windows | macOS |
| --- | --- | --- |
| HDR10 source playback | PQ/BT.2020 RGB10A2 presentation through libplacebo when Windows HDR is active; SDR fallback otherwise. Real HDR-display validation: **not verified** | Experimental FP16 EDR output, with SDR fallback; XDR display validation remains pending |
| HLG source playback | SDR tone mapping; native HLG output is a separate future stage | Experimental FP16 EDR output; XDR display validation remains pending |
| Dolby Vision | Profile metadata is detected; compatible base-layer playback may work, but Dolby Vision RPU processing and display output are not supported | The same Dolby Vision limitations apply; compatible HDR base layers may use EDR |

Playing a HEVC Dolby Vision Profile 8 file successfully does not establish Dolby
Vision or HDR output. Profile 8.1 has an HDR10-compatible base layer and Profile
8.4 has an HLG-compatible base layer; the compatible picture can be displayed
without processing Dolby Vision metadata. The bundled libplacebo builds disable
`dovi` and `libdovi`. See Dolby's [profile compatibility reference](https://ott.dolby.com/browser_test_kit/help_files/topics/r_resources.html).

Windows HDR10 requires HDR to be active on the monitor containing the player.
HDR capability, the Windows setting, and verified player output are reported
separately. SDR video stays BT.709 even on an HDR desktop; WGL stays SDR.
Info gives compact source, decode, processing, presentation, and output summaries;
the runtime diagnostic snapshot retains detailed evidence and metadata. Requested
settings alone do not prove HDR: the actual `video-target-params` must report
PQ, BT.2020 and `rgb10a2`. DXGI color-space mapping is labelled **Expected**;
HDR metadata delivery and physical HDMI output require external verification.
There is no Windows FP16 scRGB or Dolby Vision processing in this stage.

## Screenshots

A sanitized screenshot set will be added before the first public presentation.
The planned set covers the dual-pane local/SFTP view, Monaco Document Workspace,
PDF viewer, multi-tab terminal, and the native player once its manual smoke test is
complete. No placeholder or fabricated UI images are included.

## Architecture

Vesperwind has one Vue 3 frontend built with Vite and Bootstrap 5. Monaco Editor,
PDF.js, xterm.js, and media-chrome provide the editor, document, terminal, and web
media foundations.

The frontend talks to a transport-neutral API. It can use either the Node.js /
Socket.io backend or the Tauri v2 / Rust backend without putting backend URLs,
Socket.io calls, or Tauri commands in Vue components. Files are addressed as a
provider plus a path; `LocalProvider` and `SftpProvider` use that same contract.

The shared frontend runs in three modes:

- **Browser + Node backend** for development and local browser use;
- **Node SEA standalone** for a single-executable Node distribution;
- **Tauri desktop** for the native Rust-backed application.

These are runtime choices for the same application, not three separate products.

## Development

### Requirements

- Node.js 22.13 or newer and npm. The SEA build specifically requires Node.js
  25.5 or newer.
- Native build tools for `node-pty` and `ssh2` dependencies.
- Rust stable when running or building Tauri.

Install the exact dependency tree and run the browser/Node development mode:

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The backend listens on `127.0.0.1:3001`, and Vite
proxies the API and Socket.io traffic. Backend source changes require restarting
the command; frontend changes use Vite HMR.

Run the Tauri development app:

```bash
npm run dev:tauri
```

Run automated checks and frontend production builds:

```bash
npm test
npm run build
```

With the browser development server already running, `npm run test:smoke` checks
a live filesystem request and a PTY round trip.

### Build commands

```bash
npm run build          # Vite frontend
npm run build:tauri    # Tauri application and platform bundle
npm run build:sea      # Node SEA standalone (Node >= 25.5; currently macOS)
```

On macOS, `npm run build:tauri -- --bundles app` builds only the `.app`; this is
useful in a non-interactive or locked session where Tauri's DMG layout step cannot
control Finder.

`npm run build:staging` creates the SEA staging directory and is currently limited
to macOS because it packages the macOS `node-pty` assets. Build output is written
to ignored `dist/`, `staging/`, and `src-tauri/target/` directories.

Desktop filesystem access follows the current user's OS permissions and is not
confined to the starting folder. Tauri and standalone SEA start both panels in
the home directory on macOS, at `/` on Linux, and at **This PC** on Windows
with the available drive letters, including removable drives. Breadcrumbs allow
navigation to the OS root and other volumes. Linux SEA packaging is still a future
target; its runtime navigation policy is already defined.

The browser/Node server remains confined to `FILE_MANAGER_ROOT`, which defaults
to the current user's home directory. To choose another browser root for one run:

```bash
FILE_MANAGER_ROOT=/path/to/root npm run dev
```

`VESPERWIND_SETTINGS_PATH` can point the Node runtime at a different settings file.
Do not place a settings file containing personal connection profiles in the
repository.

### macOS prerequisites

- Xcode Command Line Tools;
- Rust stable with the Apple target for Tauri;
- Node.js and npm;
- Python 3, CMake, Git, and the tools documented in
  [docs/libmpv.md](docs/libmpv.md) only when rebuilding the vendored libmpv
  runtime.

The current native media bundle is an arm64 development artifact. Distribution
still requires Developer ID signing and notarization.

### Windows prerequisites

- 64-bit Node.js and npm;
- Visual Studio Build Tools / MSVC with “Desktop development with C++” and a
  Windows SDK;
- Rust stable with the MSVC target;
- Microsoft Edge WebView2 Runtime;
- Python 3 for native Node dependencies;
- Strawberry Perl for vendored OpenSSL.

Vesperwind enables `vendored-openssl` for its Rust SSH/SFTP backend. Without Perl,
the native build can fail while compiling `openssl-sys`. Install Strawberry Perl
with:

```powershell
winget install -e --id StrawberryPerl.StrawberryPerl
```

Restart the terminal, then check `perl -v` and `where.exe perl`. The
`npm run dev:tauri` and `npm run build:tauri` commands check for Perl before
starting Tauri on Windows. See [Windows build prerequisites](docs/build-windows.md)
for the full setup and troubleshooting steps.

The source-built x64 libmpv runtime and its complete DLL dependency set are
checked in under `src-tauri/vendor/libmpv/windows`, together with checksums,
licenses, source pins, and build evidence. Normal application builds use that
bundle; MSYS2 is needed only when rebuilding libmpv itself.

Build and verify the Windows application with:

```powershell
node scripts/verify-libmpv-bundle.js windows
npm run build:tauri -- --bundles msi,nsis
```

Use the default Cargo output tree: the application is
`src-tauri/target/release/vesperwind.exe`, and installers are under
`src-tauri/target/release/bundle/msi` and `bundle/nsis`. An explicit `--target`
creates a separate build tree and is unnecessary for this native x64 build.

Local checks covered H.264/HEVC decoding, direct D3D11VA surfaces for the owned
backend and copy-back for WGL, WASAPI initialization,
D3D11/gpu-next SDR and WGL playback, ASS subtitles, fullscreen round trips, and EOF rewind followed by
Play. Release builds use the Windows GUI subsystem and create no console window.
Media commands wait on worker threads so pause, resize, and close do not block
the window message pump. Resize requests coalesce, and the controls overlay uses
physical pixels to handle independent WebView zoom. The Windows SDR backend uses
bilinear downscaling and source metadata for tone mapping, avoiding per-frame
peak analysis to reduce 4K GPU load on integrated graphics.
Windows uses the frontend controls without a native application menu, including
image and video fullscreen. The shared Windows/macOS video transition hides the
native surface under a fading black overlay during resize, then holds the opaque
cover for a fixed 500 ms before fading back in. It does not wait for a video frame.
Repeated transitions were checked on Windows; the updated timing still needs a
visual check on macOS. Audible listening and HDR-display validation remain
separate manual checks.

The main Tauri/file-management paths have been exercised on Windows, but
SSH/SFTP, recursive search, and document editing still need a complete Windows
regression pass. The pinned native libmpv DLL runtime is bundled; see
[Windows build and media checks](docs/build-windows.md) for verification steps.

### Linux status

The browser/Node architecture is portable, but Linux is not currently a supported
or release-tested target. There is no Linux Tauri/libmpv package at this stage.

## Security notes

The Node server has no built-in HTTP authentication. It binds to `127.0.0.1` by
default; do not expose it directly to the Internet or an untrusted LAN. If remote
browser access is needed, keep Vesperwind on loopback and use an SSH tunnel.

SSH host fingerprints are stored with connection profiles. Passwords and key
passphrases are not saved. As an early-alpha application, Vesperwind should still
be used only with data and hosts for which you have an independent backup and an
appropriate security boundary.

Please report vulnerabilities privately to the repository owner until a dedicated
security contact and policy are published.

## Roadmap

### Implemented

- Dual-pane local file management and reusable file actions;
- Independent per-panel name/extension filters, folder-first sorting, and local
  filesystem watching;
- Cancellable, batched recursive name/path search for local and SFTP providers,
  in both file panels and the collapsible Editor sidebar;
- SSH/SFTP profiles, host-key verification, local/remote transfers, and SSH
  terminals;
- Monaco text tabs with the Dark 2026 theme, minimap, cursor/indentation status,
  and per-tab tab settings;
- PDF, DOCX, and XLSX/XLS document tabs, DOC/RTF import, remote text editing,
  document search, and provider-neutral ranged content access;
- Native local-file Open With and reveal actions on macOS and Windows;
- Image viewing, web audio/video playback, and multi-tab terminals;
- source-built, pinned Windows x64 libmpv runtime with dependency verification,
  licenses, and local MSI/NSIS packaging.

### Experimental

- Tauri native libmpv playback on macOS and Windows, including local/SFTP custom streams,
  seeking, audio/subtitle track state, fullscreen geometry synchronization, and
  FP16 macOS EDR output for HDR10/HLG;
- self-contained arm64 macOS libmpv dependency bundle;
- Windows H.264/HEVC D3D11VA copy-back
  decoding for WGL and direct D3D11VA surfaces for owned output, WASAPI audio and
  mpv-owned `wid + gpu-next + D3D11` rendering with HDR10 PQ/BT.2020 policy,
  with the existing WGL renderer as an automatic startup fallback;
- shared Windows/macOS native fullscreen fade through a controls overlay, with
  a fixed 500 ms hold after resizing before uncovering video;
- large remote media and PDF behavior across varied SSH servers.

### Planned

- Finder/Explorer drag-and-drop integration;
- Content search inside files and additional editor encodings;
- A complete Windows regression pass for SSH/SFTP, search, and document editing;
- Manual Windows HDR10 validation on an HDR display, then separate HLG and
  reviewed FP16 scRGB stages with correct Windows white scaling;
- Dolby Vision reshaping with `dovi` first (Profile 8, then Profile 5), and `libdovi`
  only if its additional metadata provides a practical benefit;
- further hardware-decoder coverage and HDR/color-management work;
- enhanced remote media recovery and buffering behavior;
- external-editor synchronization;
- additional filesystem providers.

## Contributing

Small, focused changes are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development checks and security expectations.

## License

Vesperwind's own source code is licensed under the [MIT License](LICENSE):
Copyright (c) 2026 Ivan Ovsyannikov.

Third-party components retain their own licenses. In particular, the bundled
libmpv/FFmpeg runtime is not relicensed under MIT; its exact LGPL-compatible build
configuration, notices, and source-provision information are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[docs/libmpv.md](docs/libmpv.md).
