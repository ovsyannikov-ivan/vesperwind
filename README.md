# Vesperwind

Vesperwind is a desktop-first, two-panel browser file manager for a local machine. The
first prototype focuses on filesystem navigation and a real PTY-backed terminal.

## Run

Requirements: macOS, Node.js 22.13 or newer, and the native build tools required by
`node-pty` (normally provided by Xcode Command Line Tools).

The project postinstall step also restores the executable bit on the packaged
`node-pty` macOS spawn helper when required.

PTY sessions keep the user's shell environment but remove npm prefix variables
that conflict with NVM, so launching Vesperwind through `npm run dev` does not add
an `npm_config_prefix` warning to the terminal.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies Socket.io and WebSocket traffic to the
backend on `127.0.0.1:3001`.

The development runner keeps Vite and the backend in one foreground process group,
checks both ports before startup, and stops the complete group together. Backend
source changes require restarting `npm run dev`; frontend changes still use Vite HMR.

The filesystem root defaults to the current user's home directory. Override it for
a single run:

```bash
FILE_MANAGER_ROOT=/ npm run dev
```

The standalone executable accepts the same runtime configuration directly:

```bash
./vesperwind --root /Users/ivan -p 3101
./vesperwind -r /Users/ivan --port 3101 --host 127.0.0.1
```

Use `-h`/`--help` for the complete option list and `-v`/`--version` for the
Vesperwind version. CLI arguments take priority over `FILE_MANAGER_ROOT`, `PORT`,
and `HOST`; environment variables take priority over the built-in defaults.

## Security

Vesperwind does not provide built-in authentication.

By default, the server listens on `127.0.0.1` and is accessible only from the
local machine. This is the recommended mode. Do not expose Vesperwind directly
to the Internet or an untrusted LAN with `--host 0.0.0.0`.

For remote access, use an SSH tunnel:

```bash
ssh -L 3101:127.0.0.1:3101 user@server
```

Then open [http://127.0.0.1:3101](http://127.0.0.1:3101).

Vesperwind must remain bound to `127.0.0.1` on the remote machine. The SSH
tunnel does not require `--host 0.0.0.0`.

When Vesperwind is intentionally started with a host other than `127.0.0.1`,
`localhost`, or `::1`, it prints a warning that the unauthenticated server is
listening on a non-loopback interface. The warning does not block startup.

The backend resolves and validates every requested directory against this root.
Directory contents are loaded lazily and cached inside the corresponding tree node.
Files and folders can be dragged onto a folder in either panel. The drop menu offers
move, copy, and relative symbolic-link operations; the backend rejects paths outside
the configured root, name collisions, and recursive folder operations.

The toolbar and keyboard provide Commander-style operations for the selected item:
`F5` copies to the directory open in the opposite panel, `F6` moves there, and `F8`
deletes. Every command requires confirmation in a Bootstrap modal; deleting a folder
is recursive and displays an explicit irreversible-action warning.

Double-clicking a browser-compatible audio file opens a persistent player above the
panels. Double-clicking an image or an MP4, M4V, MOV, WebM, or OGV video opens a
Bootstrap media modal with fullscreen support. Image and video viewers build a
carousel from matching files in the same loaded directory and support mouse controls
plus the left and right arrow keys. Media is streamed from a guarded `/api/media`
endpoint with byte-range support for seeking. Formats such as MKV still receive a
video icon but are not offered to the browser player.

Double-clicking a configured text or code file opens the tabbed Monaco Editor
Workspace. Its compact lazy tree inherits the current directory and source side of
the panel that opened the file. Tabs retain that context independently, support
syntax highlighting, per-tab undo/redo history, explicit Save and Revert controls,
and `Cmd+S`/`Ctrl+S`. Unsaved changes are protected when closing a tab or leaving
the browser page. PDF files open in the same workspace as document tabs, rendered
locally with PDF.js. The viewer provides continuous vertical scrolling, a collapsible
thumbnail sidebar, page navigation, zoom, Fit Width, Fit Page, and fullscreen controls.
Each PDF tab retains its own current page, zoom mode, scroll position, and thumbnail
sidebar state. Pages and thumbnails are rendered lazily, and distant canvas buffers are
released to keep large documents from consuming memory unnecessarily.
The Files and Editor toolbar buttons switch workspaces without unmounting either
file panel or the PTY terminal.

The web client includes a manifest, favicon, Apple touch icon, install icons, and a
minimal service worker so it can be installed as a standalone PWA from a secure
context such as `127.0.0.1`. The service worker deliberately does not cache the app
shell: Vesperwind still requires its local backend and should always load the current
frontend assets.

`VESPERWIND_SETTINGS_PATH` optionally overrides the user settings file location. On
macOS it defaults to `~/Library/Application Support/Vesperwind/settings.json`.

Default settings and their versioned schema live in `shared/defaultSettings.js`,
so they can be bundled into a future standalone executable. Mutable user settings
intentionally remain outside `dist/assets`: bundled assets are read-only and may be
replaced during application updates.

The appearance setting supports Bootstrap's `system`, `dark`, and `light` color
modes. System mode follows the current macOS appearance automatically. Settings
also contain the normalized, case-insensitive editable-file rules used to decide
which files open in Monaco; extensions and exact names such as `.env` or
`Dockerfile` are supported.

## Structure

- `server/filesystem.js` — safe directory reads, sorting, and filesystem errors.
- `server/fileOperations.js` — validated copy, move, and symbolic-link operations.
- `server/media.js` — root-validated media and PDF streaming with byte ranges.
- `server/terminal.js` — lifecycle and Socket.io bridge for `node-pty`.
- `server/settings.js` — versioned JSON settings storage and Socket.io handlers.
- `server/textFiles.js` — root-validated UTF-8 reads and writes for editor tabs.
- `server/index.js` — local HTTP and Socket.io server.
- `src/components` — file manager, recursive trees, Monaco/PDF workspace, terminal, toolbar, splitters.
- `src/composables` — filesystem operations, settings, terminal, and persistent layout state.
- `public` — favicon, PWA manifest, service worker, and application icon assets.
- `shared/defaultSettings.js` — defaults and normalization shared by browser and backend.

## Checks

```bash
npm test
npm run build
```

With the dev server running, this verifies a live directory request and an
interactive PTY round trip:

```bash
npm run test:smoke
```

## Standalone staging and SEA

Create a self-contained staging directory with the frontend, bundled backend, and
the native PTY assets:

```bash
npm run build:staging
```

The result is written to `staging/` and can run without the project `node_modules`.
With Node.js 25.5 or newer, build and ad-hoc-sign the macOS Single Executable
Application:

```bash
npm run build:sea
```

The executable is written to `staging/vesperwind`.
