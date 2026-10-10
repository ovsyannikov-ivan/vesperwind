# Remote Connections and macOS access setup — acceptance, 2026-10-09

The initial acceptance used main `3a591b8c` with the Remote Connections changes.
Windows verification used an
independent temporary copy on POL-535; its primary checkout was not modified.

## Architecture and behavior

1. **CredentialStore:** a native trait-based store shared across protocols. Keys
   combine service `com.vesperwind.credentials`, protocol, stable profile ID and
   credential kind. Tests use an in-memory backend; production never falls back
   to that backend or a plaintext file.
2. **macOS:** `apple-native-keyring-store` 1.0.2 uses Keychain.
3. **Windows:** `windows-native-keyring-store` 1.1.0 uses Credential Manager with
   local persistence. SSH enables vendored OpenSSL and `openssl-on-win32` for
   Ed25519 support; the initial WinCNG build failed the controlled handshake.
4. **Linux:** the backend interface is ready for a future Secret Service adapter;
   secure persistence is currently unavailable. No silent plaintext fallback.
5. **Settings:** version 8 retains profile ID/name/protocol/address/user, auth mode,
   key path, initial path, trust fingerprint, config alias and save flags. It also
   records permission-wizard completion, independently of actual OS grants.
6. **Secret boundary:** settings normalization strips secret fields. No API returns
   saved secret values to Vue; credential status is boolean-only. Typed inputs
   cross IPC for authentication, then clear on success, selection/close/unmount.
7. **Lifecycle:** successful trusted connections save checked typed credentials.
   Rename preserves them; Forget/removal/endpoint/user/auth/key/save-flag changes
   clean the affected entries and invalidate the SFTP session. Store errors are
   explicit, and a failed save retains a transient secret for session reconnect.
   Settings update/reset restore affected secrets if cleanup or JSON writing
   fails; session invalidation follows a successful update. A restoration error
   is explicit. Filesystem/credential-store crash atomicity is not claimed.
8. **Auto:** Agent → eligible config/explicit/default key files → saved password →
   supplied password. Existing explicit Password/Private key methods stay explicit;
   new profiles default to Auto. Explicit Agent has no password/key fallback.
9. **Agent:** production uses libssh2 APIs, never `ssh.exe`/`ssh-add` subprocesses.
   macOS uses the socket; Windows uses the OpenSSH service named pipe.
10. **Identity iteration:** unavailable/unsuitable identities do not stop Auto;
    every eligible identity can be tried, including a valid later key.
11. **Default keys:** `id_ed25519`, `id_ecdsa`, `id_rsa`; paths are deduplicated.
    IdentitiesOnly removes default discovery and filters agent keys to configured
    public keys while preserving direct configured private-key attempts.
12. **Passphrases:** separate typed and saved key-passphrase values are supplied
    only when a key needs one. Owned native strings and helper-input buffers are
    zeroizing. Unsupported multi-prompt/MFA interactions never receive a password.
13. **Reconnect:** re-resolves config and reuses the shared authenticator with
    current saved credentials or its transient session values.
14. **Terminal:** independent terminal sessions use that same resolver,
    host-key verification and authentication semantics.
15. **Operation helper:** the parent obtains checked credentials in native memory
    and passes its resolved profile/secrets via the existing private stdin pipe.
    No secret arguments, environment variables, files or worker logs are added.
16. **SSH config:** a mature `ssh2-config` 0.8.1 parser reads `~/.ssh/config`
    without changing it. A documented vendored patch preserves first singleton
    values, handles absolute Windows Include paths and bounds Include recursion.
17. **Directives:** Host, HostName, User, Port, IdentityFile, IdentitiesOnly and
    the supported Include behavior; IdentityFile expands `~/`, `%d/%h/%r/%p/%%`.
18. **Wildcards:** contribute effective settings to concrete aliases, but do not
    create synthetic entries in the modal. Re-import preserves a saved profile ID.
19. **Unsupported directives:** ProxyJump/ProxyCommand and external command/provider
    requirements produce explicit errors; the app does not execute them.
20. **Host security:** unknown/changed fingerprints are checked before any auth
    attempt, including in helpers. Config endpoint changes invalidate old trust.

## Initial verification and limitations

21. **Automated checks:** macOS `npm test`: 520 passed; `cargo test`: 178 passed,
    8 ignored. `npm run build`, native debug/app builds, `cargo fmt --check` and
    `git diff --check` passed. New-file whitespace was checked separately. The
    existing Vite large-chunk notice remains; Rust compilation adds no warnings.
22. **Real macOS acceptance:** synthetic loopback SSH server plus isolated agent
    verified trusted save, fresh-process password/passphrase reuse, multiple agent
    identities, config IdentityFile/IdentitiesOnly, terminal, reconnect and real
    private-pipe copy. Production Forget and settings-update commands exercised
    rename, profile deletion, both save toggles, endpoint/user/auth/key changes.
    Server traces showed zero auth attempts for unknown/changed hosts. Synthetic
    Keychain entries were removed and absence was verified.
