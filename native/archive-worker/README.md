# Bounded 7z decoding

The worker registers 7zip explicitly alongside the existing ZIP/TAR/RAR readers.
It links libarchive 3.8.9, zlib 1.3.1 and XZ/liblzma 5.8.3 statically. Source
archives and SHA256 hashes are pinned in `scripts/archive-sources.json`; CMake's
LibLZMA finder uses only the locally built `liblzma` target. Builds test actual
Copy, LZMA, LZMA2 and solid extraction before staging the executable.

libarchive's 7zip reader uses `lzma_raw_decoder`, which has no memlimit argument.
`scripts/patch-archive-7zip.js` applies exact, fail-closed replacements to the
freshly extracted verified source. Its scope is one translation unit:

- Reader malloc/calloc/realloc/free share a 512 MiB live payload budget.
- `lzma_properties_decode` and the raw decoder use the same `lzma_allocator`.
- All allocation/free sites in the pinned reader were checked for pairing. The
  property decoder is the exception to reader-local allocation and is redirected
  explicitly. No allocation from an external decoder is freed with the reader's
  allocator except liblzma allocations using that supplied allocator.
- Reader-requested `__archive_read_ahead` minimums above 128 MiB fail before the
  core allocates a buffer. Core buffer growth/runtime allocations are separate.
- PPMd is rejected before its separate model allocator runs. BZip2/ZSTD and other
  optional system codecs stay disabled. x86 BCJ and delta are native liblzma
  filters; only x86 BCJ + LZMA2 has a dedicated acceptance fixture.

This is not a process RSS limit. Payload accounting excludes allocation headers
and the rest of libarchive/libc. It bounds attacker-controlled 7z dictionary,
metadata and solid allocations while retaining process isolation and kill/reap
cancellation. Memory refusal reports EARCHIVE_LIMIT. No runtime override can
raise the budget; the native allocator test alone compiles with a smaller budget.

On a pinned-version update, re-audit reader allocation/free sites and decoder
initialization, update exact replacements, then repeat fixtures and native tests.
Do not loosen patch matching or substitute a host liblzma to make a build pass.

`archive-memory-test` covers overflow, cumulative allocation accounting, failed
realloc preservation, freeing capacity and raw LZMA dictionary refusal/cleanup.
The genuine `huge-dictionary.7z` tests the entire production decoder path. Node
and Rust acceptance also extract a 384 MiB solid archive, test encryption/header
encryption, path safety, publication conflicts and cancellation with no output.
