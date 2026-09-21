# Vesperwind

Vesperwind is a cross-platform, desktop-first dual-pane file manager and remote
workspace. It keeps file management at the center, then adds the tools needed to
work with those files: SSH/SFTP, document tabs, terminals, PDF and media viewers,
and an editor.

> **Project status:** early alpha and under active development. Vesperwind is not
> production-ready, and there are no official GitHub Release installers yet.

## What it can do

- Manage local files in a Commander-style dual-pane interface.
- Connect to SSH/SFTP hosts, including hosts on custom ports, with persistent
  connection profiles, host-key verification, and keepalive handling. Passwords
  and private-key passphrases are kept in memory for the current session only.
- Browse SFTP files and transfer files and folders between local and remote
  panels. Copy, move, rename, delete, drag-and-drop, keyboard actions, and context
  menus share the same file-operation layer.
- Edit local and remote text files in a multi-tab Monaco workspace. The dark
  editor theme is a generated port of Visual Studio Code's official Dark 2026
  theme.
- Read PDFs with lazy page rendering, thumbnails, page navigation, zoom, text
  selection, and search. Remote PDFs use byte-range access instead of being
  downloaded into memory first.
- View local and remote images and play audio/video through the same
  provider-neutral content API.
- Use multiple tabs of real local PTY terminals and SSH terminals.

The browser and Node SEA modes use the HTML/media-chrome player. The Tauri macOS
build also contains an **experimental** native libmpv video backend with a custom
local/SFTP stream and a native OpenGL render surface. On macOS it has an
experimental FP16 Extended Dynamic Range path for HDR10 and HLG, with live EDR
headroom and fallback diagnostics. Dolby Vision metadata is reported, but full RPU
or enhancement-layer processing is not bundled. Its arm64 development bundle is
not yet a signed or notarized release, and the Windows libmpv bundle and DXGI HDR
renderer are not yet available. See [Native libmpv integration](docs/libmpv.md)
for the exact build, HDR matrix, and licensing status.

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

The local filesystem root defaults to the current user's home directory in the
Node runtime. To choose another root for one run:

```bash
FILE_MANAGER_ROOT=/path/to/root npm run dev
```

`VESPERWIND_SETTINGS_PATH` can point the Node runtime at a different settings file.
Do not place a settings file containing personal connection profiles in the
repository.

### Platform prerequisites

**macOS**

- Xcode Command Line Tools;
- Rust stable with the Apple target for Tauri;
- Node.js and npm;
- Python 3, CMake, Git, and the tools documented in
  [docs/libmpv.md](docs/libmpv.md) only when rebuilding the vendored libmpv
  runtime.

The current native media bundle is an arm64 development artifact. Distribution
still requires Developer ID signing and notarization.

**Windows**

- 64-bit Node.js and npm;
- Rust's MSVC toolchain;
- Visual Studio Build Tools with “Desktop development with C++” and a Windows SDK;
- the Microsoft Edge WebView2 runtime required by Tauri.

The main Tauri/file-management paths have been exercised on Windows, but the new
SSH/SFTP, document-search, and native libmpv work still needs a complete Windows
regression pass. Native libmpv DLL packaging is not complete.

**Linux**

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
- SSH/SFTP profiles, host-key verification, local/remote transfers, and SSH
  terminals;
- Monaco and PDF document tabs, remote editing, search, and provider-neutral
  ranged content access;
- image viewing, web audio/video playback, and multi-tab terminals.

### Experimental

- Tauri native libmpv playback on macOS, including local/SFTP custom streams,
  seeking, audio/subtitle track state, fullscreen geometry synchronization, and
  FP16 macOS EDR output for HDR10/HLG;
- self-contained arm64 macOS libmpv dependency bundle;
- large remote media and PDF behavior across varied SSH servers.

### Planned

- Native OS “Open With” integration;
- Finder/Explorer drag-and-drop integration;
- Windows libmpv rendering and self-contained DLL packaging;
- a Windows DXGI FP16/Advanced Color libmpv presentation backend;
- VideoToolbox/D3D11VA hardware decoding and further HDR/color-management work;
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
