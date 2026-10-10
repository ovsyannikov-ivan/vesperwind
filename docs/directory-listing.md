# Local directory listing and lazy cloud status

Opening a local folder shows its rows as soon as the folder itself is
enumerated. iCloud and OneDrive status is inspected afterwards, in small
background batches, and fills the existing status column row by row.

## Fast listing

`filesystem:list` (`Filesystem::list_directory`) returns name, path, type,
`isDirectory`, `isSymbolicLink`, size, `modifiedAt` and `metadataError`, sorted
folders first and then by name. It never inspects cloud metadata: local entries
carry no `contentAvailability` or `cloudSync`.

The folder is resolved and verified inside the configured root once. Each plain
child of that canonical folder is already its own real path, so it needs only
`symlink_metadata` and, for regular files on macOS, the Finder Alias check.
Symlinks and Finder Aliases are resolved one level with
`verify_child_inside_root`, which keeps the root containment rule of
`verify_existing_inside_root`. A dataless Finder Alias is listed as the alias
itself, without reading its bookmark.

On Windows the folder is enumerated once with `FindFirstFileW` under the
placeholder exposure guard. Sync-root registration is no longer queried while
listing.

A missing status means "not inspected yet" or "nothing to show". It is never a
claim that content is local: reading, opening and copying still go through
`content.prepare()`.

## Lazy cloud status

`filesystem:cloud-status` (`filesystem_cloud_status`) takes a request ID, the
listed folder and up to 256 entry paths, and returns one status per path:
`{path, modifiedAt?, contentAvailability?, cloudSync?, error?}`. Every path must
be a direct child of the folder; anything else gets a per-entry `EINVAL`, and a
folder outside the root fails the request. One entry's error (for example a file
deleted during the scan) never fails the batch or the folder.

Inspection is passive on both platforms: metadata only, no content reads, no
`startDownloadingUbiquitousItem`, no hydration, no coordinated read and no
attribute changes.

- macOS inspects each file with the existing `inspect_content_availability`
  (`SF_DATALESS`, ubiquity, Foundation download keys). The iCloud keys are fetched
  with one `resourceValuesForKeys` request; if that fails, the key-by-key path
  keeps partial evidence as before. Symlinks and aliases are inspected at the
  same target the listing used.
- Windows takes one registered-roots snapshot (cached for 10 s) and one
  `CfGetSyncRootInfoByPath` membership query per batch. Outside every OneDrive
  root the response has `complete: true` and the frontend skips the remaining
  batches. Inside a root, one enumeration supplies the `WIN32_FIND_DATAW` facts
  for the whole batch, classified exactly as before (placeholder, partial,
  partially on disk, pin policy, IN_SYNC, invalid, inspection error).
  `ContentManager::annotate_cloud_status` marks files with an active hydration as
  materializing, as listings did before.

At most two batches run at once across all panels and windows. Cancellation
(`filesystem:cloud-status-cancel`) is checked between entries; a single OS call
is not interrupted. The commands only exist in the desktop app, which reports the
`cloudStatus` runtime capability on macOS and Windows. Browser, SEA, SFTP, FTP and
FTPS never request or receive cloud status.

## Frontend

`createDirectoryListing` applies a listing as before (one `children-loaded`, one
selection reconcile) and then starts a scan bound to that listing generation:

- files only, the displayed (sorted and filtered) rows first, then the rest;
- batches of 64 after the next paint (or a 200 ms fallback when a hidden window
  gets no animation frames), at most two batches in flight across all trees;
- each result is written onto the existing entry object (`contentAvailability`,
  `cloudSync`), so the children array, Vue keys, sort order, selection, scroll,
  expanded folders, rename and drag state are untouched;
- each path is `pending`, `resolved` or `failed` for the generation. An empty
  status is a final result and nothing is re-requested in the same listing.

Any new load, watcher refresh, collapse, provider or path change, deactivation
and unmount abort the scan and send a native cancel. A late batch is ignored
unless its generation, folder identity and entry are still current, and a status
whose inspected `modifiedAt` differs from the row is not applied. Collapsed
subfolders are never scanned. Two panels on the same folder scan independently.

A refresh keeps the status of entries whose modification time, size and type are
unchanged until they are re-inspected, so badges do not blink on every watcher
event. Changed entries start without a status. There is no status cache, no
polling, and inspection does not emit `filesystem:changed`; real hydration still
updates rows through the existing watcher and content lifecycle.

## Diagnostics

`VESPERWIND_LISTING_TRACE=1` prints one `[listing]` line per local listing and
one `[cloud-status]` line per batch to the native log. The frontend's existing
`window.__VESPERWIND_MEDIA_TRACE__` hook also receives `directory.status-start`,
`directory.status-batch` and `directory.status-error`. Normal runs emit neither.

Ignored Rust tests break the cost down: `listing_profile` (synthetic 100–3000
files, or `VESPERWIND_LISTING_PROFILE_DIRS`), `icloud_key_profile`,
`batched_passive_metadata_matches_per_key_queries` and
`diagnose_passive_directory_listing` (both with `VESPERWIND_DIAGNOSE_LIST_DIRECTORY`).

## Measurements

macOS 27.0.1, Mac mini M4, 16 GB, APFS, debug builds. Medians of five runs.

| Folder | Listing before | Listing after | Cloud status, in background |
|---|---|---|---|
| 100 local files | 9.5 ms | 1.4 ms | 2.8 ms |
| 500 local files | 46.9 ms | 6.6 ms | 14.0 ms |
| 1000 local files | 92.6 ms | 13.5 ms | 28.8 ms |
| 3000 local files | 283.2 ms | 41.1 ms | 84.6 ms |
| iCloud, 207 entries, 202 cloud-only | 444.0 ms | 4.9 ms | 419 → 157 ms |

Before the change, `verify_existing_inside_root` per entry (alias resolution of
every path component plus `canonicalize`) was about two thirds of a local
listing, and per-file Foundation keys were about 95% of the iCloud listing. In
the debug Tauri app with both panels on the folder, `filesystem_list` took
536 ms → 12 ms for the iCloud folder and 328 ms → 37 ms for 3000 local files.

Rendering is now the main cost of very large folders: in a Vite development
build, Vue created and laid out 100, 500, 1000 and 3000 rows in about 30, 89,
165 and 539 ms after the response arrived (Chromium, no virtualization).
Production builds are faster; WKWebView was not measured separately.
