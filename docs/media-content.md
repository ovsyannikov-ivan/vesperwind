# Media content availability and directory refresh

## OneDrive on native Windows

Cloud status arrives after the listing, in background batches (see
[directory listing](directory-listing.md)); the listing itself carries none.
Native Windows statuses keep availability separate from synchronization:
`contentAvailability: {state: "cloud", provider: "onedrive"}` can coexist with
`cloudSync: {provider: "onedrive", state: "inSync", localContent: "notFullyLocal",
inspection: "ok", pinPolicy: "unpinned"}`. Download completion removes the
cloud indicator, replacing it with a locally available check when local content
and synchronization are confirmed. Availability and sync remain separate metadata
facts, summarized by one icon with both facts in its tooltip.
`notInSync` means the provider has not marked the placeholder synchronized; it
does not assert an active upload or remote durability. Pin policy is metadata,
not evidence of completed download. The Windows filled green circle requires
confirmed local content, IN_SYNC and pinned policy; the outlined green check
requires confirmed local content and IN_SYNC without pinned policy.

All cloud indicators occupy one narrow status column immediately before Size.
Compact trees put the same single indicator at the right edge. Windows uses a
blue cloud for unavailable local content, green availability checks, neutral
clocks for unconfirmed readiness/sync and arrows only for a tracked download.
These are not upload or remote durability guarantees. iCloud indicators remain
monochrome, smaller and muted. The symbolic-link badge retains its size and color;
the main file icon's centering explicitly overrides Bootstrap's `icon-link` flex
alignment so shortcut icons align with other file types.

The adapter uses registered roots from `StorageProviderSyncRootManager` (the
documented `provider!SID!account` ID), then verifies Cloud Files membership with
`CfGetSyncRootInfoByPath`. It supports multiple registered personal/business
roots without matching filenames or folder names. Unknown registration,
unsupported providers and ordinary non-placeholder files receive no cloud claims.

Windows enumeration reuses Unicode `WIN32_FIND_DATAW` attributes and reparse tags
with `CfGetPlaceholderStateFromAttributeTag`. Windows may disguise placeholders
for applications: a thread-bound RAII guard temporarily uses the documented
`RtlSetThreadPlaceholderCompatibilityMode(PHCM_EXPOSE_PLACEHOLDERS)` and restores
the previous mode. Status inspection never reads content or requests hydration,
and uses one registration snapshot/root query and one enumeration per batch
rather than per-row handles.

`PARTIALLY_ON_DISK` proves content is not fully local. `PARTIAL` alone produces
`contentAvailability.state = "notReady"` and unknown local byte availability,
without claiming a download is active. Invalid flags or a confirmed root's
inspection error cannot produce a synchronized check. Only an operation already
tracked by the existing content manager may supply `materializing` in a status.

Explicit preparation requests the whole file with asynchronous
`CfHydratePlaceholder(0, CF_EOF)`. The existing content manager owns the stable
overlapped storage/handle, checks completion and errors, and cancels/drains only
its own request on teardown. Direct guarded reads/copies can wait for this same
preparation. Metadata on-disk size is an activity marker; no download percentage
is guessed. Existing watchers and the one shared refresh after MATERIALIZING to
READY update both panels; there is no directory or per-row polling loop.

Windows 11 acceptance used disposable text and 16 MiB binary fixtures in one
registered personal OneDrive root. Native checks verified downloaded/in-sync,
unpinned online-only plus IN_SYNC, passive listing without hydration, explicit
whole-file preparation with byte verification, cancellation/retry, a local edit
clearing IN_SYNC, and pinned policy independent of sync. Both downloads produced
native watcher events. Two-entry metadata inspection took about 5–6 ms; this is
fixture evidence, not a large-directory performance guarantee. Business roots
and PARTIAL-only/error combinations have synthetic coverage, not live account
acceptance. FileTreeNode layout was checked in both themes, compact mode and
columns, including independent availability/sync facts in the tooltip, selection
and 22px row height.
An isolated native Tauri incognito profile also verified both panels displaying
online-only plus IN_SYNC, explicit Quick Look opening through preparation to
READY, and shared watch/targeted refresh removing the cloud badge in both panels.
The disposable profile did not change the user's settings or WebView storage.

