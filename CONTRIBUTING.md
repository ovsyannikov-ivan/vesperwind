# Contributing to Vesperwind

Bug reports, fixes, documentation and focused improvements are welcome.

## Get started

Use Node.js 22.13+ and Rust stable. Platform prerequisites and alternative runtime
modes are covered in the [development guide](docs/development.md).

```bash
npm ci
npm run dev:tauri
```

`npm ci` installs the dependency versions recorded in the lockfile. Use
`npm run dev` for browser development.

## Before submitting

```bash
npm test
npm run build
```

For native or packaging changes, also run `npm run build:tauri` and check the real
Tauri app on the affected platform. State any checks you could not run.

- Keep changes focused and describe the result and how you checked it.
- Follow [AGENTS.md](AGENTS.md) and preserve the provider/transport API boundary.
- Include reproduction steps and platform details in bug reports. Sanitize logs
  and screenshots; never commit credentials, personal settings or private files.

If credentials are exposed, revoke or rotate them and contact the repository
owner. Report vulnerabilities privately to the owner.
