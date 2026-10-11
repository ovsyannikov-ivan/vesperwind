# Markdown documents

Vesperwind opens `.md` and `.markdown` files (any letter case) in their own
Editor Workspace tab with TOAST UI Editor 3.2.2. Other text files keep using
Monaco. The module is loaded with the first Markdown tab or preview; the
startup entry only holds the handler descriptor and its file service.

## Editing

A tab opens in TOAST UI's WYSIWYG mode with its full default toolbar: headings,
bold, italic, strikethrough, horizontal rule, quote, bullet/ordered/task lists,
indent/outdent, table, image, link, inline code and code block. TOAST UI's own
mode switch shows the Markdown source with a live preview (side by side in a
wide window, Write/Preview tabs below 760 px). Images added from a local file are
embedded as data URLs, TOAST UI's default.

Each tab owns one editor instance, its document and its ProseMirror undo history.
Vesperwind's Save, Save As, Undo and Redo buttons act on the active tab; Undo and
Redo are enabled from that editor's history. Cmd/Ctrl+S saves, Cmd/Ctrl+Z and
Shift+Cmd/Ctrl+Z undo and redo, and the macOS Edit menu reaches the focused
document. Closing a tab destroys the editor, its observers and its runtime entry.

Opening or previewing a file never rewrites it. The tab keeps the exact text that
was read until the document changes; Save As of an untouched document copies it
byte for byte. Undoing back to the opened or saved document clears the dirty
marker. Switching an unchanged document to Markdown mode shows the file as
written, not TOAST UI's regenerated Markdown. A failed save keeps the draft and
the dirty state; the shared close dialog protects unsaved changes.

## Files, encodings and line endings

Markdown is read as bytes through the provider-neutral binary API (local, SFTP,
FTP/FTPS) and decoded as strict UTF-8. A file in another encoding is refused
instead of being saved back with replacement characters. Files over 10 MB are
refused, like in the text editor. Saving uses the shared text write API.

TOAST UI edits LF-only text. Vesperwind removes a byte order mark and converts
line endings for the editor, then writes the file's own convention back: the BOM,
the dominant line ending (LF, CRLF or CR) and the presence of a final newline.
Text is never trimmed. A file with mixed line endings is saved with its dominant
one after an edit.

## What WYSIWYG editing changes

WYSIWYG mode rebuilds Markdown from TOAST UI's document model when the document
is edited and saved. Formatting is normalized: list markers become `*`, `__bold__`
becomes `**bold**`, setext headings become `---` underlines, indented code
becomes fenced code, reference links become inline links, autolinks become
`[url](url)`, entities become characters, characters are escaped (`\*`) and
trailing spaces are dropped.

Some constructs cannot be represented: raw HTML blocks and inline HTML lose their
tags and keep only their text, `<details>` loses its structure, hard line breaks
(two trailing spaces or a backslash) are lost, and image titles are dropped.
When a file contains such Markdown, the tab shows a warning in WYSIWYG mode with
an **Edit as Markdown** button. The check renders the source and TOAST UI's
regenerated Markdown with TOAST UI's own renderer and compares the results, so
formatting-only rewrites do not trigger it.

Markdown mode edits the source text directly and keeps everything else as
written. Footnotes are not a TOAST UI feature: `[^1]: text` is treated as a
CommonMark link reference definition.

## Quick Look

Space on a Markdown file shows it with TOAST UI Viewer: rendered headings,
emphasis, lists, quotes, links, code blocks, tables, task lists and images, as
selectable text without a toolbar. Task checkboxes cannot be toggled. The text is
read through the existing Quick Look text loader (UTF-8, 3 MiB limit), and no
editor tab, history or dirty state is created.

## Links, HTML and images

TOAST UI sanitizes HTML with DOMPurify; scripts, forms, `javascript:` URLs and
event attributes are removed. Clicks on links in the editor, its preview and
Quick Look are blocked so the WebView never navigates away from Vesperwind.

Relative images are resolved from the Markdown file's folder on the same
provider and loaded through the existing media preparation API. The Markdown
keeps the original reference; only the rendered `<img>` receives the prepared
URL. A missing image keeps its alt text and a dashed placeholder. Remote
`http(s)` images are subject to the desktop Content Security Policy, which allows
only local sources.

## Themes and styles

The editor and viewer follow Light, Dark and System through the Vesperwind CSS
variables alone, so a theme switch restyles open documents and Quick Look
without recreating them; text, selection and history are kept. TOAST UI's
stylesheet is nested under `.vw-markdown`, so its global ProseMirror rules do not
reach the DOCX editor, Monaco or other components. Document content is
selectable; the toolbar and mode switch follow the native-chrome selection policy.

Usage statistics are disabled (TOAST UI otherwise reports the host name to Google
Analytics), and all scripts and styles are bundled locally.

## TOAST UI workarounds

- TOAST UI 3.2.2 duplicates paragraphs that use reference definitions in its
  preview and viewer; the preview is re-rendered from the parsed document when
  that happens.
- Its toolbar measures itself and moves every button into the overflow menu
  while its tab is hidden; the layout is re-run in the frame that shows the tab.
