# Archives and address navigation

Panels retain the shared `{ providerId, path }` contract. Commands pass through
`src/api`, the existing Socket.io/Tauri transport, and backend workers. Vue never
starts a process or accesses the filesystem directly.

## Address bar and network paths

Breadcrumbs remain the normal view, including folder context menus. The pencil
button or Ctrl/Cmd+L edits the active panel's complete path. Enter validates the
directory through its provider before navigating. Escape discards the edit.
Errors retain the current folder and draft; stale responses after Escape,
provider changes or unmount cannot navigate.

Local paths accept POSIX paths, Windows drives and UNC; Windows also accepts
`computer://`. SFTP accepts absolute paths on the current server and preserves
its provider ID. Browser access still respects `FILE_MANAGER_ROOT`.

In Tauri, macOS `smb://server/share` uses NetFS and its system authentication UI,
then the actual returned mount point. Windows UNC uses WNetUseConnectionW with
CONNECT_INTERACTIVE, then normal local filesystem access. Credentials are not
accepted in SMB URLs, exposed to Vue or stored by Vesperwind. There is no SMB
provider. Mounted shares work as LocalProvider in both backends. Node browser/SEA
does not initiate mounts; connect through the OS or Tauri first.

## Operations

Select files/folders and choose ZIP or Create ZIP in the context menu. Select a
ZIP, TAR, TAR.GZ/TGZ or RAR and choose Extract. The dialog accepts a destination
directory and ZIP filename or new extraction folder name. It defaults to the
other local panel's directory when available, otherwise the current directory.
Archive operations require LocalProvider, including mounted network shares.
SFTP archive commands are unavailable.

Creation writes ZIP with deflate. Extraction explicitly registers ZIP, TAR,
RAR/RAR5 and built-in gzip. No external filter, system tar, shell or PATH search
is used. 7z is not enabled. Encrypted, multipart or unsupported compression
variants report libarchive errors; no password/multi-volume workflow is provided.

One job runs at a time in Tauri (one per socket in Node). The backend immediately
returns a job ID, emits entry/byte progress and cancels by killing/reaping the
active child. Disconnect, unmount or shutdown cancels outstanding work. Progress
is throttled to about one event per second; no preliminary full scan is needed.

Output is staged in a newly created private directory within the destination.
An atomic rename publishes the result without replacing existing files, folders
or symlinks. Failure/cancellation removes staging. Publication is the commit
point: cancellation after a successful rename reports completion. Panels refresh
through existing entry-change/watch notifications.

## Security

Every original entry name is checked before writing. The worker rejects `..`,
absolute and drive/UNC paths, backslashes, ADS colons, control characters,
reserved device names and trailing-dot/space aliases. Symlinks, hardlinks and
special files are rejected even when their targets appear internal. Only regular
files/directories are accepted; extraction never merges into existing content.

Libarchive additionally uses SECURE_NODOTDOT, SECURE_NOABSOLUTEPATHS,
SECURE_SYMLINKS and NO_OVERWRITE. Ownership, ACLs, xattrs, file flags and privileged
permissions are not restored. Limits are one million entries and 1 TiB, including
checks for oversized sparse offsets. Creation rejects source links and duplicate
source basenames. Shell metacharacters are passed as literal argv values.
These checks prevent archive-controlled escapes; they do not isolate a separate
hostile process running as the same OS user.

## Build and distribution

Run `npm run build:archives` with CMake and the native C/Rust toolchain installed.
These tools are build prerequisites, not runtime dependencies. The recipe supports
native macOS/Linux CMake and Windows MSVC CMake builds. Versions, source URLs and
SHA256 hashes are in `scripts/archive-sources.json`: libarchive 3.8.9 and zlib
1.3.1, statically linked. Optional system codec/crypto libraries and archive CLI
programs are disabled. `VESPERWIND_ARCHIVE_BUILD_DIR` selects a source cache;
cached downloads are verified before use.

The recipe stages `src-tauri/binaries/vesperwind-archive-<Rust target>[.exe]`,
licenses and build information. Generated binaries are ignored. Native dev/build
hooks reject missing/incompatible workers with a rebuild instruction. Tauri
always bundles the worker/notices; the optional FFmpeg overlay retains them.
Release lookup is executable-relative; debug mode also checks the project stage.
Protocol and pinned version are checked before operations. Sign/notarize the
macOS worker with the app. Node staging embeds the same worker and notices; SEA
extracts it to a private unique directory without a PATH fallback.

Errors include EARCHIVE_SIDECAR, EARCHIVE_VERSION, EARCHIVE_BUSY,
EARCHIVE_UNSAFE_PATH, EARCHIVE_UNSAFE_ENTRY, EARCHIVE_LIMIT, EARCHIVE_PUBLISH,
EARCHIVE_FORMAT and ECANCELLED. Stderr diagnostics are limited to 8 KiB.

## Validation

`npm test` covers address state/shortcuts, job isolation/cancellation, real ZIP
round trips, ZIP/TAR/TGZ/RAR/RAR5, malicious entries, cleanup and preservation of
existing destinations. Real sidecar tests explicitly skip when it has not been
built. Fixture provenance is in `test/fixtures/archives/README.md`.

Run `cargo test --manifest-path src-tauri/Cargo.toml`. After building the sidecar,
run `cargo test --manifest-path src-tauri/Cargo.toml real_archive_workflow -- --ignored`
for a real Rust backend workflow. UI acceptance uses Tauri. Windows/WNet requires
Windows; actual SMB authentication requires a reachable share. Unit tests do not
establish those OS/network flows.

References: [libarchive formats](https://github.com/libarchive/libarchive/blob/master/README.md),
[extraction flags](https://github.com/libarchive/libarchive/blob/master/libarchive/archive_write_disk.3),
[WNetUseConnectionW](https://learn.microsoft.com/en-us/windows/win32/api/winnetwk/nf-winnetwk-wnetuseconnectionw).
The macOS implementation uses public NetFS/CoreFoundation SDK headers.
