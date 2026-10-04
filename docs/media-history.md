# Media position history

Vesperwind owns its resume history in SQLite; it does not use mpv watch-later files
or web localStorage. Native audio/video and the Tauri web fallback
share the same serialized Rust history worker.

## Location, schema and identity

The database is `app.path().app_data_dir()/media-history.sqlite3`. On macOS:
`~/Library/Application Support/com.vesperwind.desktop/media-history.sqlite3`.
It uses WAL, synchronous FULL, a two-second busy timeout and transactional schema
migration with `PRAGMA user_version=1`. Missing directories/database are created.
A corrupt/unavailable database logs the error and disables persistence for the run
without preventing playback or replacing the user's database.

The `media_history` table has a `(provider_id, path)` primary key, file size,
modified time, duration, position and updated timestamp. Local identity comes from
the existing resolver's canonical path plus size and nanosecond mtime. Remote
identity uses provider ID, normalized provider path and available size metadata;
remote mtime is currently unavailable and remains NULL. Lookup invalidates rows
whose size/mtime changed. No content hashing, remote downloading, thumbnails, blobs
or cloud sync occur.

## Save events and disk-write policy

Playback ticks update RAM only. Native ticks check an in-memory gate; the existing
web player mirrors current state into native RAM at most once per second so app
exit can save even after its WebView stops responding. That mirror does not write
SQLite on every tick.

Writes may be enqueued on confirmed Pause, Close, source switch (old session Close),
EOF, and graceful application exit. Periodic checkpoints require at least 120
seconds since the last accepted capture and at least five seconds of changed
position. Immediate events suppress duplicates with less than one second change.
SQLite UPSERT additionally suppresses unchanged data. Play itself does not write.
Each worker job executes one small transaction; all access is serialized off the
player/UI thread. Exit closes players while their handles remain valid, captures
web RAM mirrors, then flushes queued history work before process shutdown.

Positions below 15 seconds are not resumed. Remaining duration of 30 seconds or
less is treated as completed, as is normal EOF. These events delete a previous
resume row. EOF is captured before rewind-to-zero. A failed/unloaded session cannot
erase a prior valid record. No queue of per-frame transactions accumulates.

## Restore lifecycle and OSD

Open resolves identity and looks up history. Native media loads paused, waits for
FILE_LOADED and seeks exactly while paused. Restore is confirmed only after
`seeking=false` and position within one second of the saved target; autoplay begins
after confirmation. The web player similarly waits for metadata and confirmed
`seeked`. A ten-second failure deadline logs failure and produces no restore OSD.
Beginning/completed/new/stale sources start normally without restore OSD.

After confirmed restore the overlay displays **Play** and actual restored
`current / duration`, following the requested UX. It does not add a second autoplay
Play message. The restore event gets a full 1.8-second interval on first attachment
of the native overlay (with a ten-second freshness bound). Play/Pause/Audio/Subtitles
replace one shared OSD and reset its timer; closing/switching clears it.

## Future extensions and limits

A later migration can add audio/subtitle preferences keyed by language, title and
codec, with numeric track ID fallback. This schema stores position only. There is
no watched-library UI or cross-device sync. Sudden power loss
can lose time since the latest checkpoint; graceful exit flushes known position.
Remote replacement with unchanged path/size cannot be detected without remote
mtime support. Windows/Linux packaged runtime acceptance remains separate.

See [video thumbnail previews](video-thumbnails.md).

## Audiobooks and chapters

Tauri M4B and other supported audio use the native player History worker,
checkpoint policy, identity and media_history table shared with video. The web
fallback retains the existing WebHistory RAM mirror. Resume is always an absolute
position; it never snaps to a chapter start. Chapters are source metadata, never
SQLite data. Native audio/video reads duration and chapter-list from the active session at
FILE_LOADED. Queued items and Tauri web fallback query a single paused headless
libmpv probe through ContentSource, returning duration, chapters and basic tags together.
Probe concurrency is bounded at two in both the playlist and native command
layer. Unsupported metadata returns unknown duration and no chapters.
No system ffprobe/ffmpeg or container parser is used at runtime for chapters.
The frontend shares index/title/startTime and resolves the active chapter from
currentTime, including after resume. Chapter controls use the existing seek.

## Retention

The history worker prunes rows whose updated_at is strictly older than 180 days
when configuring/opening its existing connection. Successful valid lookups touch
updated_at even when playback position has not changed. Completed media is still
deleted immediately. No VACUUM, additional index, schema or connection is added.

## Persistent audio and Quick Look

`player:open` carries `kind` and `historyEnabled`. Audio sessions initialize normal
mpv audio output with `vid=no`, `vo=null` and `audio-display=no`. They create no
native surface, renderer, overlay or geometry. Independent session IDs share the
stream registry and History worker; native audible ownership is serialized so
opening/playing a foreground session pauses other sessions. Paused persistent
audio stays alive when video or Quick Look opens and does not resume on close.

Quick Look uses `historyEnabled=false`: no identity lookup, checkpoint, touch,
completion deletion or close write occurs. It starts at zero. Normal playlist
progression waits for `endedRevision`, incremented once after native EOF history
completion and rewind. The web backend exposes the same revision after its ended
history operation. Repeated snapshots cannot advance the queue twice.

Logical queue sources/order, current/selected identities, repeat and shuffle
preferences are stored in `vesperwind:audio-playlist:v1`, separately from history.
Playback sessions, autoplay and shuffle traversal remain in application memory.
Startup restores the queue without playback. Closing pauses and hides the UI while retaining it.
Repeat off stops at the final track, all wraps, and one repeats only natural EOF.
Shuffle uses Fisher-Yates with injectable randomness, stable upcoming order and
actual playback history; a new repeat-all cycle avoids the previous final item
as its first choice. Row reordering changes visible/unshuffled order without
resetting playback or the active shuffle traversal.

Only playlist expanded state and preferred height are layout preferences. One
height budget reserves 140 px for Files/Editor while allocating both playlist and
terminal; effective heights scale together when the window shrinks. The playlist
uses the established provider-backed file drag payload and never performs a
filesystem transfer. Rename/move updates queue identities and preserves current
position; deletion/removal stops the current track without autoplaying another.

HTTP/HTTPS URL media and HLS never read, write or delete file resume history.
File-backed M3U entries keep normal history semantics. See [media sources and
playlists](media-player.md) for import/export, source probing and persistence.
