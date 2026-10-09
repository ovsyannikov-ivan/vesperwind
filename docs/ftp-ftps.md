# FTP and FTPS connections

Status: profiles, the credential lifecycle and the native (Tauri) FTP/FTPS
backend exist. There is no FTP/FTPS form in the Remote Connections window yet
(stage D) and no Node/SEA backend (stage E); until then FTP/FTPS profiles are
connected through the native `ftp:connect` command only.

## Implemented

### Profile model (settings version 9)

`settings.connections` holds SFTP, FTP and FTPS profiles in one list. Profile
ids are unique across all protocols; when two entries share an id, the first one
wins. Every profile has `id`, `name`, `host`, `port`, `username`, `authType`,
`protocol`, `savePassword` and `initialPath`. Each protocol keeps only its own
fields:

| Protocol | Authentication | Protocol-specific fields |
|---|---|---|
| `sftp` | `auto`, `password`, `privateKey`, `agent` | `privateKeyPath`, `trustedFingerprint`, `sshConfigHost`, `saveKeyPassphrase` |
| `ftp` | `password`, `anonymous` | `ftpDataMode`, `ftpEncoding`, `plaintextAcknowledged` |
| `ftps` | `password`, `anonymous` | `ftpTls` (`explicit`/`implicit`), `ftpDataMode`, `ftpEncoding`, `tlsTrustedCertificate` |

- `ftpDataMode` is always `passive` and `ftpEncoding` is always `utf-8` for now.
  The fields exist so that active mode and legacy encodings can be added later.
- `tlsTrustedCertificate` is an optional SHA-256 pin of the server's DER
  certificate, stored as 64 lowercase hex digits. Input with colons or upper
  case is canonicalized; anything else becomes empty.
- An anonymous profile with an empty username gets `anonymous` and never saves
  a password.
- Suggested ports when a profile is created: SFTP 22, FTP 21, FTPS explicit 21,
  FTPS implicit 990 (`defaultConnectionPort`). Normalization never replaces a
  port that is already set.
- Invalid modes are replaced by the protocol default. Fields that belong to
  another protocol are dropped, so FTP can never carry SSH Agent settings and
  SFTP can never carry a TLS mode.

### Migration from version 8

