# Pelorus

Pelorus is a desktop-first, two-panel browser file manager for a local machine. The
first prototype focuses on filesystem navigation and a real PTY-backed terminal.

## Run

Requirements: macOS, Node.js 20.19 or newer, and the native build tools required by
`node-pty` (normally provided by Xcode Command Line Tools).

The project postinstall step also restores the executable bit on the packaged
`node-pty` macOS spawn helper when required.

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

The backend resolves and validates every requested directory against this root.
Directory contents are loaded lazily and cached inside the corresponding tree node.

## Structure

- `server/filesystem.js` — safe directory reads, sorting, and filesystem errors.
- `server/terminal.js` — lifecycle and Socket.io bridge for `node-pty`.
- `server/index.js` — local HTTP and Socket.io server.
- `src/components` — file manager, panels, recursive tree, terminal, toolbar, splitters.
- `src/composables` — filesystem, terminal, and persistent layout state.

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
