/* Exercise the production extraction code with simulated volume pressure. */
#include <stdint.h>
static uint64_t test_available;
static int queries, fail_query, shrink_after;
static int simulated_space(uint64_t *bytes);
#define ARCHIVE_AVAILABLE_SPACE simulated_space
#define main worker_main
#define wmain worker_wmain
#include "main.c"
#undef main
#undef wmain

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "Failed: %s\n", #condition); return 1; } } while (0)
static int simulated_space(uint64_t *bytes) {
    queries++;
    if (fail_query) return 0;
    *bytes = shrink_after && queries > shrink_after ? space_reserve(test_available) : test_available;
    return 1;
}
int main(int argc, char **argv) {
    CHECK(argc == 3);
    if (!strcmp(argv[1], "limits")) {
        CHECK(source_prefix_matches("/book/chapter", "/book"));
        CHECK(!source_prefix_matches("/other/chapter", "/book"));
        CHECK(!source_prefix_matches("/boo", "/book"));
#ifdef _WIN32
        CHECK(source_prefix_matches("//?/C:/book/chapter", "\\\\?\\C:\\book"));
        CHECK(!source_prefix_matches("//?/D:/book/chapter", "\\\\?\\C:\\book"));
#else
        CHECK(!source_prefix_matches("/book/chapter", "\\book"));
#endif
        CHECK(space_reserve((uint64_t)1 << 30) == MIN_SPACE_RESERVE);
        CHECK(space_reserve((uint64_t)10 << 30) == ((uint64_t)1 << 30));
        CHECK(extraction_limit(MIN_SPACE_RESERVE, MIN_SPACE_RESERVE) == 0);
        CHECK(extraction_limit(MIN_SPACE_RESERVE - 1, MIN_SPACE_RESERVE) == 0);
        CHECK(extraction_limit(MIN_SPACE_RESERVE + 8, MIN_SPACE_RESERVE) == 8);
        CHECK(extraction_limit(UINT64_MAX, space_reserve(UINT64_MAX)) == MAX_BYTES);
        uint64_t remaining;
        test_available = MIN_SPACE_RESERVE + 8;
        CHECK(check_space(MIN_SPACE_RESERVE, 8, &remaining) == 0 && remaining == 8);
        CHECK(check_space(MIN_SPACE_RESERVE, 9, &remaining) != 0);
        return 0;
    }
    test_available = (uint64_t)1 << 30;
    if (!strcmp(argv[1], "low")) test_available = MIN_SPACE_RESERVE + 8;
    else if (!strcmp(argv[1], "unknown")) fail_query = 1;
    else if (!strcmp(argv[1], "pressure")) shrink_after = 1;
    else if (!strcmp(argv[1], "stream")) {
        shrink_after = 2;
        struct archive *a = archive_write_new();
        struct archive_entry *entry = archive_entry_new();
        archive_write_set_format_zip(a);
        CHECK(archive_write_open_filename(a, "stream.zip") == ARCHIVE_OK);
        archive_entry_set_pathname(entry, "expanded.bin");
        archive_entry_set_filetype(entry, AE_IFREG);
        archive_entry_set_perm(entry, 0644);
        archive_entry_set_size(entry, 9 * 1024 * 1024);
        CHECK(archive_write_header(a, entry) == ARCHIVE_OK);
        char block[65536] = {0};
        for (int i = 0; i < 144; i++) CHECK(archive_write_data(a, block, sizeof(block)) == sizeof(block));
        CHECK(archive_write_close(a) == ARCHIVE_OK);
        archive_write_free(a); archive_entry_free(entry);
        CHECK(extract("stream.zip") != 0);
        CHECK(queries == 3);
        return 0;
    } else return 1;
    CHECK(extract(argv[2]) != 0);
    CHECK(queries == (!strcmp(argv[1], "pressure") ? 2 : 1));
    return 0;
}
