# Media position history

Vesperwind owns its resume history in SQLite; it does not use mpv watch-later files
or web localStorage. Native video and the existing browser-backed audio/video
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
no watched-library UI, retention cleanup or cross-device sync. Sudden power loss
can lose time since the latest checkpoint; graceful exit flushes known position.
Remote replacement with unchanged path/size cannot be detected without remote
mtime support. Windows/Linux packaged runtime acceptance remains separate.

See [video thumbnail previews](video-thumbnails.md).
