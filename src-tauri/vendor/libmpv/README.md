# Bundled libmpv artifacts

This directory is the Tauri bundle input for the pinned libmpv build described
in `docs/libmpv.md`. The macOS arm64 directory contains the complete dynamic
dependency closure built by `scripts/build-libmpv-macos.sh`. Windows remains a
release blocker until its equivalent reviewed DLL closure is supplied.

Expected entry libraries:

- `macos/libmpv.2.dylib` (currently arm64);
- `windows/mpv-2.dll` (matching the Windows target architecture).

Each platform directory must also contain every non-system runtime dependency,
the corresponding license notices, build manifest, source offer/instructions,
and checksums.
