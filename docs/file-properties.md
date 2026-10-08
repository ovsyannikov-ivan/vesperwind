# File Properties

Implementation started from `main`, `19ea6185a5ad85b772135b63d738ab8a564967e3`.
The acceptance observations below are dated 2026-10-08.

## 1. Data contract

The listing contract is unchanged. `filesystem:properties` accepts
`{ filesystemId, path }` and returns `{ ok: true, properties }`.
Properties contain `name`, `path`, `type`, nullable logical `size`, nullable
`createdAt`/`modifiedAt`/`accessedAt`, nullable link `target`, nullable
`permissions`, `permissionsMessage`, and capabilities:
`calculateSize`, `changeMode`, `changeOwner`, `changeGroup`, `preview`.
Existing `contentAvailability` and `cloudSync` are included when available.
Optional `metadataWarnings` keep cloud inspection failures separate from generic metadata.
Types include `file`, `directory`, `symlink`, `alias`, `other` and `unknown`.

`filesystem:update-properties` accepts `{ filesystemId, path, update }`, where
`update` contains only changed `mode`, `uid`, or `gid`. Success returns fresh
properties. Unsupported fields and denied operations remain distinct errors.
The frontend receives the full mode, including file-type bits; its update sends
permission bits only. Both adapters preserve original type and special bits.

## 2. Two-column layout and opening

`PropertiesModal.vue` uses the shared Bootstrap modal header/body/footer,
`modal-xl`, a 1100px width limit, and two equal columns. Small viewports stack
the columns. General/Permissions occupy the left; preview or folder summary
occupies the right. The body can scroll while the footer remains available.
Properties appears for one entry, including navigation-root folders, but not
for `computer://`, panel background menus, or multiple-selection aggregates.
Cmd+I on macOS, Ctrl+I and Alt+Enter on Windows/Linux yield to inputs, editors, menus,
and other dialogs. Tree Enter handling explicitly yields Alt+Enter.

## 3. Preview reuse

Quick Look and Properties share `createPreviewState`/`loadFilePreview` in
`filePreview.js`, and the text/PDF/Office rendering component `FilePreview.vue`.
The existing image media preparation, bounded text reader, PDF.js renderer,
presentation conversion, Word loader and spreadsheet loader are reused.
No nested Quick Look modal, second document renderer, editor tab, write action,
or persistent preview history is introduced.

`PdfViewer` has a compact mode: one current page, no thumbnails or full toolbar,
fit-page state, and bottom Previous/Next buttons with keyboard navigation and
an announced page counter. PPTX-generated PDF bytes use that same renderer.
Audio uses file identity and duration metadata. Video uses the existing bounded
thumbnail service and metadata probe where available. Neither starts playback.
Cloud-only content and failed cloud inspection wait for explicit Load Preview; media preparation then uses
the existing content readiness pipeline. Metadata requests and folder summaries
never call content preparation. Preview errors can be retried independently.

## 4. Folder size and cloud safety

`filesystem:calculate-size` accepts `{ filesystemId, path, jobId }`, acknowledges
the job, and emits `filesystem:size-progress` with
`{ jobId, progress: { bytes, items, errors, cancelled }, done, error? }`.
`filesystem:calculate-size-cancel` accepts `{ jobId }`. The native operation
registry is reused. Listener readiness precedes launch; unrelated job events,
late events, cancellation and backend disconnect cannot replace current state.
Calculation starts only on Calculate and closes with the modal.

Native work runs on blocking workers, not the UI thread. Unix traversal uses
directory descriptors, `readdir`, `fstatat(AT_SYMLINK_NOFOLLOW)` and
`openat(O_DIRECTORY | O_NOFOLLOW)` for child directories. Leaf files are never
opened. Windows uses directory enumeration and no-follow metadata; symbolic
links/junctions are not descended. SFTP uses LSTAT/READDIR attributes and never
opens file content. Links count as entries; targets are not traversed. Sizes are
logical, not allocated disk usage. Inaccessible items retain a partial total
and increment `errors`. Unix depth beyond 256 is reported as partial failure.
Cancellation is cooperative; an in-flight SFTP request remains bounded by the
existing 20-second session timeout.

There are no file-content reads, `content.prepare()` calls, or hydration requests
in the size traversal. Physical iCloud/OneDrive acceptance remains separate from
this implementation and automated evidence.

## 5. Local macOS permissions

Metadata comes from `symlink_metadata`, including filesystem birth time.
UID/GID names use reentrant `getpwuid_r`/`getgrgid_r` with bounded buffers.
Mutation uses native `fchmodat`/`fchownat` with `AT_SYMLINK_NOFOLLOW`; no file
content is opened and no external chmod/chown process or privilege prompt runs.
This also permits an owner to restore mode `000`, which an `O_EVTONLY` open
cannot do without read permission. Symlinks and Finder aliases are read-only.
Finder aliases are identified by metadata and their bookmarks are not resolved.

Only the selected directory is changed. A combined owner/mode update can be
partially successful; errors leave the modal open, reload actual metadata, and
invalidate the affected directory. POSIX chown can clear special bits according
to OS semantics; editing ordinary rwx itself preserves those bits.

