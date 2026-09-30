#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <stdio.h>
int main(void) {
    int h264 = 0, hevc = 0;
    void *opaque = NULL;
    const AVCodec *codec;
    while ((codec = av_codec_iterate(&opaque))) {
        if (!av_codec_is_decoder(codec)) continue;
        for (int i = 0;; i++) {
            const AVCodecHWConfig *config = avcodec_get_hw_config(codec, i);
            if (!config) break;
            if (config->device_type != AV_HWDEVICE_TYPE_D3D11VA) continue;
            if (codec->id == AV_CODEC_ID_H264) h264 = 1;
            if (codec->id == AV_CODEC_ID_HEVC) hevc = 1;
        }
    }
    printf("{\"h264\":%s,\"hevc\":%s}\n", h264 ? "true" : "false", hevc ? "true" : "false");
    return h264 && hevc ? 0 : 1;
}
