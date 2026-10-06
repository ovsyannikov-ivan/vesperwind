# Media sources and playlists

The existing media backend accepts an explicit provider source
(`sourceType: 'provider', providerId, path`) or a network source
(`sourceType: 'url', url`). HTTP/HTTPS URLs are normalized with the URL parser;
query strings are retained. Display labels omit credentials and query strings.
Network mpv messages are suppressed to keep tokens out of diagnostics.

Open URL first probes tracks with bundled libmpv in Tauri, then routes audio to
the persistent player and video to the existing viewer. Probes use no audio or
video output, have a ten-second load deadline and cancellation, and share a
two-worker native limit across WebViews. Browser/SEA uses native web media
capabilities without HLS.js. Unsupported streams produce a normal error.

Native audio retains its audio-only mpv session without a surface or overlay.
Video retains the existing renderer and hardware decoder policy. Foreground
video pauses persistent audio without clearing its queue or resuming it on close.
URL sources never read, write or delete `media_history`. Provider-backed audiobooks imported from playlists keep chapters and exact resume
in the persistent player; ordinary music does not use resume history. Quick Look
audio is always a separate temporary session without history.

## M3U and HLS

Files opened from a file panel with `.m3u` or `.m3u8` extensions are inspected.
`#EXT-X-` directives identify HLS; the entire manifest is passed to libmpv as one
source. FFmpeg handles variants and relative child manifests/segments. Local HLS
uses the sandbox-resolved Unicode native path so sibling segments resolve.
SFTP HLS sibling segments are unsupported. HLS history is disabled.

Ordinary UTF-8/BOM playlists support EXTINF, comments, Unicode, absolute and
relative provider paths, and HTTP/HTTPS audio URLs. Imports append in source
order, deduplicate, check file existence by directory listing, skip video and
unsupported/nested playlists, select the first new row, and never autoplay.
Relative paths retain the playlist's provider, including SFTP. URL entries are
probed with two import workers. The import summary reports skipped/duplicate
entries. Limits are 3 MiB and 10,000 entries; no recursive expansion is performed.
Opening a playlist in the editor tree explicitly opens its text instead.

Export writes Extended M3U into the active panel directory through existing
provider writes, including SFTP, with the usual overwrite confirmation. The
default filename is `playlist.m3u8`. Same-provider paths are relative when
representable, otherwise absolute; cross-provider exports are refused explicitly.
URL entries retain their exact normalized URL. Provider IDs and credentials are
never synthesized into the output. Unknown durations use `-1`.

## Queue and metadata

Row handles use a separate internal drag MIME identity; file-panel/editor drops
still use FILE_ENTRY_MIME. Reorder preserves current/selected items and playback.
Unshuffled navigation follows the visible order immediately. Shuffle's active
history/upcoming order remains intact until the next cycle.

`vesperwind:audio-playlist:v1` contains version 1 logical sources, item order,
fallback names, current/selected identities, repeat, shuffle and visibility.
Writes are debounced 200 ms and flushed on pagehide/disposal. Prepared URLs,
sessions, playback/autoplay, errors, probes, chapters and shuffle cursors are
excluded. Startup restores logical state without starting playback or preparing
the current source; bounded background metadata may repopulate rows. Offline
SFTP entries remain stored. Rename/move/delete updates the same logical record.
Malformed/unsupported versions are ignored safely.

The shared libmpv metadata load returns duration, chapters, audio/video tracks,
live indication when available, and title/artist/album/albumArtist/trackNumber/
discNumber tags. Active native playback also supplies metadata, avoiding another
probe for the playing row. Tags take precedence over EXTINF and filename/URL
fallbacks. Metadata errors do not block playback. Existing repeat/shuffle, EOF,
playlist sizing and workspace clamps remain shared with the previous player.

## Bundled networking and validation

The previous checked-in bundles lacked HTTPS/TLS. Only FFmpeg n8.0's ABI-compatible
avformat library was replaced: SecureTransport on macOS, Schannel on Windows.
Codec libraries, libmpv, hardware acceleration and renderers remain unchanged.
No OpenSSL runtime dependency was added; LGPL/GPL restrictions remain intact.
Full build scripts enable TLS explicitly despite `--disable-autodetect`.
The macOS bundle has since been rebuilt in full with SecureTransport, so its
avformat comes from `build-libmpv-macos.sh` itself.
`scripts/build-libmpv-network.sh` reproduces the avformat-only update; Windows
uses the pinned official llvm-mingw 20260826 UCRT macOS cross toolchain recorded
in BUILD-INFO. The bundle verifier enumerates protocols from the actual library
and requires HTTP, HTTPS, TLS, HLS, TCP, crypto, file and the HLS demuxer on both
target OSes. Windows also verifies Schannel's system import closure.

Owned fixtures under `test/fixtures/media` include tagged FLAC, MP3 and a
seven-second H.264/AAC MPEG-TS VOD HLS with four segments and a master playlist.
Loopback HTTP tests cover audio/video routing, redirects, missing sources,
timeouts/cancellation and relative manifests. HTTPS tests use a public test-only
certificate/key. macOS verifies the fixture CA. FFmpeg 8 Schannel cannot consume
that custom CA, so only the Windows loopback fixture disables verification;
production sessions/probes explicitly keep TLS verification enabled.

Local macOS headless HLS reported `videotoolbox-copy` and reached VOD EOF through
all segments. This is not verification of main-window Metal composition, physical
HDR, direct VideoToolbox presentation, or interactive SFTP playback. Those need
an unlocked Tauri session. Windows runtime coverage runs in CI; available GPU
hardware is reported rather than assumed on hosted runners.
