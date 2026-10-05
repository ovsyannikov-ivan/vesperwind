# Offline Word documents

Vesperwind opens and saves DOCX through `@docx-editor.dev/vue` 2.22.0 and its
canonical OOXML core. The document module is loaded on first DOCX, RTF, or DOC
tab. Its Vue component, core, fonts, and CSS stay outside the startup entry.
The editor owns independent state and undo history per tab and is destroyed
when its tab closes. The handler uses only the provider-neutral binary API.

## Imports

RTF and binary Word DOC are import-only. Native Tauri converts their provider
bytes with the pinned embedded LOWA backend, then uses the existing OOXML reader
and editor. The original is unchanged, the imported tab stays dirty, and first
Save requires Save As DOCX. No native executable discovery or installed
LibreOffice fallback remains. The converter is lazy, serialized, cancelled by
native WebView destruction and released after 90 seconds idle; see
[Office conversion](office-conversion.md).

Browser/SEA intentionally retains its separate Node converter using optional
installed LibreOffice, private temporary files/profile and a process timeout.
Its `VESPERWIND_LIBREOFFICE` override applies only to that backend.
An RTF rendering-only JavaScript library would lose structural fidelity during
the next DOCX conversion. LibreOffice's established RTF and Word Binary import
filters are used for both sources. Conversion can still change unsupported
RTF/DOC features, so the UI presents the import as a conversion.

## Save As and safety

Save As is a shared Editor Workspace action for text, spreadsheet, and Word
handlers. It lists the selected provider's directories and creates a new file
exclusively before writing through the provider API. Existing files are not
overwritten. Failed writes remove the newly created file. Imported documents
must use `.docx`; first Save opens Save As. After a successful write, the tab
adopts the new provider/path and subsequent Save writes there. Local root and
real-path checks and SFTP connection-root checks remain in the existing file
operation and binary write layers.

Neither native DOCX nor converted imports execute VBA, OLE, scripts, or field
instructions. The editor's OOXML parser applies its own size and structure
limits; Vesperwind's provider binary API also caps files at 32 MiB. External
file watcher events refresh directory views. They never replace an open Word
editor buffer automatically, including a dirty buffer.

## Round-trip scope

Controlled generated fixtures exercise text, styled runs, alignment, lists,
tables with merged cells, embedded PNG, headers/footers, page break, Cyrillic,
bookmark, field, and custom XML. The core parser and serializer preserve all
these fixtures structurally, and the custom XML payload remains present after
serialization. A ZIP part comparison after a paragraph edit found no removed
parts in the advanced, image, or header/footer fixtures. The embedded PNG
remained byte-identical. Most XML parts, including custom XML and headers,
were serialized anew, so their byte identity is **not** preserved. This test
does not establish fidelity for charts, SmartArt, embedded OLE, review markup,
equations, or footnotes/endnotes. A browser edit/save/reopen smoke test confirms ordinary DOCX
text and a separate imported DOC to DOCX path. LibreOffice opens the output.

According to the upstream [Word fidelity matrix](https://www.docx-editor.dev/docs/2.x/word-fidelity),
basic text formatting, lists, tables, links, images, sections, and page setup
have editing support. Equations, legacy VML, OLE, VBA, custom XML, and many
fields can be preserved as inert OOXML even where editing or rendering is
limited. Pro-only review features are not enabled. We do not claim a lossless
round-trip for all Word documents: complex SmartArt, charts, comments,
tracked changes, embedded objects, advanced fields, and external clipboard
formats have not been exhaustively tested in Vesperwind. Layout also depends
on available fonts. Packaged substitutes are offline, but can change line
breaks relative to Microsoft Word.
