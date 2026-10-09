# FTP and FTPS connections

Status: connection **profiles** and their credential lifecycle exist. FTP and
FTPS cannot connect yet. This document separates what the code does today from
the contract the network backend must meet.

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
unknown protocol (including `SFTP` or an empty string) is dropped, never read as
SFTP.

The same rules are implemented in `shared/defaultSettings.js` (frontend and
Node/SEA) and `src-tauri/src/settings/mod.rs` (Tauri).
`test/fixtures/settings/connection-profiles.json` is their shared contract:
both test suites check every case and that normalized output is a fixed point.
Strings are trimmed with JavaScript `trim` semantics and bounded by code points
(host 255, username 128, paths 4096, SSH config alias 255). Names are truncated
to 120 code points; an over-long host, username or id rejects the profile, and
an over-long or control-character optional field becomes empty.

**Older builds:** a Vesperwind build that knows only settings version 8 reads
FTP/FTPS profiles as SFTP and rewrites them when it saves. Opening version-9
settings with an older build is not supported. Their saved FTP/FTPS passwords are
not exposed by that, because the credential identity includes the protocol, but
they become orphaned until the profile is deleted in a current build.

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
(`RemoteProviders::disconnect_profile`): SFTP profiles end their SSH session.
FTP/FTPS have no sessions yet; their manager plugs in at the same place.

### Isolation from SFTP

- SSH commands, the native helper and Node/SEA `validateConnectionProfile`
  accept SFTP profiles only.
- `connections:capabilities` reports `protocols: ["sftp"]`, the protocols that
  can connect in this build.
- The Remote Connections form, Save As and the terminal menu list SFTP profiles
  only. The form keeps FTP/FTPS profiles unchanged when it saves or deletes an
  SFTP profile and says that they will be editable once FTP support is added.

## Not implemented yet

FTP/FTPS network connections, TLS handshake, certificate verification and pin
enforcement, `AUTH TLS`/`PBSZ 0`/`PROT P`, directory listing, file transfer,
FTP UI, and transfer finalization, progress and cancellation. None of these
exist today; there is no FTP backend, so no FTP profile can connect.

## Requirements for the network backend (stage C)

### 1. Explicit transfer finalization

`RemoteEndpoint::create_new` returns `Box<dyn Write>` and `remote_ops::copy_entry`
uses `std::io::copy`. That is correct for SFTP, but for FTP/FTPS writing all
bytes does not mean the server accepted the file. A transfer must:

1. open the data transfer;
2. stream the data;
3. flush and close the data channel (including TLS close for FTPS);
4. read the final control-connection reply;
5. check that it is a successful completion (for example `226`/`250`);
6. only then report the transfer as completed.

A failing final reply is a failed operation even if every byte was sent. Dropping
the writer is not a completion. The endpoint interface gets an explicit finish
step (a transfer handle or a `finish()` with its own error), so SFTP stays as it
is. The partial destination of a failed transfer is removed.

### 2. Chunked copying with checkpoints

`std::io::copy` never calls `filesystem::jobs::checkpoint()` while it copies a
single file. The backend uses its own loop:

```text
while transferring:
    checkpoint()               # deadline / cancellation
    read chunk
    write chunk
    account transferred bytes  # progress
    check idle timeout
```

These are separate states:

- **Cancellation**: an explicit user request.
- **Idle timeout**: no useful network activity for a bounded time.
- **Progress**: bytes actually transferred.
- **Completion**: the server's final reply confirmed success.

A transfer is not stalled just because it takes longer than 120 seconds.
Frontend deadlines, the helper watchdog and the transfer loop change together.
Blocked socket I/O must not ignore cancellation: sockets have read/write timeouts
and cancellation kills the helper as it does today.

### Acceptance scenarios for stage C

These use controlled local servers and synthetic credentials:

- successful FTP, explicit FTPS and implicit FTPS uploads and downloads with a
  SHA-256 integrity check;
- a server that rejects the final reply after receiving every byte: the
  operation fails and no partial file remains;
- cancellation of one large file in the middle of the transfer;
- an idle server: an idle timeout, not a hang;
- a long transfer that keeps making progress beyond 120 seconds and completes;
- a repeated transfer after cancellation;
- untrusted, mismatched and changed certificates (no `PASS` is sent);
- `AUTH TLS` refused or `PROT P` refused: the connection fails and never falls
  back to plaintext;
- no password in logs, URLs, process arguments or diagnostic output.
