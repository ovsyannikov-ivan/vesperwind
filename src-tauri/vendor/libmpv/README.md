# Bundled libmpv artifacts

This directory is the Tauri bundle input for the pinned libmpv build described
in `docs/libmpv.md`. The macOS arm64 directory contains the complete dynamic
dependency closure built by `scripts/build-libmpv-macos.sh`. The Windows x64
directory contains the DLL closure built by `scripts/build-libmpv-windows.ps1`
and its UCRT64 shell stages. Both use the same pinned media-library versions.

Expected entry libraries:

- `macos/libmpv.2.dylib` (currently arm64);
- `windows/mpv-2.dll` (matching the Windows target architecture).

Each platform directory must also contain every non-system runtime dependency,
the corresponding license notices, build manifest, source offer/instructions,
and checksums.

The Windows upstream entry `libmpv-2.dll` is packaged as `mpv-2.dll`, matching the
existing application contract. MSYS2 and source/build trees are external build
tools and are not runtime resources. Validate with
`node scripts/verify-libmpv-bundle.js windows`; see
`docs/build-windows.md` for the media verification procedure and renderer limits.
