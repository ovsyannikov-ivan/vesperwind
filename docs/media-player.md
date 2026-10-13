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

## Video mouse interactions

The video surface has three invisible mouse zones: the left quarter seeks back
10 seconds, the middle half toggles Play/Pause, and the right quarter seeks
forward 10 seconds. Exactly 25% belongs to Play/Pause; exactly 75% seeks forward.
Mouse seeks and keyboard arrows share the existing 180 ms accumulation timer,
feedback and duration clamping. Seeking preserves the playback state.

Both HTML video and the native mpv controls WebView use the same surface, below
visible controls, in windowed and fullscreen playback. Only primary mouse clicks
activate it; dragging, loading/errors and native fullscreen transitions do not.
Overlapping Play/Pause commands are ignored until the current command returns.
An isolated middle-zone click toggles playback after a 300 ms double-click wait;
a middle-zone double click toggles fullscreen without changing playback. Repeated
clicks in the left/right zones seek immediately and never toggle fullscreen.
The seek indicator fades in and out over 200 ms and keeps the completed burst
visible for another 1.2 seconds. Its lifetime is separate from the 180 ms seek
timer and live progress state. Audio-only playback and image viewing are unchanged.

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

Both platform builds enable TLS in FFmpeg explicitly despite
`--disable-autodetect`: SecureTransport on macOS, Schannel on Windows. No OpenSSL
runtime dependency is added; LGPL/GPL restrictions remain intact. (An earlier
Windows bundle carried an avformat cross-built separately for TLS; the next
`npm run build:libmpv` on Windows replaces it with the full build's own.)
The bundle verifier enumerates protocols from the actual library
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
