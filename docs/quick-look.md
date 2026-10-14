# Quick Look

Select a regular file in the active file panel and press **Space** to inspect it
temporarily. **Space** again, **Escape** or the close button dismisses the preview. Normal opening
(double-click or Enter) keeps its existing behavior.

Opening with Space is limited to the file panel, outside text inputs, address
editing, editors, terminals, menus and dialogs. While Quick Look is open, Space
belongs to the preview: it closes before PDF, spreadsheet, search-field or media
controls can handle the key. The same rule applies to the native video overlay.
Holding Space does not immediately close the preview on keyboard repeat.
Normal media viewing retains its playback shortcuts. Directories are ignored.

Scrollable Quick Look content shows a soft inner shadow at the top or bottom
only while more content remains in that direction. The shadows follow the
viewer's actual scrollport (including nested PDF and spreadsheet scrolling),
update after loading/resizing, and are clipped by the modal's rounded corners.

## Viewers

- Images and videos use the existing MediaViewerModal, including its playlist,
  native mpv, chapters, history, tracks, subtitles, fullscreen and thumbnails.
- Audio uses CustomMediaPlayer in a temporary modal with autoplay enabled and
  history disabled. Inspection starts at the beginning and neither reads nor
  writes the normal audiobook resume position.
- PDFs and converted PPTX use PdfViewer with isolated view state, thumbnails,
  navigation, zoom, text selection and search. Native PPTX conversion uses the
  same lazy LOWA broker as normal open; closing invalidates/cancels the request.
- DOCX and converted DOC/RTF use the existing loader and OOXML library's `view` surface without editor
  chrome, Save handlers or registration in the document runtime.
- XLS/XLSX uses the existing SheetJS loader/model with a selectable HTML grid,
  sheet selection and bounded pages of 100 rows by 26 columns. Stored values and
  number formats are displayed; formulas without cached values show their formula.
  No Univer editing runtime is created.
- Markdown (`.md`, `.markdown`) is rendered by TOAST UI Viewer as a selectable,
  read-only document, loaded through the text loader below; see
  [Markdown documents](markdown-documents.md).
- Configured editable text files and logs use a selectable, scrollable `<pre>` without
  Monaco. UTF-8 content is limited to **3 MiB** at the provider read boundary.
  Oversized files show metadata and an explicit message; binary or unsupported
  encodings report that text cannot be previewed. Configured `.ts` files are tried
  as TypeScript; binary transport streams route to the existing video viewer.
- Other formats show name, extension, size, modified time and path with a file icon.

PDF, text, document and spreadsheet previews create no EditorWorkspace tab or
dirty state. All loaders use the `{ providerId, path }` API for local and SFTP files.

## Playback coordination

Opening normal video, video Quick Look or audio Quick Look pauses AudioPlayerBar
before the foreground source can autoplay. The bar remains mounted with its source
and position intact. Pending background autoplay is also cancelled. Closing the
preview never resumes the bar; press Play manually when desired. Silent image and
document inspection does not pause the bar.

## Current limitation

Quick Look keeps modal focus, so changing file-panel selection does not update an
open preview. Close it, select another file and press Space again. Existing media
previous/next controls remain available; file-panel navigation keys are not
redirected through a preview.
