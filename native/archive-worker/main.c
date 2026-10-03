/* App-owned streaming archive worker. Never invokes external filter programs. */
#include <archive.h>
#include <archive_entry.h>
#include <ctype.h>
#include <locale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#endif

#define WORKER_PROTOCOL 1
#define MAX_ENTRIES 1000000
#define MAX_BYTES ((uint64_t)1 << 40)
#define MIN_SPACE_RESERVE ((uint64_t)256 << 20)
#define SPACE_RECHECK_BYTES ((uint64_t)8 << 20)

static void json_string(const char *s) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static int fail(const char *code, const char *message) {
    printf("{\"error\":{\"code\":"); json_string(code);
    printf(",\"message\":"); json_string(message);
    puts("}}"); fflush(stdout); return 1;
}
static int archive_fail(struct archive *a) {
    return fail("EARCHIVE_FORMAT", archive_error_string(a));
}
static void progress(uint64_t entries, uint64_t bytes, int done) {
    /* Bounded event rate, also for archives containing millions of tiny files. */
    static time_t last;
    time_t now = time(NULL);
    if (!done && last == now) return;
    last = now;
    printf("{\"entries\":%llu,\"bytes\":%llu,\"done\":%s}\n",
           (unsigned long long)entries, (unsigned long long)bytes, done ? "true" : "false");
    fflush(stdout);
}
static int reserved(const char *s, size_t n) {
    char name[9]; size_t i = 0;
    while (i < n && i < sizeof(name) - 1 && s[i] != '.') { name[i] = (char)toupper((unsigned char)s[i]); i++; }
    name[i] = 0;
    return !strcmp(name, "CON") || !strcmp(name, "PRN") || !strcmp(name, "AUX") ||
           !strcmp(name, "NUL") || !strcmp(name, "CLOCK$") || !strcmp(name, "CONIN$") || !strcmp(name, "CONOUT$") ||
           ((!strncmp(name, "COM", 3) || !strncmp(name, "LPT", 3)) &&
           ((i == 4 && name[3] >= '1' && name[3] <= '9') || (i == 5 && (unsigned char)name[3] == 0xc2 &&
           ((unsigned char)name[4] == 0xb9 || (unsigned char)name[4] == 0xb2 || (unsigned char)name[4] == 0xb3))));
}
static int safe_path(const char *s) {
    if (!s || !*s || strlen(s) > 4096 || *s == '/' || *s == '\\') return 0;
    const char *start = s;
    for (const unsigned char *p = (const unsigned char *)s;; p++) {
        /* Reject Windows separators, ADS, devices and normalization aliases on all OSes. */
        if (*p == '\\' || *p == ':' || (*p && (*p < 32 || *p == 127))) return 0;
        if (*p == '/' || !*p) {
            size_t n = (const char *)p - start;
            if (n == 2 && !memcmp(start, "..", 2)) return 0;
            if (n && !(n == 1 && *start == '.') &&
                (start[n - 1] == '.' || start[n - 1] == ' ' || reserved(start, n))) return 0;
            if (!*p) break;
            start = (const char *)p + 1;
        }
    }
    return 1;
}
#ifdef _WIN32
static wchar_t *wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    wchar_t *w = n ? malloc(n * sizeof(wchar_t)) : NULL;
    if (w) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n);
    return w;
}
static FILE *open_file(const char *s) {
    wchar_t *w = wide(s);
    HANDLE h = w ? CreateFileW(w, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, NULL) : INVALID_HANDLE_VALUE;
    free(w); if (h == INVALID_HANDLE_VALUE) return NULL;
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(h, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) { CloseHandle(h); return NULL; }
    int fd = _open_osfhandle((intptr_t)h, _O_RDONLY | _O_BINARY);
    if (fd < 0) { CloseHandle(h); return NULL; }
    FILE *f = _fdopen(fd, "rb"); if (!f) _close(fd); return f;
}
#else
#include <fcntl.h>
#include <unistd.h>
#include <sys/statvfs.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
static FILE *open_file(const char *s) {
    int fd = open(s, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return NULL;
    FILE *f = fdopen(fd, "rb"); if (!f) close(fd); return f;
}
#endif
static int available_space(uint64_t *bytes) {
#ifdef _WIN32
    ULARGE_INTEGER available;
    if (!GetDiskFreeSpaceExW(L".", &available, NULL, NULL)) return 0;
    *bytes = available.QuadPart;
#else
    struct statvfs info;
    if (statvfs(".", &info)) return 0;
    uint64_t blocks = info.f_bavail, size = info.f_frsize;
    *bytes = size && blocks > UINT64_MAX / size ? UINT64_MAX : blocks * size;
#endif
    return 1;
}
/* Compile-time seam for deterministic disk-pressure tests, never a runtime override. */
#ifndef ARCHIVE_AVAILABLE_SPACE
#define ARCHIVE_AVAILABLE_SPACE available_space
#endif
static uint64_t space_reserve(uint64_t available) {
    return available / 10 > MIN_SPACE_RESERVE ? available / 10 : MIN_SPACE_RESERVE;
}
static uint64_t extraction_limit(uint64_t available, uint64_t reserve) {
    if (available <= reserve) return 0;
    return available - reserve < MAX_BYTES ? available - reserve : MAX_BYTES;
}
static int check_space(uint64_t reserve, uint64_t needed, uint64_t *remaining) {
    uint64_t available;
    if (!ARCHIVE_AVAILABLE_SPACE(&available)) return fail("EARCHIVE_SPACE", "Unable to query available space on the destination volume");
    if (available <= reserve || needed > available - reserve)
        return fail("EARCHIVE_SPACE", "Insufficient destination space while preserving the extraction reserve");
    *remaining = available - reserve;
    return 0;
}
static struct archive *reader(void) {
    struct archive *a = archive_read_new();
    /* Explicitly registered built-in readers/filters; no support_filter_program or *_all. */
    archive_read_support_format_zip(a);
    archive_read_support_format_tar(a);
    archive_read_support_format_rar(a);
    archive_read_support_format_rar5(a);
    archive_read_support_filter_none(a);
    archive_read_support_filter_gzip(a);
    return a;
}
static int extract(const char *source) {
    struct archive *a = reader(), *disk = archive_write_disk_new();
    struct archive_entry *entry; uint64_t entries = 0, bytes = 0, logical_bytes = 0;
    uint64_t available, reserve, limit, remaining = 0, since_space_check = 0;
    int result = 0, status;
    if (!ARCHIVE_AVAILABLE_SPACE(&available)) { result = fail("EARCHIVE_SPACE", "Unable to query available space on the destination volume"); goto end; }
    reserve = space_reserve(available); limit = extraction_limit(available, reserve);
    if (!limit) { result = fail("EARCHIVE_SPACE", "Insufficient destination space while preserving the extraction reserve"); goto end; }
    archive_write_disk_set_options(disk, ARCHIVE_EXTRACT_SECURE_NODOTDOT |
        ARCHIVE_EXTRACT_SECURE_NOABSOLUTEPATHS | ARCHIVE_EXTRACT_SECURE_SYMLINKS |
        ARCHIVE_EXTRACT_NO_OVERWRITE | ARCHIVE_EXTRACT_TIME);
    if (archive_read_open_filename(a, source, 65536) != ARCHIVE_OK) { result = archive_fail(a); goto end; }
    while ((status = archive_read_next_header(a, &entry)) != ARCHIVE_EOF) {
        if (status != ARCHIVE_OK) { result = archive_fail(a); goto end; }
        const char *name = archive_entry_pathname(entry);
        if (!safe_path(name)) { result = fail("EARCHIVE_UNSAFE_PATH", "Unsafe archive entry path"); goto end; }
        if (archive_entry_symlink(entry) || archive_entry_hardlink(entry) ||
            (archive_entry_filetype(entry) != AE_IFREG && archive_entry_filetype(entry) != AE_IFDIR)) {
            result = fail("EARCHIVE_UNSAFE_ENTRY", "Links and special files are not allowed in extracted archives"); goto end;
        }
        if (++entries > MAX_ENTRIES || archive_entry_size(entry) < 0 ||
            (uint64_t)archive_entry_size(entry) > limit - logical_bytes) {
            result = fail("EARCHIVE_LIMIT", "Archive exceeds extraction limits"); goto end;
        }
        uint64_t extent = (uint64_t)archive_entry_size(entry);
        if ((result = check_space(reserve, extent, &remaining))) goto end;
        since_space_check = 0;
        /* A tar root-directory record must not change the private staging root. */
        if (archive_entry_filetype(entry) == AE_IFDIR && strspn(name, "./") == strlen(name)) {
            if (archive_read_data_skip(a) != ARCHIVE_OK) { result = archive_fail(a); goto end; }
            continue;
        }
        /* Never apply ownership, ACLs, xattrs, file flags or setuid permissions. */
        archive_entry_set_perm(entry, archive_entry_filetype(entry) == AE_IFDIR ? 0755 : 0644);
        if (archive_write_header(disk, entry) != ARCHIVE_OK) { result = archive_fail(disk); goto end; }
        const void *block; size_t size; la_int64_t offset;
        while ((status = archive_read_data_block(a, &block, &size, &offset)) != ARCHIVE_EOF) {
            if (status != ARCHIVE_OK) { result = archive_fail(a); goto end; }
            if (offset < 0 || (uint64_t)offset > limit - logical_bytes || size > MAX_BYTES - bytes ||
                size > limit - logical_bytes - (uint64_t)offset) { result = fail("EARCHIVE_LIMIT", "Archive exceeds extraction limits"); goto end; }
            if ((uint64_t)offset + size > extent) extent = (uint64_t)offset + size;
            if (since_space_check >= SPACE_RECHECK_BYTES || size > remaining) {
                if ((result = check_space(reserve, size, &remaining))) goto end;
                since_space_check = 0;
            }
            if (archive_write_data_block(disk, block, size, offset) != ARCHIVE_OK) { result = archive_fail(disk); goto end; }
            remaining -= size; since_space_check += size;
            bytes += size; progress(entries, bytes, 0);
        }
        if (archive_write_finish_entry(disk) != ARCHIVE_OK) { result = archive_fail(disk); goto end; }
        logical_bytes += extent;
    }
    if (archive_write_close(disk) != ARCHIVE_OK) result = archive_fail(disk);
    if (!result) progress(entries, bytes, 1);
end:
    archive_read_free(a); archive_write_free(disk); return result;
}
static int source_prefix_matches(const char *path, const char *source) {
    while (*source) {
        char actual = *path++, expected = *source++;
#ifdef _WIN32
        /* archive_read_disk_windows normalizes entry path separators to '/'. */
        if (actual == '\\') actual = '/';
        if (expected == '\\') expected = '/';
#endif
        if (actual != expected) return 0;
    }
    return 1;
}
static int create_zip(const char *output, int count, char **sources) {
    struct archive *a = archive_write_new(); uint64_t entries = 0, bytes = 0; int result = 0;
    if (archive_write_set_format_zip(a) != ARCHIVE_OK ||
        archive_write_set_options(a, "zip:compression=deflate,zip:hdrcharset=UTF-8") != ARCHIVE_OK) {
        result = archive_fail(a); goto end;
    }
    if (archive_write_open_filename(a, output) != ARCHIVE_OK) { result = archive_fail(a); goto end; }
    for (int i = 0; i < count; i++) {
        struct archive *disk = archive_read_disk_new(); struct archive_entry *entry = archive_entry_new();
        archive_read_disk_set_symlink_physical(disk);
        archive_read_disk_set_behavior(disk, ARCHIVE_READDISK_NO_ACL | ARCHIVE_READDISK_NO_XATTR |
            ARCHIVE_READDISK_NO_FFLAGS | ARCHIVE_READDISK_NO_SPARSE);
        const char *base = strrchr(sources[i], '/');
#ifdef _WIN32
        const char *back = strrchr(sources[i], '\\'); if (back && (!base || back > base)) base = back;
#endif
        base = base ? base + 1 : sources[i];
        if (!safe_path(base) || !strcmp(base, ".") || !strcmp(base, "..")) {
            result = fail("EINVAL", "Invalid source name"); goto source_end;
        }
        if (archive_read_disk_open(disk, sources[i]) != ARCHIVE_OK) { result = archive_fail(disk); goto source_end; }
        int status;
        while ((status = archive_read_next_header2(disk, entry)) != ARCHIVE_EOF) {
            if (status != ARCHIVE_OK) { result = archive_fail(disk); goto source_end; }
            const char *physical = archive_entry_sourcepath(entry);
            const char *original = archive_entry_pathname(entry);
            size_t prefix = strlen(sources[i]) - strlen(base);
            if (!original || !source_prefix_matches(original, sources[i]) || strlen(original) < prefix) {
                result = fail("EINVAL", "Invalid source traversal"); goto source_end;
            }
            char *relative = strdup(original + prefix);
#ifdef _WIN32
            for (char *p = relative; *p; p++) if (*p == '\\') *p = '/';
#endif
            if (!safe_path(relative) || (archive_entry_filetype(entry) != AE_IFREG && archive_entry_filetype(entry) != AE_IFDIR)) {
                free(relative);
                result = fail("EARCHIVE_UNSAFE_ENTRY", "ZIP creation supports regular files and folders only"); goto source_end;
            }
            if (++entries > MAX_ENTRIES) { result = fail("EARCHIVE_LIMIT", "Too many archive entries"); goto source_end; }
            archive_entry_set_pathname(entry, relative);
            free(relative);
            if (archive_write_header(a, entry) != ARCHIVE_OK) { result = archive_fail(a); goto source_end; }
            if (archive_entry_filetype(entry) == AE_IFREG) {
                FILE *file = open_file(physical);
                if (!file) { result = fail("EARCHIVE_READ", "Unable to read source file"); goto source_end; }
                char buffer[65536]; size_t n;
                while ((n = fread(buffer, 1, sizeof(buffer), file))) {
                    if (n > MAX_BYTES - bytes) { result = fail("EARCHIVE_LIMIT", "Archive exceeds creation limits"); break; }
                    if (archive_write_data(a, buffer, n) != (la_ssize_t)n) { result = archive_fail(a); break; }
                    bytes += n; progress(entries, bytes, 0);
                }
                if (ferror(file) && !result) result = fail("EARCHIVE_READ", "Unable to read source file");
                fclose(file); if (result) goto source_end;
            }
            if (archive_write_finish_entry(a) != ARCHIVE_OK) { result = archive_fail(a); goto source_end; }
            if (archive_read_disk_can_descend(disk)) archive_read_disk_descend(disk);
            archive_entry_clear(entry);
        }
source_end:
        archive_entry_free(entry); archive_read_free(disk); if (result) goto end;
    }
    if (archive_write_close(a) != ARCHIVE_OK) result = archive_fail(a);
    if (!result) progress(entries, bytes, 1);
end:
    archive_write_free(a); return result;
}
static int run(int argc, char **argv) {
#ifdef _WIN32
    setlocale(LC_ALL, ".UTF8");
#else
    setlocale(LC_ALL, "");
#endif
    if (argc == 2 && !strcmp(argv[1], "--version")) {
        printf("vesperwind-archive/%d libarchive/%s zip,tar,tgz,rar,rar5\n", WORKER_PROTOCOL, archive_version_string()); return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "extract")) return extract(argv[2]);
    if (argc >= 4 && !strcmp(argv[1], "create")) return create_zip(argv[2], argc - 3, argv + 3);
    if (argc == 4 && !strcmp(argv[1], "publish")) {
        int status;
#ifdef _WIN32
        wchar_t *source = wide(argv[2]), *target = wide(argv[3]);
        status = !source || !target || !MoveFileExW(source, target, 0);
        free(source); free(target);
#elif defined(__APPLE__)
        status = renamex_np(argv[2], argv[3], RENAME_EXCL);
#elif defined(__linux__)
        status = syscall(SYS_renameat2, AT_FDCWD, argv[2], AT_FDCWD, argv[3], 1);
#else
        return fail("ENOTSUPPORTED", "Atomic publication is unavailable on this OS");
#endif
        if (status) return fail("EARCHIVE_PUBLISH", "Cannot publish archive result; destination may already exist or be unavailable");
        return 0;
    }
    return fail("EINVAL", "Invalid archive worker arguments");
}
#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
    SetConsoleOutputCP(CP_UTF8); setlocale(LC_ALL, ".UTF8");
    char **args = calloc(argc, sizeof(char *));
    for (int i = 0; i < argc; i++) {
        int n = WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, NULL, 0, NULL, NULL);
        args[i] = malloc(n); WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, args[i], n, NULL, NULL);
    }
    int status = run(argc, args);
    for (int i = 0; i < argc; i++) free(args[i]); free(args); return status;
}
#else
int main(int argc, char **argv) { return run(argc, argv); }
#endif
