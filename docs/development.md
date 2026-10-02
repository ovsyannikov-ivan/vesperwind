# Development and builds

## Requirements

- Node.js 22.13+ and npm; Node SEA packaging requires Node.js 25.5+.
- Native build tools for the Node `node-pty` and `ssh2` dependencies.
- Rust stable for the Tauri desktop application.
- macOS: Xcode Command Line Tools and the Apple Rust target.
- Windows: MSVC/C++ Build Tools, Windows SDK, WebView2, Python 3 and Strawberry
  Perl. Follow the [Windows setup and build guide](build-windows.md).

Normal Tauri builds use the vendored libmpv runtime. Rebuilding that runtime
requires an additional media toolchain, including Python 3 and CMake; see
[native libmpv integration](libmpv.md).

## Run locally

Install the dependency versions recorded in the lockfile:

```bash
npm ci
```

For the Rust-backed desktop app:

```bash
npm run dev:tauri
```

For browser/Node development:

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The Node backend listens on `127.0.0.1:3001`; Vite
proxies API and Socket.io traffic. Frontend changes use HMR. Restart the command
when changing backend source.

## Checks and builds

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run build:tauri
```

With the browser development server running, `npm run test:smoke` checks a live
filesystem request and a PTY round trip. Native changes also need testing in the
real Tauri app; automated checks do not establish platform or display acceptance.

On macOS, an application-only build avoids the DMG layout step that controls Finder:

```bash
npm run build:tauri -- --bundles app
```

The release application is `src-tauri/target/release/bundle/macos/Vesperwind.app`.
A full macOS bundle build also writes the installer under
`src-tauri/target/release/bundle/dmg`. An app-only build does not update an existing
DMG. Public macOS distribution requires Developer ID signing and notarization;
local development signatures do not replace them.

Windows verification and MSI/NSIS packaging:

```powershell
node scripts/verify-libmpv-bundle.js windows
npm run build:tauri -- --bundles msi,nsis
```

Use the default Cargo output tree for a native x64 build. The executable is
`src-tauri/target/release/vesperwind.exe`; installers are under `bundle/msi` and
`bundle/nsis`. See the [Windows guide](build-windows.md) for setup and troubleshooting.

Node SEA packaging is currently limited to macOS and requires Node.js 25.5+:

```bash
npm run build:sea
```

`npm run build:staging` prepares its staging directory, including the macOS PTY
assets. Generated outputs live in ignored `dist/`, `staging/` and
`src-tauri/target/` directories. Linux desktop/SEA packaging is not supported yet.

## Architecture

The Vue 3 frontend uses Vite and Bootstrap 5, with Monaco Editor, PDF.js, xterm.js
and media-chrome. It runs with a Node.js/Socket.io backend, a Node SEA executable,
or the Tauri v2/Rust backend.

A transport-neutral API keeps backend URLs, Socket.io calls and Tauri commands out
of Vue components. Files are addressed by provider and path; `LocalProvider` and
`SftpProvider` share this contract. Preserve that boundary when adding features.

## Filesystem and settings

Tauri and SEA filesystem access follows the current user's OS permissions. Panels
start in the home directory on macOS, at `/` on Linux, and at **This PC** on
Windows. Breadcrumbs allow access to other volumes; these navigation policies do
not establish Linux packaging support.

The browser/Node server confines local access to `FILE_MANAGER_ROOT`, defaulting
to the user's home directory. Override it for one run with:

```bash
FILE_MANAGER_ROOT=/path/to/root npm run dev
```

`VESPERWIND_SETTINGS_PATH` selects another Node settings file. Keep real connection
profiles and personal settings outside the repository.

## Security and contributions

The Node server has no built-in HTTP authentication and binds to loopback by
default. Keep it on loopback; use an SSH tunnel for remote browser access.
SSH host fingerprints are stored with profiles, while passwords and private-key
passphrases remain in memory for the current session.

Never commit private keys, passwords, tokens, certificates with private keys,
personal connection profiles or private documents. Use fictitious examples such
as `example.com`, port `2222` and username `demo`. If a credential leaks, revoke or
rotate it; a later deletion does not remove it from Git history. Report security
issues privately to the repository owner.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution checklist and
[AGENTS.md](../AGENTS.md) for UI conventions.
