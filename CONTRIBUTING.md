# Contributing to Vesperwind

Vesperwind is an early-alpha project. Focused bug fixes, tests, documentation, and
small feature improvements are welcome.

## Set up the project

Use Node.js 22.13 or newer. Tauri work also requires Rust stable and the platform
prerequisites listed in the README.

```bash
npm ci
npm run dev
```

Before submitting a change, run:

```bash
npm test
npm run build
```

Run `npm run build:tauri` as well when changing Rust, Tauri capabilities, native
packaging, or desktop-only behavior. If a GUI or platform-specific check cannot be
run, state that clearly in the contribution.

## Proposing changes

- Keep pull requests small enough to review and describe the user-visible result.
- Add or update tests for behavior that can be exercised automatically.
- Preserve the provider/transport boundary: Vue components should not depend
  directly on Socket.io, Tauri commands, backend URLs, or SSH credentials.
- Follow the compact Bootstrap modal conventions in `AGENTS.md`.
- Include reproduction steps, platform, runtime mode, and relevant logs in bug
  reports. Remove usernames, hostnames, paths, document contents, and credentials
  before posting logs or screenshots.

## Never commit credentials

Do not commit `.env` files, private keys, passwords, passphrases, API tokens,
certificates with private keys, real connection profiles, personal settings files,
or private documents. Use obviously fictitious examples such as `example.com`,
port `2222`, and username `demo`.

If a credential is committed accidentally, revoke or rotate it immediately and
contact the repository owner. Removing it in a later commit does not remove it from
Git history.