A profile without `protocol` is a legacy SFTP profile. A valid version-8 SFTP
profile is unchanged, including id, name, endpoint, authentication mode, SSH
config alias, fingerprint and both save flags. Migration only rewrites JSON and
never reads or changes Keychain/Credential Manager entries. A profile with an
unknown protocol (including `SFTP`) is never read as SFTP; see
[Settings compatibility](#settings-compatibility).

The same rules are implemented in `shared/defaultSettings.js` (frontend and
Node/SEA) and `src-tauri/src/settings/mod.rs` (Tauri).
`test/fixtures/settings/connection-profiles.json` is their shared contract:
both test suites check every case and that normalized output is a fixed point.
Strings are trimmed with JavaScript `trim` semantics and bounded by code points
(host 255, username 128, paths 4096, SSH config alias 255). Names are truncated
to 120 code points; an over-long host, username or id rejects the profile, and
an over-long or control-character optional field becomes empty.

### Settings compatibility

- **Newer settings:** when `settings.json` has a higher version than the build
  supports, loading, saving and resetting settings fail with
  `ESETTINGS_NEWER_VERSION` ("These settings were saved by a newer version of
  Vesperwind…"). The file is neither normalized nor rewritten, and saved
  credentials are not touched. The app starts with default settings in memory
  and shows the message. Both the native backend and Node/SEA apply this.
- **Unknown protocols:** a profile whose `protocol` is a string this build does
  not know is kept as it is, provided it is small and flat (at most 64 fields,
  each null, boolean, safe integer or string of up to 4096 code points; keys up
  to 64 characters; protocol up to 32 code points). Non-boolean fields whose
  names look like secrets (`pass`, `secret`, `token`, `credential`, `key`,
  `privateKey`, `keyContents`, `apiKey`) are removed. Such a profile is not
  listed, connected, matched with credentials or given trust resets. Larger or
  nested profiles, an empty or non-string protocol and an invalid id are dropped.
- **Rule for future protocols:** adding a connection protocol always raises the
  settings version, so builds from this version on refuse such settings instead
  of rewriting them.

**Older builds:** a Vesperwind build that knows only settings version 8 reads
FTP/FTPS profiles as SFTP and rewrites them when it saves. Opening version-9
settings with an older build is not supported. Their saved FTP/FTPS passwords are
not exposed by that, because the credential identity includes the protocol, but
they become orphaned until the profile is deleted in a current build. The
version guard above protects only builds that include it.

### Endpoint trust

An FTP plaintext acknowledgement and an FTPS certificate pin belong to one
endpoint. When a saved profile's protocol, host or port changes (and for a pin
also its TLS mode), Settings update clears them, whatever the request contained.
A new profile keeps the values it was created with. SFTP host-key trust keeps its
existing behavior. Both the native update and the Node settings handler apply
this rule (`resetChangedConnectionTrust` / `reset_changed_connection_trust`).

### Credentials

FTP and FTPS use the existing `CredentialStore` (service
`com.vesperwind.credentials`) with accounts `ftp:<profile-id>:password` and
`ftps:<profile-id>:password`. They never use `key-passphrase` entries.

`CredentialStore::reconcile_with_commit` keeps its order: compute affected
accounts, read backups into zeroizing memory, delete, commit the JSON, then end
sessions; a reported failure restores the backups or reports
`ECREDENTIAL_ROLLBACK`. Changes for this stage:

- Profiles still pair by id **and** protocol. A protocol change
  (`ftps → ftp`, `ftp → ftps`, `sftp → ftp`, `ftp → sftp`) therefore removes the
  old protocol's secrets, and the new protocol never sees them.
- The trusted endpoint also includes `ftpTls` and `tlsTrustedCertificate`.
  Changing host, port, username, TLS mode or pin removes the saved password and
  ends the session.
- Switching to `anonymous`, clearing `savePassword`, deleting the profile or
  resetting settings removes the password.
- Data mode and encoding changes end the session but keep the password.
- With no credential store (Linux), a profile without a saved password is
  saved without touching the store.

Forget works for FTP/FTPS passwords. Asking an FTP/FTPS profile for its key
passphrase returns an error. Sessions are ended by protocol
(`RemoteProviders::disconnect_profile`): SFTP profiles end their SSH session,
FTP/FTPS profiles close all their pooled sessions.

### Isolation from SFTP

- SSH commands, the native helper and Node/SEA `validateConnectionProfile`
  accept SFTP profiles only; FTP never runs through `SshManager`.
- `connections:capabilities` lists the protocols that can connect: the native
  app reports `sftp`, `ftp` and `ftps`; Node/SEA reports `sftp`.
- The Remote Connections form, Save As and the terminal menu list SFTP profiles
  only. The form keeps FTP/FTPS and preserved profiles unchanged when it saves
  or deletes an SFTP profile and says that they cannot be edited yet.

## Native backend (Tauri)

Code: `src-tauri/src/ftp/` (`mod.rs` manager and provider operations,
`connection.rs` one session, `pool.rs` sessions and transfers, `tls.rs`
certificate checks, `listing.rs` MLSD/LIST parsing, `errors.rs`).

### Connecting

`ftp:connect` (`ftp_connect`) takes a **saved** profile id and an optional
typed password. The saved settings decide host, port, protocol, TLS mode,
certificate pin, plaintext acknowledgement and whether a saved password may be
used; a profile sent over IPC is never trusted. The result has the same shape
as SFTP connect: `connectionId`, `providerId` (`ftp:<id>` or `ftps:<id>`),
`status`, `root`, `initial`, `homePath`, `credentialWarning`, plus
`capabilities`. `ftp:disconnect` and `ftp:status` complete the set; the
`ftp:status` event reports connection changes. `ssh:*` commands are unchanged.

- **Plain FTP** (`ftp`) refuses to connect with
  `EFTP_PLAINTEXT_NOT_ACKNOWLEDGED` unless the saved profile has
  `plaintextAcknowledged`, even when a password is supplied. Password and data
  are unencrypted.
- **Explicit FTPS**: TCP, `AUTH TLS`, a verified TLS handshake, `PBSZ 0`,
  `PROT P`, and only then `USER`/`PASS`. A refused `AUTH TLS`
  (`EFTPS_AUTH_TLS_REJECTED`) or `PROT P` (`EFTPS_PROT_P_REJECTED`) ends the
  attempt; there is no fallback to clear text, `PROT C` or `CCC`.
- **Implicit FTPS**: TLS from the first byte (default port 990), then
  `PBSZ 0` and `PROT P` before credentials.
- Anonymous profiles log in as `anonymous` with `anonymous@`.
- Connect, read and write timeouts (15 s connect, 30 s per socket operation)
  cover the TLS handshake and the greeting too. Passive mode uses `EPSV` when
  the server lists it and otherwise `PASV` (with the control address when a
  server reports a private address). Active mode is not supported.
- After login the session enables `OPTS UTF8 ON` when offered and binary mode.

### TLS and certificate pinning

Certificates are verified by the operating system trust store
(`rustls-platform-verifier`, rustls with the ring provider): chain, validity
period, server name and IP SAN. If `tlsTrustedCertificate` is set, exactly that
certificate (SHA-256 of its DER encoding) is accepted for the endpoint instead;
any other certificate is refused with `ETLS_CERTIFICATE_CHANGED`, even one the
system trusts. A pinned certificate's chain, name and validity are not checked:
the pin is an explicit decision about that certificate, cleared whenever the
endpoint or TLS mode changes (see *Endpoint trust*).

A rejected certificate fails with `ETLS_CERTIFICATE_UNTRUSTED`, `_HOSTNAME`,
`_EXPIRED` or `_CHANGED` and returns its details (endpoint, SHA-256, subject,
issuer, validity, DNS names, IP addresses, reason) for a later confirmation
dialog. Nothing is trusted or saved automatically, and `USER`/`PASS` are never
sent. Every data connection and every helper session repeats the same check,
and data connections resume the control connection's TLS session (servers
that require session reuse work).