23. **Real Windows acceptance:** POL-535 verified Credential Manager across process
    restarts, the same lifecycle/terminal/helper cases, and Agent both with an
    unset SSH_AUTH_SOCK and an explicit named pipe. Original agent identities
    were restored after removing only synthetic keys. Rust: 168 passed, 6 ignored;
    npm: 517 passed, 3 skipped, no failures. Frontend/native builds, fmt/diff checks
    passed. Actual UI confirmed auth-mode fields/config import and absence of
    the macOS wizard. A broken-link test now uses an unprivileged NTFS junction.
24. **Remaining limits:** FTP/FTPS and Linux persistence are not implemented.
    Match, other IdentityFile/environment tokens, multi-pattern Include and custom
    IdentityAgent are not supported. Hardware/security-key providers and general
    MFA interaction are outside this implementation. OS-specific skipped/ignored
    tests are not claimed as passed; older macOS hardware was not available.

## macOS first-launch wizard

The wizard gates file panels until Finish/Set up later, asks separately for
Desktop/Documents/local-network access and can be reopened from Settings →
General without remounting the editor. Permission preparation precedes normal IO
deadlines; pending requests are cancellable, and late responses are ignored.
If storing completion fails, Retry saving and Continue without saving are
available. Continuing opens the panels for this session without persisting
completion; macOS grants are unaffected.

A fresh bundled QA app launched via Launch Services demonstrated actual Desktop
and Documents system-request waits followed by available access, without the
former generic timeout. The local-network step reported available access.
Finish persisted completion; a real restart loaded panels without the wizard.
Windows did not show the wizard or its Settings entry.

Network.framework is weak-linked and used for privilege preparation only on
macOS 15+. macOS cannot generally distinguish an unanswered local-network prompt
from a remembered denial: the UI offers explicit waiting plus Cancel/Skip and
System Settings guidance. See [macOS access setup](macos-permissions.md) and
[authentication details](remote-authentication.md) for the contracts and limits.

## Failure-recovery regression checks

The follow-up fixes were verified on macOS with `npm test` (522 passed),
`cargo test` (181 passed, 8 ignored), frontend/native app builds,
`cargo fmt --check` and `git diff --check`. The Windows results above describe
the initial acceptance snapshot; this follow-up was not rerun on Windows.

Regression tests cover retrying and continuing after a failed wizard save,
without recording completion or remounting an existing editor. Rust tests force
a real filesystem write failure for both settings update and reset, then verify
the previous JSON and both saved secrets. They also cover backup-read failure,
partial credential deletion and explicit reporting of failed restoration.

An isolated Tauri QA app demonstrated the warning and Continue without saving
after a real write failure. Both file panels opened and the stored completion
flag remained false. A fresh native Keychain/SSH acceptance run passed the
profile lifecycle, reconnect, terminal and private-pipe transfer cases; synthetic
credentials were removed and their absence verified.

## Settings version 9 and FTP/FTPS profiles, 2026-10-09

Settings version 9 adds FTP/FTPS profiles and their credential lifecycle without
an FTP network backend ([details](ftp-ftps.md)). Shared JSON fixtures verify that
the JavaScript and Rust normalizers agree, that version-8 SFTP profiles migrate
unchanged and that FTP/FTPS profiles survive repeated saves. Rust tests with
in-memory and failing credential backends cover protocol-separated accounts,
protocol/TLS/pin/endpoint/anonymous/save-flag changes, deletion, reset, rollback
after a failed JSON write, partial deletion, explicit `ECREDENTIAL_ROLLBACK` and
an unavailable store.

macOS checks: `npm test` 533 passed, 1 skipped (with a UTF-8 locale; the archive
tests need one); `cargo test` 201 passed, 8 ignored; `npm run build`,
`cargo fmt --check` and `git diff --check` passed. The native remote-auth
acceptance passed every SFTP phase with settings version 9 and cleaned its
synthetic Keychain entries; the native helper/deletion smoke passed. Windows and
Linux were not run for this change.

## Native FTP/FTPS backend, 2026-10-09

macOS (Apple silicon) checks of the native FTP/FTPS backend
([details](ftp-ftps.md)): `cargo test` 232 passed, 8 ignored, including the
suppaftp contract tests and FtpManager tests against the local test server
(plain FTP, explicit and implicit FTPS, untrusted, wrong-host, expired and
pinned certificates, refused `AUTH TLS`/`PROT P`, required TLS session reuse,
final 451/552 replies, MLSD and Unix/DOS `LIST`, cancellation, stalled
transfers, pooling and reconnect). `npm test` 535 passed (UTF-8 locale),
`npm run build`, `cargo fmt --check` and `git diff --check` passed; clippy
reports no warnings in the new code.

`scripts/ftp-native-smoke.mjs` passed with the real Keychain and filesystem
helper, including `--long`: an active download longer than the two-minute
inactivity limit completed. The SFTP remote-auth acceptance and the native
helper/deletion smoke passed on the same build. Windows and Linux were not run
for this change.
