# Windows 11: OneDrive availability and sync status

This is the handoff for a new Codex task running natively on Windows 11 in
`C:\Dev\vesperwind`. The user requested OneDrive support using public Cloud Files
API and `IN_SYNC`, following the macOS/iCloud file-panel implementation shipped
with this document. OneDrive implementation has not started on the Mac.

## Start from current main

In PowerShell, inspect the checkout before updating it:

```powershell
Set-Location C:\Dev\vesperwind
git status --short
git branch --show-current
git pull --ff-only
git log -3 --oneline
```

Preserve local changes. If the checkout is not on main or fast-forward fails,
diagnose it without resetting or discarding work. Read `AGENTS.md`, then inspect
the actual code. Propose a concrete plan and file list before material changes,
following the user's established review preference.

## Existing implementation to preserve

- `src-tauri/src/filesystem/availability.rs`: shared macOS metadata classifier,
  passive inspection, active content preparation, download/coordinator fallback.
- `src-tauri/src/filesystem/mod.rs`: `FileEntry` and local directory listing.
  Since Stage F the listing carries no cloud fields; `filesystem/cloud_status.rs`
  and `filesystem_cloud_status` return `contentAvailability`/`cloudSync` in
  background batches after the rows are shown (see `docs/directory-listing.md`).
  OneDrive classification now runs in `onedrive::native::cloud_status`, still from
  one `FindFirstFileW` enumeration and one sync-root snapshot per batch.
- `src-tauri/src/commands/filesystem.rs`: listing and status batches use
  `spawn_blocking`, keeping metadata work off the UI thread.
- `src/utils/contentAvailability.js`, `src/components/FileTreeNode.vue`,
  `src/styles/main/_file-tree.scss`: small status badge beside the filename,
  preserving the main file icon, symbolic-link badge, columns and 22px row height.
  Current tooltip text explicitly names iCloud; do not reuse that text for OneDrive.
- `src/api/content.js`, `src/api/directoryWatch.js`,
  `src/utils/directoryListing.js`: existing preparation and shared directory refresh.
  A MATERIALIZING-to-READY transition requests one parent-directory refresh because
  provider state can settle after the last OS filesystem notification.
- `docs/media-content.md`: semantics and actual macOS acceptance evidence.
- `docs/build-windows.md`, `src-tauri/Cargo.toml`: Windows prerequisites and bindings.

Keep display/inspection separate from operations that prepare file content.
Keep Vue behind the existing API/transport boundary. Do not add a parallel listing,
materialization manager, provider polling loop, or direct Tauri invokes in components.

## Windows task

1. First build/test the current main on real Windows and report native Rust warnings.
   macOS passed 444 frontend tests, 145 Rust tests, formatting, native build and
   iCloud acceptance. A Windows cross-check on the Mac stopped in vendored OpenSSL
   configuration, so it is not Windows acceptance. Inspect prerequisites, including
   MSVC/Windows SDK and Strawberry Perl, before interpreting build failures.
2. Research and use public Cloud Files API metadata, starting with
   `CfGetPlaceholderStateFromFindData` or `CfGetPlaceholderStateFromAttributeTag`.
   Reuse enumeration metadata and native fast paths where possible; avoid opening
   content or triggering hydration to discover status. Do not shell out per entry.
3. Keep local byte availability and cloud synchronization as separate facts.
   `CF_PLACEHOLDER_STATE_IN_SYNC` is the provider's synchronization evidence; it
   does not prove bytes are locally available and can coexist with a placeholder.
   `PARTIALLY_ON_DISK` means content is not fully present locally. `PARTIAL` alone
   can also mean downloaded content awaiting provider validation; do not equate
   that flag alone with physically absent bytes. Pinned policy is not, by itself,
   proof of completed download. Preserve unknown/unsupported/error distinctions.
4. Detect an actual supported OneDrive sync root/provider through documented
   Windows APIs. Do not infer synchronization merely from the filename, folder
   name, zero allocated size, or a path containing "OneDrive". Handle multiple
   personal/business roots. Other providers are outside this task's scope.
5. Extend the existing representation carefully after reviewing current contracts.
   Show an unobtrusive cloud status for unavailable local content and a distinct
   synchronized marker where supported. Explorer's outlined green check means
   locally available; its filled green circle means "Always keep on this device".
   These meanings must not be collapsed into a single guessed "uploaded" state.
   Do not claim remote durability or reproduce every Explorer icon without evidence.
6. Reuse MDI and shared row styling. Preserve compact mode, columns, theme/selection,
   cut/drop states and accessibility. Native Windows labels should name OneDrive.
   Ordinary files, Node/browser mode, Linux and SFTP must not gain fabricated states.
7. Gate OS APIs, imports, fields and helpers with appropriate platform cfg so the
   feature compiles cleanly on Windows and macOS. Preserve iCloud semantics and the
   existing editor/PDF/Office/media/thumbnail/copy preparation paths.
8. Refresh through existing watchers and targeted invalidation when justified by
   real acceptance. No per-row timers or polling of every open directory.

## Tests and acceptance

Use synthetic metadata decision tests in CI: ordinary file, online-only placeholder,
partial content, fully local content, in-sync and not-in-sync states, pinned policy,
unsupported provider and inspection error. Test combinations, including in-sync
content that is still absent locally and PARTIAL without proven absence. Test
serialization and provider-specific presentation without a real OneDrive account.

On real Windows with OneDrive, use disposable synthetic fixtures and Explorer:
fully downloaded file, Free up space/online-only file, browsing without hydration,
explicit open and download completion, locally modified/pending sync, and in-sync
after OneDrive finishes. Test a small text/document and a larger file, both panels,
compact mode and normal refresh. Record which facts the API actually reports and
which remain unknown. Preserve existing user files and settings during acceptance.

Run `npm test`, `npm run build`, `cargo fmt --check`, `cargo test`, relevant native
Windows compilation with warnings treated as errors, and the requested Windows
artifact build. Check `git diff --check`, `git status --short`, `git diff --stat`.
Distinguish native Windows evidence, CI evidence and unverified macOS behavior.
Update concise documentation and report API/model/refresh/performance limitations.

## Primary references

- [Cloud Files placeholder states](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ne-cfapi-cf_placeholder_state)
- [CfGetPlaceholderStateFromFindData](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfgetplaceholderstatefromfinddata)
- [OneDrive icon meanings](https://support.microsoft.com/en-us/onedrive/what-do-the-onedrive-icons-mean)
