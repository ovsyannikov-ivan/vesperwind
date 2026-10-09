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
ZIP, TAR, TAR.GZ/TGZ, RAR/RAR5 or 7z and choose Extract. The dialog accepts a
destination directory and ZIP filename or new extraction folder name. It defaults to the
other local panel's directory when available, otherwise the current directory.
Archive operations require LocalProvider, including mounted network shares.
SFTP archive commands are unavailable.

Creation writes ZIP with deflate and UTF-8 filename headers on every platform.
Windows opens physical archive/source paths through libarchive's wide APIs;
Unicode archive filenames do not depend on the system ANSI code page.
Extraction explicitly registers ZIP, TAR,
RAR/RAR5, 7zip and built-in gzip. No external filter, system tar, shell or PATH
search is used. `.7z` recognition is case insensitive; `backup.7z` defaults to
an extraction folder named `backup` in the existing dialog.

7z supports Copy/Store, LZMA and LZMA2, including multiple files in a solid block,
nested/empty directories, spaces and Unicode names. The native x86 BCJ + LZMA2
pipeline is also tested. Other codec/filter combinations are not promised;
unsupported codecs (including BZip2 and PPMd in this build) fail with
EARCHIVE_UNSUPPORTED_CODEC. ZIP creation remains ZIP + Deflate.

7z data encryption and encrypted headers are detected through libarchive's
entry/archive encryption flags and fail with EARCHIVE_ENCRYPTED. There is no
password workflow. Staging is removed, including any previously decoded files.
Multipart archives are not supported: `.7z.001`/`.7z.002` do not advertise Extract.
No volume discovery or automatic concatenation is performed.

One job runs at a time in Tauri (one per socket in Node). The backend immediately
returns a job ID, emits entry/byte progress and cancels by killing/reaping the
active child. Disconnect, unmount or shutdown cancels outstanding work. Progress
is throttled to about one event per second; no preliminary full scan is needed.
In browser/SEA mode, disconnect immediately ends the frontend job with
ECONNECTION_LOST and clears its busy/cancelling state. Reconnect cannot revive
the old job or deliver stale progress. Check the destination before retrying:
publication may have finished just before the connection was lost.

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
Extraction additionally caps cumulative logical file sizes at the initially
available destination space minus a reserve of 10% or 256 MiB, whichever is
larger, and still obeys the 1 TiB ceiling. The worker queries available space
on its actual staging volume (statvfs on POSIX, GetDiskFreeSpaceExW on Windows,
using space available to the calling user). It rechecks before every entry and
after each 8 MiB of streamed data, so consumption by other applications also
stops extraction with EARCHIVE_SPACE. An unavailable space query fails closed.
Sparse holes count toward the logical-size limit. This is a capacity guard,
not a disk reservation; concurrent writers can still race the next check.
These checks prevent archive-controlled escapes; they do not isolate a separate
hostile process running as the same OS user.

7z decoder dictionaries, metadata and solid buffers share a 512 MiB live
allocation budget. The pinned reader calls liblzma's raw decoder without a
native memory-limit argument, so an audited build-time patch supplies a bounded
allocator to the 7zip translation unit, property decoding and liblzma. Requested
read-ahead buffers are additionally capped at 128 MiB. Excessive allocations
fail with EARCHIVE_LIMIT before attempting multi-gigabyte dictionaries. PPMd's
separate unbounded model allocator is rejected. This is an allocation budget,
not an OS-wide RSS cap: the worker also needs input/disk buffers, allocator
headers and library/runtime memory. It remains an isolated, cancellable process.
See `native/archive-worker/README.md` for the patch boundary and tests.

## Build and distribution

Run `npm run build:archives` with CMake and the native C/Rust toolchain installed.
These tools are build prerequisites, not runtime dependencies. The recipe supports
native macOS/Linux CMake and Windows MSVC CMake builds. Versions, source URLs and
SHA256 hashes are in `scripts/archive-sources.json`: libarchive 3.8.9, zlib
1.3.1 and XZ Utils/liblzma 5.8.3, statically linked. Optional system codec/crypto
libraries and archive CLI programs are disabled. `VESPERWIND_ARCHIVE_BUILD_DIR` selects a source cache;
cached downloads are verified before use and sources are freshly extracted from
those verified bytes. The finder links the exact local liblzma target, never a
host installation. Its 0BSD notice is included in Tauri and Node/SEA staging.

The recipe stages `src-tauri/binaries/vesperwind-archive-<Rust target>[.exe]`,
licenses and build information. Generated binaries are ignored. Native dev/build
hooks reject missing/incompatible workers with a rebuild instruction. Tauri
always bundles the worker/notices; the optional FFmpeg overlay retains them.
Release lookup is executable-relative; debug mode also checks the project stage.
Protocol, pinned versions, 7z/LZMA2 capabilities and memory policy are checked
before operations. Builds additionally extract real Copy/LZMA/LZMA2/solid
fixtures. Sign/notarize the macOS worker with the app. Node staging embeds the same worker and notices; SEA
extracts it to a private unique directory without a PATH fallback.

Errors include EARCHIVE_SIDECAR, EARCHIVE_VERSION, EARCHIVE_BUSY,
EARCHIVE_UNSAFE_PATH, EARCHIVE_UNSAFE_ENTRY, EARCHIVE_LIMIT, EARCHIVE_PUBLISH,
EARCHIVE_SPACE, EARCHIVE_FORMAT, EARCHIVE_UNSUPPORTED_CODEC, EARCHIVE_ENCRYPTED
and ECANCELLED. Stderr diagnostics are limited to 8 KiB.

## Validation

`npm test` covers address state/shortcuts, job isolation/cancellation, real ZIP
round trips, ZIP/TAR/TGZ/RAR/RAR5/7z, byte-perfect Copy/LZMA/LZMA2/solid/BCJ
output, encrypted/corrupted/unsafe archives, dictionary rejection, 384 MiB solid
streaming, malicious entries, cleanup and preservation of
existing destinations. Real sidecar tests explicitly skip when it has not been
built. Fixture provenance is in `test/fixtures/archives/README.md`.

Run `cargo test --manifest-path src-tauri/Cargo.toml`. After building the sidecar,
run `cargo test --manifest-path src-tauri/Cargo.toml real_archive_workflow -- --ignored`
for a real Rust backend workflow. UI acceptance uses Tauri. Windows/WNet requires
Windows; actual SMB authentication requires a reachable share. Unit tests do not
establish those OS/network flows.

Both Rust CI jobs (macOS and Windows) build the bundled C worker with CMake,
run real Node archive tests and explicitly run the ignored Rust archive workflow.
A Linux job builds the static worker, inspects dynamic linkage and runs the same
Node archive suite. These workflows exercise extraction formats, Unicode ZIP
creation/extraction/publication, unsafe entries, cancellation and cleanup using
each platform's real executable.
The build recipe also runs five native disk-budget scenarios, including shrinking
available space during streaming, without filling a real disk. A reduced-budget
native allocator test covers accounting, overflow, failed realloc preservation
and refusal/cleanup of a raw LZMA decoder with a UINT32_MAX dictionary.

References: [libarchive formats](https://github.com/libarchive/libarchive/blob/master/README.md),
[extraction flags](https://github.com/libarchive/libarchive/blob/master/libarchive/archive_write_disk.3),
[WNetUseConnectionW](https://learn.microsoft.com/en-us/windows/win32/api/winnetwk/nf-winnetwk-wnetuseconnectionw).
The macOS implementation uses public NetFS/CoreFoundation SDK headers.
