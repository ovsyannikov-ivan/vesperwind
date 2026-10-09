/* Compile-time reduced budget tests; no production runtime budget override. */
#include "archive_memory.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define CHECK(value) do { if (!(value)) { fprintf(stderr, "Memory check failed: %s\n", #value); return 1; } } while (0)
int main(void) {
    unsigned char *a = vw_archive_calloc(1, 1024);
    CHECK(a && a[0] == 0 && a[1023] == 0);
    memset(a, 42, 1024);
    a = vw_archive_realloc(a, 2048);
    CHECK(a && a[1023] == 42);
    void *other = vw_archive_malloc(1024);
    CHECK(other);
    CHECK(!vw_archive_realloc(a, ARCHIVE_MEMORY_BUDGET));
    CHECK(a[1023] == 42); /* Failed growth preserves the original allocation. */
    CHECK(!vw_archive_calloc(SIZE_MAX, 2));
    CHECK(!vw_archive_malloc(SIZE_MAX));
    CHECK(vw_archive_memory_exceeded());
    vw_archive_free(a); vw_archive_free(other); vw_archive_free(NULL);
    a = vw_archive_malloc(ARCHIVE_MEMORY_BUDGET);
    CHECK(a); /* Every previous allocation was released. */
    CHECK(!vw_archive_malloc(1));
    vw_archive_free(a);
    lzma_options_lzma options = {0}; options.dict_size = UINT32_MAX;
    options.lc = 3; options.lp = 0; options.pb = 2;
    lzma_filter filters[] = {{LZMA_FILTER_LZMA1, &options}, {LZMA_VLI_UNKNOWN, NULL}};
    lzma_stream stream = LZMA_STREAM_INIT;
    stream.allocator = &vw_archive_lzma_allocator;
    CHECK(lzma_raw_decoder(&stream, filters) == LZMA_MEM_ERROR);
    lzma_end(&stream);
    a = vw_archive_malloc(ARCHIVE_MEMORY_BUDGET);
    CHECK(a); /* liblzma error cleanup also frees its partial allocations. */
    vw_archive_free(a);
    return 0;
}
