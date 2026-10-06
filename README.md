# Vesperwind

**A dual-pane file manager with editors, viewers and terminals built in.**

Work with local files and remote servers in one desktop workspace. Browse and
transfer files, edit documents, preview media, and open a shell without switching
between applications.

## Features

- **File management:** two independent panels, copy/move/rename/delete/duplicate,
  Cut/Copy/Paste (Ctrl/Cmd+X/C/V) between panels and providers, drag-and-drop,
  keyboard shortcuts and context menus.
- **Archives & navigation:** create ZIP and extract ZIP/TAR/TGZ/RAR/RAR5 with a
  bundled worker; edit panel paths with Ctrl/Cmd+L or browse breadcrumbs.
- **SSH & SFTP:** saved connection profiles, host-key verification, remote browsing,
  and file transfers between local and remote panels.
- **Search & filtering:** recursive name/path search, per-panel filters and sorting,
  and automatic refresh for local folders.
- **Quick Look:** press Space on a selected file for a temporary read-only preview
  of media, text, PDF, PPTX, DOCX/DOC/RTF or XLS/XLSX without opening an editor tab.
- **Text & code:** multi-tab Monaco editor with syntax highlighting, minimap,
  document search and indentation controls. Edit local or remote files.
- **Documents:** edit DOCX and XLSX/XLS; import DOC and RTF with bundled LOWA in desktop builds.
- **PDFs & presentations:** read-only PPTX preview through bundled LOWA; thumbnails,
  page navigation, zoom, text selection and search through PDF.js.
- **Media:** view images and play local or remote audio/video with seeking,
  track selection and fullscreen controls, including M4B audiobooks and M4R ringtones.
  The audio player saves its queue between launches, with drag reordering, repeat,
  shuffle and M3U import/export. Open HTTP/HTTPS audio, video and HLS URLs; Tauri
  playback uses bundled libmpv, including FLAC, AC-3 and E-AC-3.
- **Terminals:** multiple local PTY and SSH terminal tabs.
- **Desktop integration:** the system clipboard and drag-and-drop work both ways
  with Finder and Explorer, for local and SFTP files: copy in Finder/Explorer and
  paste into any panel (uploads for SFTP), or copy/drag from Vesperwind into a
  folder. Remote files stream on demand (file promises on macOS, virtual files on
  Windows). Mount and eject disk images from the context menu (DMG and ISO on
  macOS, ISO on Windows), open files with other applications and reveal them in
  Finder or Explorer.

## Platforms

Desktop builds target **macOS (Apple Silicon)** and **Windows (x64)**. A browser
mode with a Node.js backend is also available. Linux desktop packaging is not yet
supported.

For setup and build instructions, see the [development guide](docs/development.md).

## Learn more

- [Office conversion](docs/office-conversion.md) and [bounded file operations](docs/file-operation-lifecycle.md)
- [Word documents](docs/word-documents.md) and [spreadsheets](docs/spreadsheets.md)
- [Quick Look and playback coordination](docs/quick-look.md)
- [Media URLs, HLS and persistent playlists](docs/media-player.md)
- [Video seeking and thumbnail previews](docs/video-thumbnails.md)
- [Archives, address bar and mounted network shares](docs/archives-and-navigation.md)
- [Native playback, HDR and Dolby Vision details](docs/libmpv.md#hdr-and-color-pipeline)
  for media enthusiasts, including current limitations and verification results

## Contributing

Bug reports, focused fixes and improvements are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE), © 2026 Ivan Ovsyannikov. Third-party components retain their own
licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
