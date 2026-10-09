/* Only the audited 7zip translation unit and its liblzma allocations use this
 * allocator. Single-threaded, one extraction per isolated worker process. */
#include "archive_memory.h"
#include <stdlib.h>
#include <string.h>
#include <errno.h>
typedef union { size_t size; long double alignment; void *pointer_alignment; } Allocation;
static uint64_t allocated;
static int exceeded;
int vw_archive_memory_exceeded(void) { return exceeded; }
void vw_archive_memory_reject(void) { exceeded = 1; errno = ENOMEM; }
static int fits(size_t size, size_t previous) {
    if (size > SIZE_MAX - sizeof(Allocation) || size > ARCHIVE_MEMORY_BUDGET - (allocated - previous)) {
        vw_archive_memory_reject(); return 0;
    }
    return 1;
}
void *vw_archive_malloc(size_t size) {
    if (!fits(size, 0)) return NULL;
    Allocation *a = malloc(sizeof(*a) + size);
    if (!a) return NULL;
    a->size = size; allocated += size; return a + 1;
}
void *vw_archive_calloc(size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) { vw_archive_memory_reject(); return NULL; }
    size_t total = count * size;
    void *p = vw_archive_malloc(total);
    if (p) memset(p, 0, total);
    return p;
}
void vw_archive_free(void *pointer) {
    if (!pointer) return;
    Allocation *a = (Allocation *)pointer - 1;
    allocated -= a->size; free(a);
}
void *vw_archive_realloc(void *pointer, size_t size) {
    if (!pointer) return vw_archive_malloc(size);
    if (!size) { vw_archive_free(pointer); return NULL; }
    Allocation *a = (Allocation *)pointer - 1;
    size_t previous = a->size;
    if (!fits(size, previous)) return NULL;
    a = realloc(a, sizeof(*a) + size);
    if (!a) return NULL;
    a->size = size; allocated = allocated - previous + size; return a + 1;
}
static void *lzma_allocate(void *opaque, size_t count, size_t size) {
    (void)opaque; return vw_archive_calloc(count, size);
}
static void lzma_release(void *opaque, void *pointer) {
    (void)opaque; vw_archive_free(pointer);
}
const lzma_allocator vw_archive_lzma_allocator = { lzma_allocate, lzma_release, NULL };
