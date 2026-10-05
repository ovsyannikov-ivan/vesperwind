# Media content availability and directory refresh

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
