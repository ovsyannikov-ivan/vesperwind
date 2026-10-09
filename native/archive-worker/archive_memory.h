#ifndef VESPERWIND_ARCHIVE_MEMORY_H
#define VESPERWIND_ARCHIVE_MEMORY_H
#include <stddef.h>
#include <stdint.h>
#include <lzma.h>
#ifndef ARCHIVE_MEMORY_BUDGET
#define ARCHIVE_MEMORY_BUDGET ((uint64_t)512 << 20)
#endif
void *vw_archive_malloc(size_t size);
void *vw_archive_calloc(size_t count, size_t size);
void *vw_archive_realloc(void *pointer, size_t size);
void vw_archive_free(void *pointer);
int vw_archive_memory_exceeded(void);
void vw_archive_memory_reject(void);
extern const lzma_allocator vw_archive_lzma_allocator;
#endif