Opt-in native diagnostics are ignored tests:
`diagnose_registered_roots_and_passive_listing` reads
`VESPERWIND_DIAGNOSE_LIST_DIRECTORY`; `diagnose_synthetic_preparation` requires
`VESPERWIND_ONEDRIVE_FIXTURE_FILE` and restricts active tests to `small.txt` or
`large.bin` under a disposable `vesperwind-availability-*` directory.
`VESPERWIND_ONEDRIVE_CANCEL_FIRST` tests cancellation/retry, and
`VESPERWIND_ONEDRIVE_MODIFY_FIXTURE` modifies only the disposable text fixture.
Keep paths, logs and machine-specific reports under ignored `target/local-checks`.

See Microsoft's [placeholder states](https://learn.microsoft.com/windows/win32/api/cfapi/ne-cfapi-cf_placeholder_state),
[sync root IDs](https://learn.microsoft.com/uwp/api/windows.storage.provider.storageprovidersyncrootinfo.id),
[placeholder compatibility mode](https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-rtlsetthreadplaceholdercompatibilitymode),
and [hydration API](https://learn.microsoft.com/windows/win32/api/cfapi/nf-cfapi-cfhydrateplaceholder).
The macOS/iCloud contract below is preserved; this Windows run is not native Mac acceptance.

## iCloud badges in file panels

Native macOS lazy cloud status (see [directory listing](directory-listing.md))
provides optional `contentAvailability` metadata:
`{"state":"cloud"}`, `{"state":"materializing","progress":0.42}`, or
`{"state":"failed"}`. Ready files omit the field. A small muted cloud download
icon in the status column means content is absent locally; cloud sync indicates an active download,
and cloud alert indicates a download or inspection failure. Progress appears only
when Foundation supplies a finite value. The main file-type icon stays intact.

Status inspection is passive: it inspects filesystem metadata and public Foundation resource
values, never content bytes, download requests or coordinated reads. `SF_DATALESS`
and iCloud `NotDownloaded` provide absence evidence; iCloud membership alone does
not. `Current` and `Downloaded` without dataless mean a local copy exists.
Additional cloud resource lookups are limited to ubiquitous/dataless candidates
and use one Foundation request per file; inspection runs on native blocking
workers after the rows are shown, never on the UI thread.

Both status inspection and existing content preparation share the same metadata decision
logic in `filesystem/availability.rs`. Explicit open/read/copy can still initiate
materialization through the existing preparation flow. Dataless Finder aliases are
listed as aliases without resolving their unavailable bookmark content; local
aliases and symlinks keep their existing target semantics.

Visible local directories already watch FSEvents metadata/content changes. A watch
event or normal manual refresh replaces entries and inspects their status again;
unchanged entries keep their previous badge until the new result arrives.
After `content.prepare` transitions from MATERIALIZING to READY, it also invalidates
the parent through the shared directory watch registry: NSURL state may settle
after the last FSEvents notification. This single coalesced refresh removes stale
badges in panels and compact editor trees. There is no per-row polling. Foundation
keys may be missing: dataless remains strong fallback evidence, while ambiguous
ubiquitous metadata without dataless produces no badge (unknown, not verified ready).
An inspection error without absence evidence displays the alert badge. This
section describes macOS/iCloud; native Windows OneDrive support is described
below. Linux, SFTP and browser/Node listings omit cloud metadata and do not infer
it from names or paths.

For opt-in passive native diagnostics, run the ignored
`diagnose_passive_directory_listing` Rust test with
`VESPERWIND_DIAGNOSE_LIST_DIRECTORY` set to a real directory. It checks that listing
does not change flags/allocated blocks. Ordinary CI uses synthetic cloud metadata
and needs no iCloud account. Manual acceptance additionally uses Finder Remove
Download and Vesperwind open, on small and larger files, verifying unchanged
cloud-only state during browsing and normal watch refresh after downloading.

Manual macOS acceptance on 2026-10-08 used the actual debug `.app` WebView,
Finder Remove Download, a 66-byte text file and a 64 MiB WAV fixture. Both remained
dataless during browsing, showed cloud → materializing → no badge when opened,
and opened successfully through the editor/Quick Look. Completion refresh cleared
the badge in the compact sidebar and both panels without manual navigation.
Finder and filesystem flags confirmed materialization. Foundation reported no
percentage, so no percentage appeared. Row height remained 22px in both themes.
The regression WebView used an isolated identifier/incognito profile; its theme
was restored to System after the light-theme check.

Passive listing, which then included status inspection, measured 480–523ms for
3,000 ordinary local files and 669ms for a real iCloud directory with 427 entries
(384 cloud badges). The latter check also verified unchanged flags/allocated
blocks. Listing no longer waits for status; current measurements are in
[directory listing](directory-listing.md). Windows cross-compilation from
this Mac stopped in vendored OpenSSL configuration; a native Windows build
remains unverified. New native listing fields and Foundation helpers are gated
by macOS `cfg`; portable synthetic decision tests do not need an iCloud account.

Provider-backed audio uses `media.ensureMediaContentReady` through the shared
`media.prepare` operation before either native mpv or the web player starts.
Native audio needs readable local bytes even though it needs no browser URL.
Only a terminal READY response publishes a player source. URL/live media bypasses
local content preparation; remote providers retain their existing streaming path.

Quick Look retains its dialog with Preparing file… and progress while materializing;
the player is mounted after readiness. Closing invalidates the request and cancels
its content operation, including an operation ID returned after cancellation.
Persistent audio retains the queue/current item with the same preparing state.
Switching/retrying invalidates older requests; failures remain recoverable and
cannot create a player with an unavailable source. Cancellation stops Vesperwind's
preparation/polling; an OS-owned iCloud download may continue independently.
History policy is separate from availability; see [media history](media-history.md).

Directory consumers have independent listing generations keyed by provider and
normalized logical path. Refresh, path/provider change, collapse, deactivation
and disposal invalidate older requests. A response only updates the consumer
that requested it while its identity/generation is still current. Refresh errors
retain successful contents and show status without hiding those entries. Selection
reconciliation runs only for accepted current listings. Shared directory watching
keeps one native subscription while either panel consumes it and coalesces bursts.

Empty folder requires a successful current listing with genuinely zero entries.
Hidden-name and panel filters retain the raw listing count; filtering all entries
shows No items match the current filters instead. Panel root restoration and listing
callbacks also verify provider/path ownership.

For opt-in native diagnostics, set `window.__VESPERWIND_MEDIA_TRACE__` to a callback.
It receives directory events, consumer/provider/path/revision, response/raw/visible
counts and whether a response was accepted. Thumbnail traces separately record
dwell, native result, detached Image load/decode, publication and rendered image
load. Normal operation emits no trace. Sidecar failures retain native diagnostics.

## Native regression harness

Build a debug macOS bundle and run its actual main/overlay WebViews:

```sh
npm run build:tauri -- --debug --bundles app
node scripts/media-native-smoke.mjs
```

The runner creates its own temporary media directory, settings and history database.
It opens video through double click, Space and View, checks dwell/image decoding,
stationary controls hover and leave/re-entry, and verifies persistent audiobook
resume versus temporary Quick Look. Optional arguments after a new output-directory
path select two existing ordinary music files for cloud preparation checks; verify
their cloud-only state beforehand. The runner does not evict or remove those files.
It checks both panels and records directory event/listing identities and counts.
Raw diagnostics stay in the temporary output directory, outside tracked docs.

`VESPERWIND_NATIVE_BINARY` may select another debug bundle executable. If a test
executor cannot foreground its WebViews, `VESPERWIND_MEDIA_ALLOW_HIDDEN_FRAMES=1`
explicitly supplies a test-only animation clock while the document is hidden.
Results record this setting. Such a run verifies the native extraction, WebView
and Vue delivery path, but physical pointer/foreground presentation still requires
manual acceptance. The driver and isolated profile hooks are absent in release builds.
