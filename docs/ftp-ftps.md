# FTP and FTPS connections

Status: profiles, the credential lifecycle, the native (Tauri) backend, the
Node/SEA backend and the SFTP | FTP | FTPS tabs of the Remote Connections
window exist. Both backends accept the same `ftp:connect` request (a saved
profile id and an optional typed password) and use the same provider ids,
error codes and certificate details.

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
  accept SFTP profiles only; FTP never runs through `SshManager` or the Node
  `SshConnectionManager`.
- `connections:capabilities` lists the protocols that can connect: the native
  app and Node/SEA both report `sftp`, `ftp` and `ftps` (each is covered by a
  real-server acceptance). Node/SEA reports `credentialStore: false`.
- The terminal menu lists SFTP profiles only (FTP has no terminal). Save As
  lists SFTP, FTP and FTPS connections. The Remote Connections window shows
  each protocol in its own tab and keeps every other profile, including
  preserved profiles of unknown protocols, unchanged when it saves or deletes.

## Remote Connections window

`src/components/RemoteConnectionsModal.vue` shows SFTP | FTP | FTPS tabs
(Bootstrap `nav-tabs` styling; Vue owns the active tab, no Bootstrap Tab
JavaScript). `src/components/remoteConnectionProtocols.js` is the declarative
registry: label, icon, profile fields with their defaults, authentication
methods, default port and the form sections each protocol uses. A further
protocol is a new registry entry plus its backend; tabs appear only for
protocols in `connections:capabilities.protocols`.

- Each tab lists only its own profiles; Add creates a profile of the tab's
  protocol with its default port: SFTP 22, FTP 21, FTPS explicit 21 and
  implicit 990. Switching explicit ↔ implicit changes 21 ↔ 990 only for a new
  profile whose port was not typed; a saved profile keeps its port.
- Typed passwords and passphrases are cleared on every tab or profile switch.
  Unsaved profile edits are never dropped silently: switching tab or profile,
  Add, Cancel, the close button and Escape ask "Discard unsaved changes?".
- Tabs are ARIA tabs (`tablist`/`tab`/`tabpanel`, roving `tabindex`) with
  ←/→/Home/End; the list and the form stack below 576 px.
- SFTP keeps Auto/Password/Private key/SSH Agent, SSH config hosts (only on
  this tab), passphrases, host key trust (a changed host key blocks the
  connection), saved credentials and Forget.
- FTP offers Password and Anonymous. Anonymous fills the user name
  `anonymous`, hides the password field and never saves a password. Before
  the first connection of a profile a confirmation reads "This connection is
  not encrypted. Your password and files may be visible to others on the
  network." with Cancel and Connect without encryption; only after consent is
  `plaintextAcknowledged` saved and the connection made. There is no automatic
  FTPS → FTP fallback.
- FTPS offers Explicit/Implicit TLS, shows whether the certificate is verified
  by the system or pinned (with its SHA-256) and Remove trusted certificate.
  Passive mode and UTF-8 are shown read-only.
- An untrusted, wrong-host or expired certificate opens a trust dialog with
  endpoint, reason, SHA-256, subject, issuer, validity and SAN names. It says
  that a pin accepts exactly this certificate without checking issuer, host
  name or expiry. Only Trust certificate and connect saves
  `tlsTrustedCertificate` (as its own settings change, after any endpoint
  edit) and connects again. `ETLS_CERTIFICATE_CHANGED` shows a blocking
  warning with the trusted and presented fingerprints and no trust button:
  the pin is never replaced automatically and nothing is retried.
- "Save password securely" appears only when the runtime has a credential
  store.
- The selected profile shows Connected or Not connected (status request plus
  the merged `ssh:status`/`ftp:status` stream); Disconnect ends the session,
  Connect becomes Reconnect while connected. The unsaved-changes prompt offers
  Save changes, Discard changes and Keep editing.
- Cancel connection is shown for the whole connect: the network permission
  wait, the TCP/TLS handshake and the login. It frees the dialog at once. An
  FTP/FTPS attempt is stopped on the backend (`ftp:cancel-connect`), which
  also closes a connection that completed just before the cancel arrived. A
  connect result that arrives after the dialog was closed or the attempt
  cancelled is not opened in a panel; a late SFTP connection, which has no
  backend cancellation, is disconnected by the dialog.

## Node/SEA backend

