import fs from 'node:fs/promises'
import path from 'node:path'

// Small, fail-closed integration patch for exactly pinned libarchive 3.8.9.
// All allocations/frees in this translation unit are paired here; the one
// exception (lzma_properties_decode) is redirected to the same allocator.
export const patchArchive7zip = async (source) => {
  const filename = path.join(source, 'libarchive/archive_read_support_format_7zip.c')
  let text = await fs.readFile(filename, 'utf8')
  const replace = (original, replacement) => {
    if (text.split(original).length !== 2) throw new Error(`Pinned 7zip patch mismatch: ${original.slice(0, 70)}`)
    text = text.replace(original, replacement)
  }
  replace('#define _7ZIP_SIGNATURE', `/* Vesperwind: bounded metadata, solid buffers and raw LZMA dictionaries. */
#include "archive_memory.h"
static const void *vw_7zip_read_ahead(struct archive_read *a, size_t minimum, ssize_t *available) {
    if (minimum > ((size_t)128 << 20)) {
        vw_archive_memory_reject();
        archive_set_error(&a->archive, ENOMEM, "7zip read-ahead exceeds memory budget");
        if (available) *available = -1;
        return NULL;
    }
    return __archive_read_ahead(a, minimum, available);
}
#define __archive_read_ahead vw_7zip_read_ahead
#define malloc vw_archive_malloc
#define calloc vw_archive_calloc
#define realloc vw_archive_realloc
#define free vw_archive_free

#define _7ZIP_SIGNATURE`)
  replace('lzma_properties_decode(&filters[fi], NULL,', 'lzma_properties_decode(&filters[fi], &vw_archive_lzma_allocator,')
  replace('r = lzma_raw_decoder(&(zip->lzstream), filters);', `zip->lzstream.allocator = &vw_archive_lzma_allocator;
        r = lzma_raw_decoder(&(zip->lzstream), filters);`)
  // PPMd uses a different upstream allocator. It is outside the supported codec
  // set, so reject it before its unbounded model allocation can be attempted.
  replace('case _7Z_PPMD:\n\t{\n\t\tunsigned order;', `case _7Z_PPMD:
        archive_set_error(&a->archive, ARCHIVE_ERRNO_MISC, "PPMd codec is unsupported");
        return ARCHIVE_FAILED;
    {
        unsigned order;`)
  await fs.writeFile(filename, text)
}