Debug builds additionally trust a CA named by `VESPERWIND_FTP_TEST_CA` (used by
the acceptance script); release builds never read it.

### Connection credentials

A typed password stays in zeroizing memory for the connection. It is saved to
`ftp:<id>:password` or `ftps:<id>:password` only after the TLS check, login and
the initial directory check succeeded, and only when `savePassword` is set; a
store failure leaves the connection working and returns `credentialWarning`.
Without a typed password, only the saved password of this exact profile and
protocol is used. Connecting holds the same profile-update lock as settings
reconciliation and Forget. The suppaftp copy in `vendor/suppaftp` redacts
`PASS` in its trace log; passwords never appear in settings, URLs, process
arguments, environment variables, error texts or logs. Login failures never
include the server's reply text.

### Sessions and pooling

An FTP control connection runs one command or data transfer at a time. Each
connected profile has at most four sessions (one for browsing plus three for
independent transfers, `pool::MAX_SESSIONS`); further requests wait up to two
minutes and then fail with `EFTP_BUSY`. A session returns to the pool only after
its operation finished successfully; a lost connection, an aborted or failed
transfer discards it. Keepalive `NOOP`s go only to idle sessions. Listing and
metadata reads are retried once on a new session after a lost connection
(stale idle sessions are dropped); `STOR`, `DELE`, `MKD`, `RMD` and
`RNFR`/`RNTO` are never repeated, because the server may already have applied
them. Disconnect, Forget and profile changes close every session of the profile.

Each filesystem helper opens its own sessions from a snapshot (profile,
resolved password, paths) sent over its private stdin pipe, verifying TLS and
the pin itself. Servers that limit connections per client may need a smaller
number of parallel operations.

### File operations

Listing, properties, root/home/initial path, text and binary read/write,
create file and folder, rename, delete (recursive), copy and move between
local, SFTP and FTP/FTPS providers in any direction, size calculation, search,
and streaming reads for clipboard and drag-and-drop work through the existing
provider APIs.

