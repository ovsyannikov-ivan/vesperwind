/* Dolby Vision runtime evidence probe for the bundled macOS libmpv: plays a
 * local file through the production gpu-next / macvk-embedded path and prints
 * the mpv properties that show whether the RPU is mapped and reshaped. It is
 * not a display or color-accuracy test. Build like probe-libmpv-macvk.m.
 * Usage: probe-libmpv-dovi-runtime video [start-seconds] [pq|srgb]; PROBE_HWDEC=no
 * selects software decoding.
 * SPDX-License-Identifier: MIT */
#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalLayer.h>
#include <mpv/client.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static void option(mpv_handle *mpv, const char *name, const char *value) {
    int result = mpv_set_option_string(mpv, name, value);
    if (result < 0) { fprintf(stderr, "%s: %s\n", name, mpv_error_string(result)); exit(2); }
}
static void pump(double seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([end timeIntervalSinceNow] > 0)
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}
static void property(mpv_handle *mpv, const char *name) {
    char *value = mpv_get_property_string(mpv, name);
    printf("%s=%s\n", name, value ? value : "unavailable");
    mpv_free(value);
}
// Only Dolby Vision related log lines; mpv logs them once per reconfiguration.
static void drain_log(mpv_handle *mpv) {
    for (mpv_event *event = mpv_wait_event(mpv, 0); event->event_id != MPV_EVENT_NONE;
         event = mpv_wait_event(mpv, 0)) {
        if (event->event_id != MPV_EVENT_LOG_MESSAGE) continue;
        mpv_event_log_message *message = event->data;
        if (strcasestr(message->text, "dolby") || strcasestr(message->text, "dovi")
            || strcasestr(message->text, "rpu"))
            printf("log[%s/%s] %s", message->prefix, message->level, message->text);
    }
}
int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "Usage: probe-libmpv-dovi-runtime video [start] [pq|srgb]\n"); return 2; }
    const char *start = argc > 2 ? argv[2] : "600";
    bool pq = argc > 3 && !strcmp(argv[3], "pq");
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSRect rect = NSMakeRect(0, 0, 960, 540);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:rect
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        NSView *host = [[NSView alloc] initWithFrame:rect];
        CAMetalLayer *layer = [[CAMetalLayer alloc] init];
        host.layer = layer; host.wantsLayer = YES;
        layer.drawableSize = CGSizeMake(960, 540);
        window.contentView = host; [window orderFront:nil];
        mpv_handle *mpv = mpv_create();
        if (!mpv) return 2;
        char pointer[40]; snprintf(pointer, sizeof(pointer), "%" PRIdPTR, (intptr_t)layer);
        option(mpv, "config", "no"); option(mpv, "terminal", "no");
        option(mpv, "vo", "gpu-next"); option(mpv, "gpu-api", "vulkan");
        option(mpv, "gpu-context", "macvk-embedded"); option(mpv, "wid", pointer);
        option(mpv, "hwdec", getenv("PROBE_HWDEC") ? getenv("PROBE_HWDEC") : "auto-safe");
        option(mpv, "ao", "null"); option(mpv, "keep-open", "yes"); option(mpv, "pause", "yes");
        option(mpv, "start", start);
        option(mpv, "target-colorspace-hint", "yes");
        option(mpv, "target-trc", pq ? "pq" : "srgb"); option(mpv, "target-prim", pq ? "bt.2020" : "bt.709");
        if (mpv_initialize(mpv) < 0) return 3;
        mpv_request_log_messages(mpv, "v");
        const char *load[] = {"loadfile", argv[1], "replace", NULL};
        if (mpv_command(mpv, load) < 0) return 3;
        bool configured = false;
        for (int tick = 0; tick < 3000 && !configured; tick++) {
            pump(0.01);
            int flag = 0;
            configured = mpv_get_property(mpv, "vo-configured", MPV_FORMAT_FLAG, &flag) >= 0 && flag;
        }
        if (!configured) { fprintf(stderr, "VO timeout\n"); return 4; }
        option(mpv, "pause", "no"); pump(2.0); option(mpv, "pause", "yes"); pump(0.3);
        drain_log(mpv);
        for (const char **name = (const char *[]){
                 "current-vo", "current-gpu-context", "hwdec-current",
                 "current-tracks/video/dolby-vision-profile", "current-tracks/video/dolby-vision-level",
                 "video-dec-params/colormatrix", "video-params/colormatrix", "video-params/gamma",
                 "video-params/primaries", "video-params/max-luma", "video-target-params/gamma",
                 "video-target-params/primaries", "video-target-params/max-luma", "time-pos",
                 "frame-drop-count", "decoder-frame-drop-count", NULL}; *name; name++)
            property(mpv, *name);
        // The swapchain the renderer negotiated, independent of mpv's target.
        CFStringRef space = layer.colorspace ? CGColorSpaceCopyName(layer.colorspace) : NULL;
        printf("Metal pixelFormat=%lu colorspace=%s wantsEDR=%d\n", (unsigned long)layer.pixelFormat,
            space ? [(NSString *)space UTF8String] : "unavailable", layer.wantsExtendedDynamicRangeContent);
        if (space) CFRelease(space);
        mpv_terminate_destroy(mpv);
        [window orderOut:nil]; [host release]; [layer release]; [window release];
    }
    return 0;
}
