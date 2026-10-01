/* Experimental embedding probe, not a Tauri UI/display acceptance test.
 * Build with headers from the pinned build prefix and link bundled libmpv.
 * SPDX-License-Identifier: MIT */
#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalLayer.h>
#include <mpv/client.h>
#include <stdio.h>
#include <inttypes.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>

static void option(mpv_handle *mpv, const char *name, const char *value) {
    int result = mpv_set_option_string(mpv, name, value);
    if (result < 0) { fprintf(stderr, "%s: %s\n", name, mpv_error_string(result)); exit(2); }
}
static void command(mpv_handle *mpv, const char **args) {
    int result = mpv_command(mpv, args);
    if (result < 0) { fprintf(stderr, "%s: %s\n", args[0], mpv_error_string(result)); exit(3); }
}
static void pump(double seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([end timeIntervalSinceNow] > 0)
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}
static char *property(mpv_handle *mpv, const char *name) {
    char *value = mpv_get_property_string(mpv, name);
    printf("%s=%s\n", name, value ? value : "unavailable");
    return value;
}
int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "Usage: probe-libmpv-macvk video [another-video]\n"); return 2; }
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSRect rect = NSMakeRect(0, 0, 640, 360);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:rect
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
            backing:NSBackingStoreBuffered defer:NO];
        NSView *host = [[NSView alloc] initWithFrame:rect];
        CAMetalLayer *layer = [[CAMetalLayer alloc] init];
        host.layer = layer; host.wantsLayer = YES;
        layer.drawableSize = CGSizeMake(640, 360);
        window.contentView = host; [window orderFront:nil];
        for (int cycle = 0; cycle < 3; cycle++) {
            mpv_handle *mpv = mpv_create();
            if (!mpv) return 2;
            char pointer[40]; snprintf(pointer, sizeof(pointer), "%" PRIdPTR, (intptr_t)layer);
            option(mpv, "config", "no"); option(mpv, "terminal", "yes");
            option(mpv, "msg-level", "all=warn,vo/gpu-next=v");
            option(mpv, "vo", "gpu-next"); option(mpv, "gpu-api", "vulkan");
            option(mpv, "gpu-context", "macvk-embedded"); option(mpv, "wid", pointer);
            option(mpv, "vulkan-swap-mode", "fifo"); option(mpv, "hwdec", "auto-safe");
            option(mpv, "ao", "null"); option(mpv, "keep-open", "yes");
            option(mpv, "pause", "yes");
            option(mpv, "target-colorspace-hint", "yes");
            option(mpv, "target-colorspace-hint-mode", "target");
            option(mpv, "target-colorspace-hint-strict", "yes");
            option(mpv, "target-trc", "srgb"); option(mpv, "target-prim", "bt.709");
            if (mpv_initialize(mpv) < 0) return 3;
            for (int file = 1; file < argc; file++) {
                printf("source=%s\n", argv[file]);
                while (mpv_wait_event(mpv, 0)->event_id != MPV_EVENT_NONE) {}
                const char *load[] = {"loadfile", argv[file], "replace", NULL}; command(mpv, load);
                bool configured = false, loaded = false, reconfigured = false;
                for (int tick = 0; tick < 1000; tick++) {
                    pump(0.01);
                    mpv_event *event = mpv_wait_event(mpv, 0);
                    if (event->event_id == MPV_EVENT_END_FILE && ((mpv_event_end_file *)event->data)->error < 0) {
                        fprintf(stderr, "VO/source initialization failed\n"); mpv_terminate_destroy(mpv); return 4;
                    }
                    loaded |= event->event_id == MPV_EVENT_FILE_LOADED;
                    reconfigured |= event->event_id == MPV_EVENT_VIDEO_RECONFIG;
                    int flag = 0;
                    if (loaded && reconfigured && mpv_get_property(mpv, "vo-configured", MPV_FORMAT_FLAG, &flag) >= 0 && flag) { configured = true; break; }
                }
                if (!configured) { fprintf(stderr, "VO timeout\n"); mpv_terminate_destroy(mpv); return 4; }
                char *vo = property(mpv, "current-vo"), *context = property(mpv, "current-gpu-context");
                if (!vo || strcmp(vo, "gpu-next") || !context || strcmp(context, "macvk-embedded")) return 5;
                mpv_free(vo); mpv_free(context);
                mpv_free(property(mpv, "hwdec-current"));
                mpv_free(property(mpv, "video-params"));
                mpv_free(property(mpv, "video-target-params"));
                CFStringRef sdr_name = layer.colorspace ? CGColorSpaceCopyName(layer.colorspace) : NULL;
                printf("SDR layer colorspace=%s wantsEDR=%d currentHeadroom=%.2f potentialHeadroom=%.2f\n",
                    sdr_name ? [(NSString *)sdr_name UTF8String] : "unavailable", layer.wantsExtendedDynamicRangeContent,
                    window.screen.maximumExtendedDynamicRangeColorComponentValue,
                    window.screen.maximumPotentialExtendedDynamicRangeColorComponentValue);
                if (sdr_name) CFRelease(sdr_name);
                // Paused resize must be observed by the VO, without delegate callbacks.
                [host setFrameSize:NSMakeSize(800, 450)]; layer.drawableSize = CGSizeMake(800, 450);
                int64_t width = 0, height = 0;
                // First shader compilation can exceed a single 300ms wait.
                for (int tick = 0; tick < 200; tick++) {
                    pump(0.01);
                    mpv_get_property(mpv, "osd-width", MPV_FORMAT_INT64, &width);
                    mpv_get_property(mpv, "osd-height", MPV_FORMAT_INT64, &height);
                    if (width == 800 && height == 450) break;
                }
                if (width != 800 || height != 450) { fprintf(stderr, "Paused resize failed: %lldx%lld\n", (long long)width, (long long)height); return 6; }
                option(mpv, "pause", "no"); pump(0.25); option(mpv, "pause", "yes");
                const char *seek[] = {"seek", "1", "absolute+exact", NULL}; command(mpv, seek); pump(0.2);
                double position = 0, duration = 0;
                int paused = 0;
                mpv_get_property(mpv, "duration", MPV_FORMAT_DOUBLE, &duration);
                mpv_get_property(mpv, "pause", MPV_FORMAT_FLAG, &paused);
                if (mpv_get_property(mpv, "time-pos", MPV_FORMAT_DOUBLE, &position) < 0 || !paused
                    || fabs(position - fmin(1.0, duration)) > 0.15) {
                    fprintf(stderr, "Paused exact seek failed: position=%f duration=%f paused=%d\n", position, duration, paused);
                    mpv_terminate_destroy(mpv); return 7;
                }
                mpv_free(property(mpv, "time-pos"));
                // Test negotiated HDR hint/surface state separately from source decoding.
                option(mpv, "target-trc", "pq"); option(mpv, "target-prim", "bt.2020"); pump(0.3);
                CFStringRef name = layer.colorspace ? CGColorSpaceCopyName(layer.colorspace) : NULL;
                printf("Metal pixelFormat=%lu colorspace=%s wantsEDR=%d metadata=%d\n", (unsigned long)layer.pixelFormat,
                    name ? [(NSString *)name UTF8String] : "unavailable",
                    layer.wantsExtendedDynamicRangeContent, layer.EDRMetadata != nil);
                if (name) CFRelease(name);
                option(mpv, "target-trc", "srgb"); option(mpv, "target-prim", "bt.709"); pump(0.1);
            }
            // Exercise shutdown with a hidden surface while playback is active.
            option(mpv, "pause", "no"); pump(0.1); host.hidden = YES; pump(0.05);
            mpv_terminate_destroy(mpv); host.hidden = NO; pump(0.1);
            printf("cycle=%d complete (owned VO, paused resize, play/pause/seek, source switching, shutdown)\n", cycle + 1);
        }
        [window orderOut:nil]; [host release]; [layer release]; [window release];
    }
    return 0;
}