- **Listing** uses `MLSD`/`MLST` when the server offers them and otherwise
  `LIST` in Unix (`ls -l`) or DOS/IIS format. Missing sizes or times stay
  unknown; permission facts are never shown as POSIX modes, and permissions
  cannot be changed. `LIST` times follow the server's (sometimes year-less)
  format. Names are UTF-8; legacy encodings are not supported yet.
- **Links** reported by the server are deleted or copied as entries, never
  followed by recursive operations, so a link cycle cannot cause recursion.
  Entries whose type the server does not report are treated as files.
- **No atomic create**: FTP has no exclusive create. Before `STOR`, `MKD` or
  `RNTO` the destination is checked and an existing item is reported as
  `EEXIST`; another client can still create the same name in between.
  Rename never relies on the server's overwrite behavior. Editor saves replace
  the file with `STOR` and are not atomic either.
- **Transfers** stream in 256 KiB chunks and never load a file into memory
  (editor and binary reads are limited to 10 and 32 MB as for SFTP).

### Transfer completion

A transfer succeeds only after both sides confirmed it:

1. the data is copied chunk by chunk;
2. an upload is flushed, TLS `close_notify` is sent, the data connection is
   half-closed and read until the server closes it (so unread TLS session
   tickets cannot turn the close into a reset);
3. the final control reply is read and must report success (226/250);
4. for a download, the final reply after end-of-file is checked the same way.

A final error such as 451 or 552 after every byte was sent is a failed copy.
`RemoteEndpoint::open_read` and `create_new` return `TransferRead` and
`TransferWrite` with an explicit `finish()`; dropping or aborting never
reports success. SFTP closes its file handle in `finish()` and reports a close
error. When a copy fails, the destination file this copy created is removed;
a move removes its source only after the whole copy succeeded.

### Timeouts, cancellation and progress

- The copy loop calls `jobs::checkpoint()` before every read and write, and the
  helper reports transferred bytes as progress lines on its stdout pipe.
- **Cancellation**: the parent writes a stop byte to the helper's stdin; the
  helper stops at its next checkpoint, removes the partial destination and
  exits. If it does not exit within 3 seconds (for example in a blocked
  socket read), it is killed as before; a partial file can then remain.
- **Inactivity**: native copy and move with a remote side are stopped after two
  minutes without progress (`ETIMEDOUT`); a transfer that keeps moving data is
  not limited by duration (frontend and helper deadline: 24 hours). Socket
  timeouts (30 s) end blocked reads and writes first.
- Other remote operations keep their deadlines (120 s, delete 30 s); local
  operations and the Node/SEA backend are unchanged.
- `filesystem::jobs::execute_with_progress` exposes the transferred bytes to the
  native side; there is no progress display in the UI yet.

## Not implemented yet

- FTP/FTPS form and certificate confirmation dialog (stage D).
- Node/SEA FTP backend (stage E).
- Active mode, legacy filename encodings, resume (`REST`), FTP terminal,
  media streaming and thumbnails over FTP, permission changes.

## Verification

Rust tests run the library and the manager against a local test server
(`ftp/test_server.rs`) that serves plain FTP, explicit and implicit FTPS with a
synthetic CA, and injects rejected `AUTH TLS`/`PROT P`, required TLS session
reuse, final 451/552 replies, stalled and throttled transfers, and servers
without MLSD (Unix and DOS `LIST`).

`scripts/ftp-native-smoke.mjs` runs the debug application with the real system
credential store and the real filesystem helper: plain FTP acknowledgement,
explicit and implicit FTPS, an untrusted certificate (no credentials sent) and
its explicit pin, saved password across a restart and Forget, a 24 MiB
transfer local → FTPS → FTP → SFTP → FTPS → local with SHA-256 checks, a final
451 after all bytes, cancellation mid-file with cleanup, and a repeated
transfer. `--long` throttles one download beyond the two-minute inactivity
limit. It needs OpenSSL to prepare certificates.
