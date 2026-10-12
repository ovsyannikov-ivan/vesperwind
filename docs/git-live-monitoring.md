# Read-only Git viewing and live monitoring

Git roots have a small action in the tree's right-hand status column, shared
with cloud status badges, and in the current folder header. Both file panels
and the editor sidebar use the same FileTree discovery. Only local providers
are eligible. A loaded directory's direct child folders and the directory
itself are checked in batches of at most 256. `.git` directories and pointer
files are supported; no ancestor search or filesystem-wide discovery is used.
Listings render first; asynchronous results update the existing entry objects
only while that exact listing is current. Virtual rows perform no discovery.
The Git action uses a 13px icon and a 20 × 20px button.

A Git tab is an independent workspace type, identified by the canonical
working-tree path. Opening it shows the editor even when no document is open;
opening the same worktree again activates its tab. Linked worktrees have
separate identities. Git tabs have no editable content, dirty state, document
handler, serialization, Save or Save As operation. Normal filesystem
navigation remains unrestricted by a project root.

## Backends and contracts

`src/api/git.js` and `src/api/gitWatch.js` retain the runtime transport boundary.
Requests use `filesystemId: local` and an explicit repository `path` (discovery
uses `paths`). Read operations are `git:detect`, `status`, `branches`, `log`,
`commit` and `diff`; subscription lifetime uses `git:watch`/`unwatch` and the
`git:changed` event. Responses use `{ ok, error }` consistently across runtimes.
Repository identity includes `id`, `path`, `name`, `gitDir`, and `commonDir`.
Changed files include relative `path`, optional `oldPath`, `scope`, `status`,
`additions`, `deletions`, and binary/size indicators.

Tauri uses `git2` with vendored libgit2, with network transports disabled. No
Git executable is required. Node/browser/SEA uses an installed `git` executable
through bounded `execFile` calls, never a shell. Optional Git locks, external
diffs, text conversion, filesystem monitor helpers, lazy fetching and protocol
access are disabled. Missing Git returns `EGIT_DEPENDENCY`. On macOS the Node
adapter uses `/usr/bin/stat` for passive cloud flags; on Windows it requires
PowerShell for passive Offline/Recall attribute checks. No Git mutation,
credential management or remote-provider Git operation is exposed.

The viewer uses `@git-diff-view/vue` with its pure CSS stylesheet. The selected
commit's files form a vertical accordion beside the commit history. Working
Changes uses the same full-width list. Every file has its own status, counts
and collapse control; selecting each file separately is unnecessary. Small
patches load automatically within 300px of the viewport. Diffs with at least
400 changed lines show `Load diff`; actual patches over 128 KiB or 800 lines
also require explicit loading. Offscreen diff tables are released, retaining
their measured height so scrolling remains stable. Cached patches are bounded
to 32 files / 8 MiB, excluding currently visible sections.
Split/Unified mode, syntax colors, light/dark theme events and per-file collapse
state are retained independently of status refreshes. Working Changes
distinguishes HEAD → Index (staged),
Index → Worktree (unstaged), and untracked additions. History is paginated in
pages of at most 100 and compares commits with their first parent; initial
commits compare with the empty tree. Merge parents remain visible in metadata.
Empty repositories, detached HEAD, renames, deletions, binary content and
missing repositories have explicit empty/error states.

## Watch lifetime and recovery

The frontend registry owns one serialized backend subscription per canonical
working tree. Opening a Git tab creates its viewer state and subscription;
hiding or switching tabs keeps them alive. Closing the final consumer queues
unwatch after any pending watch request and disposes the viewer. Node sockets
also release every subscription on disconnect. Native watchers stop and drop
their notify handles after the worker observes cancellation (within its 100ms
receive cycle); application shutdown releases the registry.

A dedicated service watches local working-tree directories and resolved Git
administration directories, including common refs/logs outside linked worktrees.
It uses non-recursive OS handles with a bounded topology walk to cover nested
changes while pruning ignored directories, nested repositories and symlink
trees. Tracked paths remain eligible even when new ignore rules match them.
Immutable Git object directories are not watched recursively. Repository
metadata and worktree content are checked passively before reads; unavailable
cloud content is refused instead of downloaded. Watch topology only inspects
directory metadata and ignore files, never worktree file bytes.

Events are coalesced for 180ms in the backend and 120ms in the frontend; bursts
cannot postpone an update indefinitely. Node constructor options configure the
interval and directory budget; native constants define the same defaults.
Async generations reject obsolete status, commit selection and patch results;
only one metadata refresh and at most two file diff requests run at a time.
Only expanded sections near the viewport request patches; offscreen working
changes remain stale until revisited. Status updates refresh branch/HEAD/change lists. History
is reloaded after HEAD changes or recovery, and historical file diffs stay
selected while new commits appear. Accordion refreshes preserve a logical file
anchor and its viewport offset; saved scroll contexts are bounded.

Foreground/visibility return and reconnection restore subscriptions and refresh
current metadata. While subscribed, a 30-second recovery cycle repairs missed
watch events and topology failures. This is a recovery fallback, not the source
of normal live updates. The indicator reports Live, Updating or watcher error;
it does not infer which external application wrote a file.

## Bounds and remaining validation

A worktree has a budget of 2,048 non-ignored directories plus at most 256 Git
metadata directories; at most 16 repositories are watched by a backend at once.
Budget exhaustion is reported. Worktree content preflight and Git object
metadata inspection each cap their inventory at 100,000 entries. Repositories
beyond these inspection bounds fail explicitly. Metadata inspection adds IO on
large repositories; it is needed to protect cloud placeholders before libgit2
or the CLI reads content. Ignored build/dependency directories are pruned.
Patches are limited to 1 MiB; native input files above 1 MiB are also treated as
oversized. Binary files are listed without rendering their content. Node Git
command output is bounded to 8 MiB, with a 12-second process deadline.

Symbolic Git administration paths, object alternates and unavailable cloud
content are rejected; the supported `.git` pointer-file mechanism
is distinct from a symbolic link. Physical iCloud/OneDrive acceptance and
Windows/Linux native/WebView CI are separate from local macOS verification.

Automated coverage is in `test/git.test.js`, the existing virtual-tree tests,
and `src-tauri/src/git.rs` tests. macOS verification uses real Node fs.watch
and native notify, as sandboxed macOS filesystem watcher creation can fail.
The native QA app verifies empty-editor opening, two independent Git tabs,
deduplication, external saved edits, commit/branch changes preserving an old
historical selection, and light/dark diff rendering.
