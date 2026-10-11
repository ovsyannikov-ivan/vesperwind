# Virtual file tree

File panels and the editor sidebar render their tree as one virtual list: all
entries of the expanded folders stay in memory and take part in sorting,
filtering, selection and file operations, but only the rows around the viewport
exist in the DOM. Scrolling changes the view, never the folder data.

## Tree state and rows

`createDirectoryTree` (`src/composables/useDirectoryTree.js`) is the long-lived
state of one tree. `FileTree.vue` creates it, so each panel and each editor
sidebar has its own; there is no global tree.

It keeps, per folder keyed by provider and normalized path, a
`createDirectoryListing` record: children, loading, error, listing generation,
cancellation and lazy cloud status (see [directory listing](directory-listing.md)),
plus the folder's directory watcher. It also keeps the set of expanded folders,
the rename draft and the dragged row.

Each event has its own effect:

| Event | Effect |
|---|---|
| A row scrolls out of the window | None. No request, no watcher change. |
| A folder is collapsed | Its listing, watcher and cloud scan stop. Its contents stay for a quick re-open (at most 64 collapsed folders). Its descendants are released; the owner's `expandedPaths` reopens them with it, as before. |
| The panel is deactivated (`watchActive`) | Requests and watchers stop; data stays. Reactivating refreshes the open folders. |
| The provider or root changes, or the tree unmounts | Everything is released. |

`FileTreeNode.vue` is one row: icon, name, cloud badge, size, date, selection,
the toggle, the rename input, drag source and drop target, context menu and
keys. It owns no folder data, watcher or scan.

## Flat rows

`flattenTree` (`src/utils/flattenTree.js`) walks the root and the expanded,
already loaded folders. Each folder's children come from its own
`transformChildren` result: the panel's name and extension filters on the
top level, and its sort (folders first, then name, size or date) on every
level, exactly as before. Each row has a stable key (the path), the entry,
depth, parent path, expanded state, and `posInSet`/`setSize`. Error, empty
("Empty folder" or "No items match the current filters") and rename-error rows
are rows of the same height. A closed folder only contributes its own row.

The per-folder sorted children are cached computed values. A cloud badge
update writes `contentAvailability`/`cloudSync` on the entry, which neither
sort nor flattening read, so it re-renders only that row.

## Virtual window

`computeVirtualRange` (`src/utils/virtualRange.js`) uses the fixed row height
(`--file-tree-row-height`, 22 px):

```
top    = scrollTop + stickyHeaderHeight - listOffset
bottom = scrollTop + viewportHeight     - listOffset
first  = floor(top / rowHeight),  last = ceil(bottom / rowHeight) - 1
rows   = [first - 12, last + 12]   (clamped to the row count)
```

`createVirtualViewport` finds the scroll container (`.panel-content` or
`.editor-tree-content`), reads its `scrollTop` at most once per animation
frame (a 100 ms timer covers windows that get no frames), and measures the
list offset, viewport height and sticky column header only on attach, resize
and when the row count changes. Two `aria-hidden` spacers above and below the
mounted rows keep the full scroll height, so the scrollbar and both panels'
independent scrolling behave as before. There is no size threshold: the
windowed renderer is used for every folder, since it was as fast or faster at
100 entries.

`revealPath` scrolls to a row by index, waits for it to mount, and optionally
focuses it. It is used for keyboard navigation, rename requests and the editor
sidebar's "scroll the active file into view".

## Selection, Quick Look and operations

`FileTree.visibleEntries()` returns every entry of the flat tree below the root
in display order, mounted or not. `FilePanel` uses it for Shift/Cmd/Ctrl
selection, Quick Look siblings and Properties, so a Shift-click from the first
to the 1500th file selects 1500 entries. Opening a file passes its folder's
displayed entries as siblings and the context menu its folder's entries, both
from the tree state. Drag payloads still carry the panel's selected entries;
drop targets and their data attributes are unchanged, and the dragged row is
remembered in the tree state while it scrolls.

## Rename

The draft, caret and error live in the tree state. F2 or the context menu on an
entry that is not mounted scrolls to it and starts the rename there. If the row
scrolls away, the rename continues; when it comes back, the input shows the
draft and caret and takes focus again. A blur caused by unmounting is ignored;
a real blur, Escape or selecting another entry ends it, as before. This keeps
the virtual range simple (no pinned row) while never losing typed text.

## Keyboard and accessibility

The list is `role="tree"`; each row is a `treeitem` with `aria-level`,
`aria-expanded` (folders), `aria-selected`, `aria-posinset` and
`aria-setsize`. Spacers are `role="none"`. Only the active row is a tab stop.
Arrow Up/Down, Home, End and Page Up/Down move the selection through the
logical tree (Shift extends it), scrolling to and focusing rows that were not
mounted; Enter, F2 and Arrow Left/Right keep their behaviour.

## Cloud status

Cloud status stays in the folder records. Each batch is chosen when it is sent:
the folder's entries ordered by distance from the middle of the viewport, then
the rest. Scrolling into the middle of a large folder therefore inspects those
rows next, without restarting the scan or re-inspecting resolved files.

## Measurements

Chromium (built-in browser pane), Vite development build, Node backend,
1280×800 window, Mac mini M4. Opening a folder by double-click in the left panel.

| Entries | DOM rows before → after | Render and layout before → after | Click to rows before → after |
|---|---|---|---|
| 100 | 101 → 39 | 27 → 9 ms | 47 → 14 ms |
| 500 | 501 → 39 | 64 → 11 ms | 90 → 25 ms |
| 1,000 | 1,001 → 39 | 120 → 14 ms | 155 → 51 ms |
| 3,000 | 3,001 → 39 | 271 → 23 ms | 334 → 71 ms |
| 10,000 | 10,001 → 39 | 931 → 49 ms | 1,060 → 188 ms |
| 30,000 | 30,001 → 39 | 2,840 → 142 ms | 3,195 → 453 ms |

At the top of a folder 39 rows are mounted; while scrolling it is 51
(27 visible plus 12 on each side), for 3,000 and 30,000 entries alike.

Data work on synthetic entries: filtering `*.pdf` took 1.9 / 3.8 / 10.3 /
17.8 ms for 3,000 / 10,000 / 30,000 / 50,000 entries; sorting by name took
1.2 / 5.4 / 9.9 ms for 3,000 / 30,000 / 50,000 entries with the shared
`Intl.Collator` (6.4 / 47 / 81 ms with `localeCompare` before); by size or
date at most 11.5 ms; flattening 0.3 /
0.7 / 2.3 / 4.2 ms; a thousand range computations under 0.1 ms. A scroll
update (Vue patch and layout) took about 1 ms per wheel step and 4 ms
(p95 7 ms) for a jump that replaces every mounted row, at 3,000 and 30,000
entries alike. For very large folders the remaining time is the backend
listing and the panel's own work on all entries (selection pruning, the
extension list), not the DOM.