Code: `server/ftp.js` (connections, TLS, pooling, transfers, listings),
`server/connections.js` (Socket.IO events and capabilities),
`server/remoteProviders.js` (one dispatch for `local`, `sftp:`, `ftp:` and
`ftps:` used by listing, text/binary files, properties, size, search, media
and file operations; any other provider is `EFILESYSTEM_ID`). The FTP client
is [basic-ftp](https://github.com/patrickjuchli/basic-ftp) 6.2.3 (pinned);
`test/ftpLibraryContract.test.js` checks the library behaviour this relies on.

- `ftp:connect { profileId, password, attemptId? }` connects a **saved**
  profile, like the native command; endpoint, TLS mode, pin and plaintext
  acknowledgement come from the settings file. Plain FTP without
  `plaintextAcknowledged` is refused before any network access.
- Only the newest attempt for a profile registers its session. A newer
  connect for the same profile, `ftp:cancel-connect { attemptId }`,
  `ftp:disconnect` or a saved change of the profile's session settings aborts
  an attempt that is still connecting and closes its sockets at once
  (`ECANCELLED`, or `EFTP_PROFILE_CHANGED` for a settings change). Right
  before registering, the saved profile is read again; a removed profile or
  changed protocol, endpoint, user, authentication, TLS mode, pin or
  plaintext acknowledgement ends the attempt with `EFTP_PROFILE_CHANGED`, so
  a session is never registered with outdated settings. The native backend
  holds its profile lock for the whole connect instead.
- TLS without a pin: Node verifies the chain against its bundled roots, the
  operating system store and `NODE_EXTRA_CA_CERTS`, and the host name
  (`rejectUnauthorized` stays on). With a pin: exactly that certificate is
  accepted, chain, name and validity are not checked (as in the native
  verifier); `rejectUnauthorized` is off only in this mode, and every socket is
  checked against the pin instead.
- Order: TCP (or the implicit TLS handshake), `AUTH TLS`, verification of the
  control connection, `PBSZ 0`, `PROT P`, and only then `USER`/`PASS`. A
  refused `AUTH TLS` or `PROT P` ends the attempt
  (`EFTPS_AUTH_TLS_REJECTED`, `EFTPS_PROT_P_REJECTED`).
- Data connections: every TLS data socket is verified when its handshake
  completes, before basic-ftp may use it; basic-ftp starts uploads only after
  that. A data connection that resumes the session of this FTP session is
  accepted (Node reports no certificate for it); a full handshake must pass
  the same checks as the control connection. A refused data connection ends
  the whole FTP session.
- On a certificate failure the details for the dialog come from a separate
  handshake that sends no credentials (`AUTH TLS` only for explicit TLS).
- Sessions are pooled per profile (at most four); listings and metadata are
  repeated once on a fresh session after a lost connection, `STOR`, `DELE`,
  `RMD`, `RNFR`/`RNTO` and `MKD` never are. `NOOP` keeps idle sessions alive.
- Transfers stream with backpressure and succeed only after the final reply
  (a 451/552 after all bytes fails them). A transfer without progress for
  120 s fails (`ETIMEDOUT`), a transfer is bounded at 24 hours, and file
  operations carry an id: `filesystem:operation-cancel`, the UI deadline or a
  closed socket stops them. Partial destinations created by a failed or
  cancelled copy are removed. Copies and moves with an FTP side therefore use
  the long UI deadline in this runtime too.
- Listings are parsed per line (MLSD, Unix and DOS `LIST`). Names that are not
  one safe component (`/`, `\`, control characters, `.`/`..`) are hidden;
  recursive copy, delete and size refuse a listing that contained one
  (`EUNSAFE_NAME`) before creating or deleting anything. Local destinations
  also refuse names that are unsafe on the local platform (on Windows `C:x`,
  `name:stream`, reserved characters, trailing dots and spaces). The same
  checks now apply to SFTP listings in Node.
- Media and content requests read byte ranges with `REST` when the server
  supports it.
- Passwords are held in memory only (there is no secure credential store in
  this runtime); they are never written to the settings file, logs, Socket.IO
  events or errors. After a successful connect the password stays in memory
  for this backend process, so Reconnect, or Connect after a lost
  connection, works with an empty password field while the profile's session
  settings are unchanged. Disconnect, a change of those settings, a refused
  reused password and the end of the process forget it. Sessions end when the last
  browser disconnects, on `ftp:disconnect`, or when saved settings change a
  connected profile's protocol, host, port, user, authentication, TLS mode,
  pin or plaintext acknowledgement (the same applies to SFTP profiles).

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
- **Unsafe names**: an entry name from `MLSD`/`LIST` must be one path
  component. Names that are empty, `.`, `..`, or contain `/`, `\`, NUL or
  control characters are not shown; a recursive copy, delete, size or
  clipboard/drag tree refuses such a listing as a whole (`EUNSAFE_NAME`)
  before creating or deleting anything. Local destinations additionally
  follow the platform's rules (on Windows no drive or stream `:`, reserved
  characters, trailing dots or spaces) and must stay direct children of the
  target folder. The same check applies to every remote and local source in
  `remote_ops::copy_entry`.
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

- Active mode, legacy filename encodings, FTP terminal, permission changes,
  WebDAV and other protocols.
- Native app: resumed reads (`REST`), media streaming and thumbnails over FTP.
- Node/SEA: a secure credential store (passwords are session-only).

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

Node/SEA: `test/ftpNodeAcceptance.test.js` (part of `npm test`) runs the
production modules against `test/support/ftpTestServer.js` (plain, explicit
and implicit FTPS with a synthetic PKI, required session reuse, `dataCert` for
a data connection with another certificate, final errors, stalls, throttling,
hostile MLSD/LIST lines) and an ssh2 SFTP server
(`test/support/sftpTestServer.js`). `scripts/ftp-runtime-smoke.js` drives a
real backend process over Socket.IO; `--sea staging/vesperwind` runs the same
against the SEA executable. CI runs the smoke on Linux (Node 22) and builds
and smokes the SEA executable on macOS.
