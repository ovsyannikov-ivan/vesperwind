# LOWA source build

Production consumes verified artifacts in `src-tauri/vendor/lowa`; it never runs this build.
The source and SDK pins are in `sources.lock.json`, the exact accepted recipe/receipt
in the runtime `BUILD-INFO.json`, and modifications in `production.patch` and
`modified-source/` (source form for MPL compliance). Upstream source is available
at the pinned core URL. Apply the patch to that exact revision, or use the idempotent
checksum-checked `prepare.mjs`. License texts and selected build-input notices
are bundled in the runtime `licenses/` directory.

On macOS arm64, use a fresh **case-sensitive** filesystem and a space-free
mount path. The accepted build used a case-sensitive APFS sparse image. A
normal case-insensitive macOS directory is insufficient. For example:

```sh
export LOWA_SCRATCH=/private/tmp/vesperwind-lowa-rebuild
export LOWA_IMAGE=/private/tmp/vesperwind-lowa-rebuild.sparseimage
hdiutil create -size 160g -type SPARSE -fs APFSX -volname VesperwindLOWA "$LOWA_IMAGE"
hdiutil attach "$LOWA_IMAGE" -mountpoint "$LOWA_SCRATCH" -nobrowse
node vendor/lowa-build/bootstrap.mjs
LOWA_MEMORY_PROFILE=128-grow-512 LOWA_TRIM_PACKAGE=1 node vendor/lowa-build/prepare.mjs
node vendor/lowa-build/build.mjs
node vendor/lowa-build/package.mjs "$LOWA_SCRATCH/build-curated" /private/tmp/vesperwind-lowa-new-payload
```

After preserving the new payload/receipts, detach the scratch mount before
removing its backing image; deleting the mounted directory itself returns EBUSY.

Review hashes, all selected licenses, and both native acceptance corpora before
updating the runtime artifacts and regenerating ASSETS.json. Keep only Brotli
engine variants in the distribution. The recipe includes Python as a compiler
build tool; Python is absent from application conversion. A bit-identical rebuild
has not yet been demonstrated. See `docs/office-conversion.md` for acceptance.
