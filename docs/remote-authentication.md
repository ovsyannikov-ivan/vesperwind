# Remote Connections authentication

Remote Connections supports SFTP profiles with `auto`, `password`, `privateKey`
and `agent` authentication. New profiles use Auto. Existing profiles retain their
explicit authentication method and ID when settings are migrated to version 8.
FTP/FTPS transports are outside this change.

## Saved credentials

The Tauri backend owns a protocol-independent `CredentialStore`. Its identity is
`com.vesperwind.credentials` plus `protocol:profile-id:kind`, where kind is
`password` or `key-passphrase`. Renaming a profile preserves the credential.
Future protocols can reuse the store without treating an SSH host as its key.

- macOS uses `apple-native-keyring-store` and Keychain.
- Windows uses `windows-native-keyring-store` and Windows Credential Manager,
  with local-machine persistence. No registry, file or roaming fallback exists.
- Linux has the same backend interface, but no persistent backend is enabled
  yet. Adding Secret Service does not require changing the profile contract.
- Browser/SEA reports secure persistence and native SSH config as unavailable.
  Its existing Node SSH transport supports session-only Auto/password/key/agent.

Settings contain profile metadata, authentication mode, key **path**, initial
path, trusted fingerprint, SSH config alias and two save flags. They never contain
passwords, passphrases or private-key bytes. The native status API returns only
existence booleans. There is no frontend API for retrieving saved secrets.

The modal's Save action saves metadata only. Checked credentials are persisted
after a successful, trusted SSH/SFTP connection. A persistence failure is shown
explicitly; the connection can continue using its transient secret. Unchecked
secrets remain in session memory for reconnect and are released on disconnect.
Native secret strings and helper input buffers are zeroized on release.

Forget deletes the selected credential and disconnects the SFTP session so a
stale session secret cannot silently restore it. Disabling a save flag, removing
a profile, changing its endpoint/user/config alias, or switching to a method
which cannot use that secret cleans the affected OS entries. Changing a private
key path clears its saved passphrase. Settings update and reset serialize profile
changes, snapshot affected secrets in zeroizing native memory, then clean the
entries and persist JSON. Sessions disconnect only after both steps succeed.
If cleanup or JSON persistence reports an error, the previous secrets are
restored and the previous settings remain active. If restoration itself fails,
an explicit error asks the user to re-enter the affected credentials. This
compensates for reported failures; it is not a crash-atomic transaction across
the filesystem and the OS credential store. No recovery secrets are written
to disk or returned to the frontend.

## Shared native authentication

SFTP connect, reconnect, SSH terminal and operation helpers use the same config
resolver and authenticator. Host-key verification always precedes authentication.
Unknown and changed host keys retain their existing confirmation/error behavior.
A linked config endpoint change invalidates the previous endpoint's trust.

Auto tries, in order:

1. SSH Agent identities, including identities after an unsuitable first key.
2. Configured IdentityFile paths, an optional explicit key path, and standard
   `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, without duplicates.
3. A saved password, when allowed by the profile.
4. A newly supplied password.

An encrypted key is first attempted without a passphrase; its typed/saved
passphrase is used only when required. Explicit Password and Private key modes
retain their selected method; Agent never falls back to a password or key file.
Standard file-key discovery is disabled by `IdentitiesOnly yes`.

The native agent uses libssh2, not an OpenSSH subprocess. macOS uses its agent
socket; Windows uses the OpenSSH agent named pipe supported by the bundled
libssh2 build. The Windows build enables `openssl-on-win32` alongside vendored
OpenSSL; WinCNG does not support Ed25519. With IdentitiesOnly, agent keys are matched against configured
public keys (`.pub` files); configured private-key files remain available when
the matching public file is absent. Hardware/security-key providers are outside
this implementation.

Password keyboard-interactive fallback accepts only one non-echo password
prompt in the first round. Multiple rounds/prompts and OTP/MFA prompts return
`EAUTHENTICATION_REQUIRED` with `needs: interaction`; the password is not supplied
to those challenges. Authentication errors contain attempted methods and the
required input kind, never a secret or an underlying keyring error dump.

Terminal sessions re-resolve the profile and use the same authentication
semantics. The filesystem parent acquires helper credentials in native memory,
then transmits its resolved profile and zeroizing secrets through the existing
anonymous stdin pipe. No secret is placed in command arguments, environment,
temporary files or worker logs. Helpers verify the host key themselves.

## SSH config

The native app reads `~/.ssh/config` afresh when the modal opens and when a linked
profile connects. The config section lists concrete aliases; wildcard and
negated patterns contribute inherited settings without becoming synthetic
connection entries. Selecting an alias fills HostName/User/Port and preserves a
stable profile ID when it is saved again. IdentityFile remains linked to config
rather than being copied into the profile as a stale key path.

Parsing uses the mature MIT-licensed `ssh2-config` 0.8.1 library. A vendored copy
has three localized fixes for first-value singleton behavior, absolute Windows
Include paths, and bounded Include recursion; see
[`VESPERWIND-PATCHES.md`](../vendor/ssh2-config/VESPERWIND-PATCHES.md).

Supported connection directives are Host, HostName, User, Port, IdentityFile,
IdentitiesOnly and the library's Include behavior. IdentityFile supports `~/`
and `%d`, `%h`, `%r`, `%p`, `%%`. Config is read-only; no local or proxy command
is executed. ProxyJump/ProxyCommand and external command/provider requirements
are reported as unsupported rather than silently bypassed.

Limitations: Match blocks, environment substitutions, other path tokens and
multi-pattern Include syntax are not supported. Custom IdentityAgent directives
are not applied; agent discovery uses the OS default socket/pipe. Unsupported
or malformed config does not break unrelated manually configured profiles.

## Verification

Normal CI uses mocked credential backends and controlled SSH servers; it does
not access a user's real secrets. Coverage includes metadata migration, stable
credential IDs, overwrite/delete/error handling, profile lifecycle, auth order,
explicit-method isolation, encrypted keys, agent iteration, config aliases and
Include semantics, unsupported MFA and the actual modal setup logic.

For opt-in macOS native acceptance, build a debug application and run:

```sh
VESPERWIND_NATIVE_BINARY=/absolute/path/to/debug/vesperwind \
  node scripts/remote-auth-native-smoke.mjs /tmp/new-unique-acceptance-directory
```

The script creates synthetic keys/credentials, a loopback SSH/SFTP server and a
separate agent; it never edits the user's config or agent. Separate app processes
verify save/restart/reuse/Forget, host trust, agent iteration, config key files,
terminal, reconnect and real private-pipe file transfer. Cleanup removes only
UUID-scoped test credentials, including after a failed run. OpenSSH binaries in
this script are test preparation tools, never production dependencies. Windows
acceptance must use the existing service and remove only its own added test keys.
