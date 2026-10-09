# CI warnings

Vesperwind's own Rust, JavaScript and Vue code should build and test without
warnings. Warnings from third-party code and build tools are reviewed and listed
here instead of being silenced wholesale. A new warning from our code is a
defect; a new third-party or tooling warning is added to this list with its
reason.

## Vesperwind code (fixed)

| Warning | Where | Resolution |
|---|---|---|
| `unused import: super::*` | `src-tauri/src/filesystem/size.rs` tests on Windows | The test module only contains a Unix test and is now compiled for `all(test, unix)` |
| `[Vue warn] onScopeDispose() is called when there is no active effect scope` | `test/mediaViewer.test.js` | The composable runs inside an `effectScope` that the test stops |
| `[Vue warn] Property "controlsTarget" was accessed during render` | `test/thumbnailPreview.test.js` | The test component declares the component's `controlsTarget` prop |
| `Node.js 20 is deprecated` (GitHub annotation) | `.github/workflows/ci.yml` | `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` use v7, which run on Node.js 24 |

## Third-party code (reviewed)

| Warning | Source | Assessment |
|---|---|---|
| `LNK4099: PDB 'ossl_static.pdb' was not found ... linking object as if no debug info` | Windows MSVC link of vendored OpenSSL (`openssl-src`, through `libssh2-sys` with `vendored-openssl`/`openssl-on-win32`) | OpenSSL objects are compiled with `/Zi`, but their PDB is not installed with the static library. Only OpenSSL debug symbols are missing; code and linking are unaffected. `build.rs` passes `/IGNORE:4099` for MSVC targets because the diagnostic repeats for every libcrypto object of every linked target and hides other output. Other linker warnings remain visible. |
| `-Wpointer-sign` in `archive_write_disk_posix.c` | libarchive 3.8.9 C source, built by `npm run build:archives` | An upstream `unsigned char *` to `const char *` assignment; harmless for byte buffers. Pinned upstream source is not patched for a warning. |
| C compiler warnings while building FFmpeg | `scripts/build-thumbnail-ffmpeg.sh` | Upstream FFmpeg sources; the build output is verified by `scripts/check-thumbnail-ffmpeg.mjs`. Not patched. |

Rust warnings from registry crates are capped by Cargo and do not appear.
`vendor/ssh2-config` is a path dependency, so its warnings would appear; it
currently builds without warnings.

## Build tools (documented)

| Message | Source | Assessment |
|---|---|---|
| `(!) Some chunks are larger than 500 kB after minification` | Vite production build | Chunks over 500 kB come from editor and document libraries (Monaco and its workers, pdf.js, the DOCX editor and others) and from the main entry chunk. The threshold is not raised to hide this; splitting the main entry chunk is separate performance work. |
| `The ubuntu-latest label will migrate to Ubuntu 26` | GitHub Actions notice | Informational; the Linux jobs need a check when the image changes. |
| `jobs targeting macOS arm64 runners may experience longer queue times` | GitHub Actions notice | Informational. |
| `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided` | Node.js 25 and newer running `npm test` locally | Node exposes an experimental `localStorage` global that warns on access. CI uses Node.js 22, which does not. It appears when tests load composables that read `localStorage`. |
| `[hls @ ...] Opening '...segment...' for reading` | libmpv/FFmpeg log in Rust media tests | Informational stream logging, not a warning. |
