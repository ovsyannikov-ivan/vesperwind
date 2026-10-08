# Media content availability and directory refresh

## iCloud badges in file panels

Native macOS local listings expose optional `contentAvailability` metadata:
`{"state":"cloud"}`, `{"state":"materializing","progress":0.42}`, or
`{"state":"failed"}`. Ready files omit the field. A cloud download icon beside
the name means content is absent locally; cloud sync indicates an active download,
and cloud alert indicates a download or inspection failure. Progress appears only
when Foundation supplies a finite value. The main file-type icon stays intact.

Listing is passive: it inspects filesystem metadata and public Foundation resource
values, never content bytes, download requests or coordinated reads. `SF_DATALESS`
and iCloud `NotDownloaded` provide absence evidence; iCloud membership alone does
not. `Current` and `Downloaded` without dataless mean a local copy exists.
Additional cloud resource lookups are limited to ubiquitous/dataless candidates;
listing runs on the native blocking worker rather than the UI thread.

Both listing and existing content preparation share the same metadata decision
logic in `filesystem/availability.rs`. Explicit open/read/copy can still initiate
materialization through the existing preparation flow. Dataless Finder aliases are
listed as aliases without resolving their unavailable bookmark content; local
aliases and symlinks keep their existing target semantics.

Visible local directories already watch FSEvents metadata/content changes. A watch
event or normal manual refresh replaces entries with newly inspected availability.
After `content.prepare` transitions from MATERIALIZING to READY, it also invalidates
the parent through the shared directory watch registry: NSURL state may settle
after the last FSEvents notification. This single coalesced refresh removes stale
badges in panels and compact editor trees. There is no per-row polling. Foundation
keys may be missing: dataless remains strong fallback evidence, while ambiguous
ubiquitous metadata without dataless produces no badge (unknown, not verified ready).
An inspection error without absence evidence displays the alert badge. This is
currently macOS/iCloud-specific; Windows, Linux, SFTP and browser/Node listings
omit availability and do not infer it from names or paths.

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

Passive listing measured 480–523ms for 3,000 ordinary local files and 669ms for
a real iCloud directory with 427 entries (384 cloud badges). The latter check
also verified unchanged flags/allocated blocks. Windows cross-compilation from
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
