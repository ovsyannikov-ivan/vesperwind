/* Build-time evidence that mpv, compiled against these libplacebo and FFmpeg
 * headers, maps FFmpeg's AVDOVIMetadata (PL_HAVE_LAV_DOLBY_VISION). The libav
 * helpers are static inline, so the define is the only inspectable fact.
 * Declarations only: GCC would otherwise emit the helpers, which need FFmpeg
 * and libplacebo at link time. */
#define PL_LIBAV_IMPLEMENTATION 0
#include <stdio.h>
#include <libplacebo/utils/libav.h>

int main(void)
{
#ifdef PL_HAVE_LAV_DOLBY_VISION
    printf("mpv Dolby Vision metadata mapping: PL_HAVE_LAV_DOLBY_VISION defined (PL_API_VER %d)\n", PL_API_VER);
    return 0;
#else
    fprintf(stderr, "PL_HAVE_LAV_DOLBY_VISION is not defined\n");
    return 1;
#endif
}