## 6. SFTP SETSTAT

The native adapter uses `ssh2::FileStat` and `Sftp::setstat`; the socket adapter
uses the equivalent ssh2 protocol APIs. Mode-only updates send `perm`/`mode`,
with size, timestamps and ownership absent. Ownership updates contain UID/GID
only, unless mode was also changed. SFTP v3 encodes UID/GID as one attribute pair:
when one changes, the unchanged partner is retained explicitly. Otherwise
Rust ssh2 serializes a missing partner as zero. This pair exception does not
copy unrelated attributes from the old stat.
Permission denied, missing entries, unsupported attributes and disconnected
sessions have distinct native errors. A subsequent reload can reconnect through
the existing connection manager; mutations are not silently retried.

## 7. Missing remote attributes

Missing `perm` produces the server-unavailable permissions message and no mode
editor. Present UID/GID remain numeric; absent IDs are shown as not provided.
Ownership editing requires a complete UID/GID pair. If file-type bits are not
provided, the entry is `unknown` and mutations/traversal are read-only because
the adapter cannot safely distinguish a directory, file and link. Created is
always null for the current SFTP v3 backend and is never copied from Modified.

## 8. SFTP is not assumed to be Linux

Remote behavior follows returned attributes and protocol capabilities. There is
no OS detection by provider ID, path shape, home directory, or shell command.
No `uname`, `stat`, `ls`, `chmod`, `chown` or user/group lookup command is used.

## 9. Windows and browser behavior

Native Windows provides generic metadata and real creation/modification times,
file previews, on-demand folder size, and existing passive OneDrive availability
and synchronization metadata. Its permissions are null and mutation capabilities
are false. The UI cannot produce an NTFS-as-POSIX editor.
The browser local backend provides guarded generic metadata and previews. Its
Permissions section is hidden when there are no attributes. SEA currently uses
the same local Node metadata implementation: local permission attributes and
mutations are not implemented, and the empty section is hidden there too.
Actual SFTP attributes remain visible in every runtime. Tauri retains its
platform-specific permissions section, including the Windows security notice.
Local folder size is offered by desktop backends.

## 10. Deliberately deferred security work

No Windows SID enumeration, DACL/SACL/ACE editor, Allow/Deny model, inheritance,
effective access, owner SID mutation, or UAC elevation is implemented. There is
no Explorer Properties launcher. Recursive chmod/chown, POSIX/macOS extended
ACLs, tags, Spotlight comments, xattrs/quarantine and NTFS alternate streams are
also outside this change.

## 11. Automated checks

Frontend coverage includes actual modal/menu/shortcut/layout contracts,
provider metadata, cloud preview gating, permission matrix round trips, octal
validation, special/file-type bits, unsupported/Windows/SFTP models, dirty-draft
Apply, denied writes, metadata refresh races, cancellation/disconnect and sparse
SETSTAT generation. Existing Quick Look, presentation and cloud/audio history
tests exercise the shared pipeline. Modal-style coverage discovers the new modal.

Rust tests cover local `640 → 750`, symlink target protection, a metadata-only
size walk with a cycle, SFTP representation/sparse updates/ownership pairing,
and macOS mode `000 → 640`, directory mutation without child mutation, names,
creation time and denied owner change. The opt-in
`node scripts/properties-native-smoke.mjs <new-output-directory>` runs the real
Tauri AppState on disposable fixtures and saves an `events.json` receipt.

Final checks: `npm test -- --test-concurrency=1` passed all 464 tests;
`npm run build`, `cargo fmt --check` and `git diff --check` passed;
`cargo test` passed 154 tests with 8 existing opt-in tests ignored.
Native/system checks ran outside the filesystem/network sandbox. A final parallel
frontend run timed out in one existing FSEvents watcher test; the full serial
run passed without changing that test. The final native smoke receipt is
`/tmp/vesper-properties-native-20261008-final/events.json`; its binary reports
the `19ea6185a5ad` base commit.

## 12. Acceptance evidence and remaining environments

On macOS, the native smoke finished successfully on 2026-10-08:
metadata, `640 → 750`, symlink read-only state, denied owner change, folder size
(101 bytes, 4 items, 0 errors) and cancellation. The real owner was resolved
through the native POSIX APIs. This is native backend acceptance, not manual
modal acceptance.

Browser UI checks passed for context-menu Properties, Cmd+I on a focused file
row, text preview, and PDF page `1/3 → 2/3` with no thumbnail sidebar. A separate
temporary UI fixture based on native smoke metadata verified matrix-to-octal
editing (`750 → 754`), Apply enablement, and inline denied-Apply behavior. Its
update API was mocked; it is not a native mutation claim.

The updated macOS dev WebView loaded, but subsequent native UI capture failed
with ScreenCaptureKit error `-3811`. Full interactive macOS modal acceptance,
real iCloud cloud-only non-hydration, real SFTP SETSTAT/traversal, and Windows
UI/OneDrive acceptance remain pending. No SFTP credentials or test directory
were supplied. macOS-to-Windows cargo checking stopped in native dependencies
(missing MSVC headers/Windows OpenSSL toolchain) before validating the Windows
build; it is not a passing cross-platform check.
