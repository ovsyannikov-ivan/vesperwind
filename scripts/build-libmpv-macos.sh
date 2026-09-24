#!/usr/bin/env bash
set -euo pipefail

# Reproducible arm64 macOS libmpv runtime used by the Tauri bundle. This build
# intentionally excludes GPL/non-free components. See docs/libmpv.md before
# changing any source, version, or configure flag.

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script currently builds the arm64 macOS runtime only." >&2
  exit 1
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
work_root="${VESPERWIND_LIBMPV_BUILD_DIR:-/private/tmp/vesperwind-libmpv-build}"
source_root="$work_root/src"
archive_root="$work_root/archives"
build_root="$work_root/build"
prefix="$work_root/prefix"
venv="$work_root/venv"
bundle="$project_root/src-tauri/vendor/libmpv/macos"
deployment_target="12.0"

developer_dir="${DEVELOPER_DIR:-$(xcode-select -p)}"
if [[ ! -x "$developer_dir/usr/bin/xcodebuild" ]]; then
  cat >&2 <<EOF
Vesperwind's VideoToolbox-enabled libmpv runtime requires the full Xcode SDK.
The active developer directory is:
  $developer_dir

Install/open Xcode, then run this script with either:
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
or:
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer $0
EOF
  exit 1
fi
export DEVELOPER_DIR="$developer_dir"
sdk_root="$(xcrun --sdk macosx --show-sdk-path)"
sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
xcode_version="$(xcodebuild -version | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
cmake_bin="$(command -v cmake)"
pkg_config_bin="$(command -v pkg-config)"
build_tools_bin="$(dirname "$cmake_bin")"
if [[ "$(dirname "$pkg_config_bin")" != "$build_tools_bin" ]]; then
  echo "cmake and pkg-config must be installed in the same build-tools directory" >&2
  exit 1
fi

mpv_commit="2c219aa822df18a1b7fd9abe3e151cd93ad67307"
libplacebo_commit="3188549fba13bbdf3a5a98de2a38c2e71f04e21e"

mkdir -p "$source_root" "$archive_root" "$build_root" "$prefix" "$bundle/LICENSES"
# Remove artifacts produced by the former deprecated OpenAL compatibility shim.
rm -rf "$prefix/include/AL"
rm -f "$prefix/lib/pkgconfig/openal.pc"

download() {
  local name="$1"
  local url="$2"
  local sha256="$3"
  local destination="$archive_root/$name"
  if [[ ! -f "$destination" ]]; then
    curl --fail --location --retry 3 --output "$destination" "$url"
  fi
  local actual
  actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
  if [[ "$actual" != "$sha256" ]]; then
    echo "Checksum mismatch for $name: $actual" >&2
    exit 1
  fi
}

extract() {
  local archive="$1" destination="$2"
  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xzf "$archive_root/$archive" --strip-components=1 -C "$destination"
}

download mpv.tar.gz \
  "https://codeload.github.com/mpv-player/mpv/tar.gz/$mpv_commit" \
  "9ef6644ce3ac76b07bf768cc84d31a371ad52aadc5f725167dcbe040fd6d2d5f"
download ffmpeg.tar.gz \
  "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n8.0" \
  "dd4030dbfdc34d9ff255a116bdd1caade42500ac2981efa27f8b151cc54c7b9e"
download freetype.tar.gz \
  "https://codeload.github.com/freetype/freetype/tar.gz/refs/tags/VER-2-14-1" \
  "44bd69d1f0750603410cfd4f26f1c5523c5a3a087a2dfa8639b757dc7c6677be"
download fribidi.tar.gz \
  "https://codeload.github.com/fribidi/fribidi/tar.gz/refs/tags/v1.0.16" \
  "5a1d187a33daa58fcee2ad77f0eb9d136dd6fa4096239199ba31e850d397e8a8"
download harfbuzz.tar.gz \
  "https://codeload.github.com/harfbuzz/harfbuzz/tar.gz/refs/tags/11.5.0" \
  "119778e3a692806e45104b2cdfda807a8df2ccf5421c50a016aa4b7b82260205"
download libass.tar.gz \
  "https://codeload.github.com/libass/libass/tar.gz/refs/tags/0.17.4" \
  "c287d180d93dc9c9021872574b618ac49027e84cc90e1289318b1ee68bb42251"

extract mpv.tar.gz "$source_root/mpv"
extract ffmpeg.tar.gz "$source_root/ffmpeg"
extract freetype.tar.gz "$source_root/freetype"
extract fribidi.tar.gz "$source_root/fribidi"
extract harfbuzz.tar.gz "$source_root/harfbuzz"
extract libass.tar.gz "$source_root/libass"

# mpv normally pulls these CoreFoundation string helpers through its Cocoa UI
# feature. A headless libmpv build with CoreAudio also uses them, so include the
# implementation in the CoreAudio source set without enabling mpv's Cocoa UI.
perl -0pi -e "s!'audio/out/ao_coreaudio_properties.c'\)!'audio/out/ao_coreaudio_properties.c',\n                     'osdep/utils-mac.c')!" \
  "$source_root/mpv/meson.build"

# mpv 0.41's CoreAudio channel-map call returns paramErr on macOS 27 and
# disables audio even though AAC is decoded. Revert that upstream call until
# mpv ships a compatible fix (mpv-player/mpv#18384).
patch --directory="$source_root/mpv" -p1 \
  < "$project_root/scripts/patches/mpv-macos27-coreaudio.patch"

rm -rf "$source_root/libplacebo"
git clone --quiet --filter=blob:none --recurse-submodules \
  --branch v7.351.0 --single-branch \
  https://code.videolan.org/videolan/libplacebo.git "$source_root/libplacebo"
if [[ "$(git -C "$source_root/libplacebo" rev-parse HEAD)" != "$libplacebo_commit" ]]; then
  echo "Unexpected libplacebo commit" >&2
  exit 1
fi

python3 -m venv "$venv"
"$venv/bin/python" -m pip install --disable-pip-version-check \
  "meson==1.9.1" "ninja==1.13.0"
export PATH="$venv/bin:$build_tools_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export CMAKE_PREFIX_PATH="$prefix"
export MACOSX_DEPLOYMENT_TARGET="$deployment_target"
common_cflags="-O2 -mmacosx-version-min=$deployment_target -isysroot $sdk_root"
common_link_args="-mmacosx-version-min=$deployment_target -isysroot $sdk_root"

cmake -S "$source_root/freetype" -B "$build_root/freetype" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment_target" \
  -DCMAKE_OSX_SYSROOT="$sdk_root" \
  -DBUILD_SHARED_LIBS=ON \
  -DFT_DISABLE_ZLIB=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON \
  -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON
cmake --build "$build_root/freetype" --parallel
cmake --install "$build_root/freetype"

meson setup --wipe "$build_root/fribidi" "$source_root/fribidi" \
  --prefix "$prefix" --buildtype release --default-library shared \
  -Dc_args="$common_cflags" \
  -Dc_link_args="$common_link_args" \
  -Ddocs=false -Dbin=false -Dtests=false
meson compile -C "$build_root/fribidi"
meson install -C "$build_root/fribidi"

meson setup --wipe "$build_root/harfbuzz" "$source_root/harfbuzz" \
  --prefix "$prefix" --buildtype release --default-library shared \
  -Dc_args="$common_cflags" \
  -Dcpp_args="$common_cflags" \
  -Dc_link_args="$common_link_args" \
  -Dcpp_link_args="$common_link_args" \
  -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
  -Dicu=disabled -Dgraphite2=disabled -Dfreetype=enabled \
  -Dcoretext=disabled -Dtests=disabled -Ddocs=disabled \
  -Dutilities=disabled -Dintrospection=disabled
meson compile -C "$build_root/harfbuzz"
meson install -C "$build_root/harfbuzz"

# Avoid the broad ApplicationServices umbrella: Vesperwind targets macOS 12+
# and libass only needs the CoreText declaration on this build path.
perl -0pi -e 's!#include <ApplicationServices/ApplicationServices.h>!#include <CoreText/CoreText.h>!' \
  "$source_root/libass/libass/ass_coretext.c"
meson setup --wipe "$build_root/libass" "$source_root/libass" \
  --prefix "$prefix" --buildtype release --default-library shared \
  -Dc_args="$common_cflags" \
  -Dc_link_args="$common_link_args" \
  -Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled \
  -Dcheckasm=disabled -Dfontconfig=disabled -Dcoretext=enabled \
  -Dlibunibreak=disabled
meson compile -C "$build_root/libass"
meson install -C "$build_root/libass"

(
  cd "$source_root/ffmpeg"
  ./configure --prefix="$prefix" --cc=/usr/bin/clang --cxx=/usr/bin/clang++ \
    --enable-shared --disable-static --disable-programs --disable-doc \
    --disable-debug --disable-autodetect --disable-gpl --disable-nonfree \
    --disable-version3 --enable-videotoolbox --disable-audiotoolbox \
    --enable-pic --extra-cflags="$common_cflags" \
    --extra-ldflags="$common_link_args" | tee "$build_root/ffmpeg-configure.txt"
  grep -q '^#define CONFIG_VIDEOTOOLBOX 1$' config.h
  grep -q '^#define CONFIG_H264_VIDEOTOOLBOX_HWACCEL 1$' config_components.h
  grep -q '^#define CONFIG_HEVC_VIDEOTOOLBOX_HWACCEL 1$' config_components.h
  make -j"$(sysctl -n hw.logicalcpu)"
  make install
)

cat > "$build_root/verify-videotoolbox.c" <<'EOF'
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int found_device = 0;
    int found_h264 = 0;
    int found_hevc = 0;
    enum AVHWDeviceType type = AV_HWDEVICE_TYPE_NONE;
    while ((type = av_hwdevice_iterate_types(type)) != AV_HWDEVICE_TYPE_NONE) {
        const char *name = av_hwdevice_get_type_name(type);
        if (name && strcmp(name, "videotoolbox") == 0) {
            printf("Available hwaccel: %s\n", name);
            found_device = 1;
        }
    }

    void *opaque = NULL;
    const AVCodec *codec = NULL;
    while ((codec = av_codec_iterate(&opaque))) {
        if (!av_codec_is_decoder(codec)) continue;
        for (int index = 0;; index++) {
            const AVCodecHWConfig *config = avcodec_get_hw_config(codec, index);
            if (!config) break;
            if (config->device_type != AV_HWDEVICE_TYPE_VIDEOTOOLBOX) continue;
            if (codec->id == AV_CODEC_ID_H264) found_h264 = 1;
            if (codec->id == AV_CODEC_ID_HEVC) found_hevc = 1;
        }
    }
    printf("libavcodec VideoToolbox decoders: h264=%s hevc=%s\n",
           found_h264 ? "yes" : "no", found_hevc ? "yes" : "no");
    return found_device && found_h264 && found_hevc ? 0 : 1;
}
EOF
/usr/bin/clang "$build_root/verify-videotoolbox.c" \
  -I"$prefix/include" -L"$prefix/lib" \
  -Wl,-rpath,"$prefix/lib" -lavcodec -lavutil \
  -o "$build_root/verify-videotoolbox"
DYLD_LIBRARY_PATH="$prefix/lib" "$build_root/verify-videotoolbox" \
  | tee "$build_root/videotoolbox-probe.txt"

meson setup --wipe "$build_root/libplacebo" "$source_root/libplacebo" \
  --prefix "$prefix" --buildtype release --default-library shared \
  -Dc_args="$common_cflags" \
  -Dcpp_args="$common_cflags" \
  -Dc_link_args="$common_link_args" \
  -Dcpp_link_args="$common_link_args" \
  -Dvulkan=disabled -Dopengl=enabled -Dgl-proc-addr=enabled \
  -Dd3d11=disabled -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled \
  -Ddovi=disabled -Dlibdovi=disabled -Ddemos=false -Dtests=false \
  -Dbench=false -Dfuzz=false -Dunwind=disabled -Dxxhash=disabled
meson compile -C "$build_root/libplacebo"
meson install -C "$build_root/libplacebo"

meson setup --wipe "$build_root/mpv" "$source_root/mpv" \
  --prefix "$prefix" --buildtype release --default-library shared \
  -Dc_args="$common_cflags" \
  -Dc_link_args="$common_link_args" \
  -Dobjc_args="$common_cflags" \
  -Dobjc_link_args="$common_link_args" \
  -Dgpl=false -Dcplayer=false -Dlibmpv=true -Dbuild-date=false -Dtests=false \
  -Dcplugins=disabled -Dcdda=disabled -Ddvdnav=disabled -Djavascript=disabled \
  -Djpeg=disabled -Dlcms2=disabled -Dlibarchive=disabled -Dlibavdevice=disabled \
  -Dlibbluray=disabled -Dlua=disabled -Drubberband=disabled \
  -Duchardet=disabled -Dvapoursynth=disabled -Dzimg=disabled -Dzlib=disabled \
  -Diconv=enabled -Dcoreaudio=enabled -Daudiounit=disabled \
  -Davfoundation=enabled -Dopenal=disabled -Dcocoa=disabled -Dgl=enabled \
  -Dplain-gl=enabled -Dgl-cocoa=disabled -Dvulkan=disabled \
  -Dvideotoolbox-gl=disabled -Dvideotoolbox-pl=disabled \
  -Dswift-build=disabled -Dmacos-cocoa-cb=disabled \
  -Dmacos-media-player=disabled -Dmacos-touchbar=disabled \
  -Dmanpage-build=disabled
meson compile -C "$build_root/mpv"
meson install -C "$build_root/mpv"

libraries=(
  libmpv.2.dylib libass.9.dylib libavcodec.62.dylib libavfilter.11.dylib
  libavformat.62.dylib libavutil.60.dylib libplacebo.351.dylib
  libswresample.6.dylib libswscale.9.dylib libfreetype.6.dylib
  libfribidi.0.dylib libharfbuzz.0.dylib
)
rm -f "$bundle"/*.dylib
for library in "${libraries[@]}"; do
  cp "$prefix/lib/$library" "$bundle/$library"
done
xattr -cr "$bundle"
find "$project_root/src-tauri/vendor/libmpv" -name .DS_Store -delete

for file in "$bundle"/*.dylib; do
  install_name_tool -id "@loader_path/$(basename "$file")" "$file"
  for library in "${libraries[@]}"; do
    install_name_tool -change "$prefix/lib/$library" "@loader_path/$library" "$file" 2>/dev/null || true
    install_name_tool -change "@rpath/$library" "@loader_path/$library" "$file" 2>/dev/null || true
  done
  codesign --force --sign - "$file"
done

rm -rf "$bundle/LICENSES"
mkdir -p "$bundle/LICENSES"
cp "$source_root/mpv/LICENSE.LGPL" "$bundle/LICENSES/mpv-LGPL-2.1.txt"
cp "$source_root/mpv/Copyright" "$bundle/LICENSES/mpv-Copyright.txt"
cp "$source_root/ffmpeg/COPYING.LGPLv2.1" "$bundle/LICENSES/FFmpeg-LGPL-2.1.txt"
cp "$source_root/ffmpeg/LICENSE.md" "$bundle/LICENSES/FFmpeg-LICENSE.md"
cp "$source_root/freetype/LICENSE.TXT" "$bundle/LICENSES/FreeType-LICENSE.txt"
cp "$source_root/fribidi/COPYING" "$bundle/LICENSES/FriBidi-LGPL-2.1.txt"
cp "$source_root/harfbuzz/COPYING" "$bundle/LICENSES/HarfBuzz-COPYING.txt"
cp "$source_root/libass/COPYING" "$bundle/LICENSES/libass-ISC.txt"
cp "$source_root/libplacebo/LICENSE" "$bundle/LICENSES/libplacebo-LGPL-2.1.txt"

cat > "$bundle/BUILD-INFO.txt" <<EOF
Vesperwind bundled macOS libmpv build
Xcode: $xcode_version
macOS SDK: $sdk_version
Deployment target: $deployment_target
FFmpeg configuration: --disable-gpl --disable-nonfree --disable-version3 --enable-videotoolbox
FFmpeg config: CONFIG_VIDEOTOOLBOX=1
FFmpeg config: CONFIG_H264_VIDEOTOOLBOX_HWACCEL=1
FFmpeg config: CONFIG_HEVC_VIDEOTOOLBOX_HWACCEL=1
$(cat "$build_root/videotoolbox-probe.txt")
mpv hwdec policy: auto-copy-safe (software fallback retained)
mpv video output: vo=libmpv (OpenGL Render API)
mpv audio output: CoreAudio, AVFoundation fallback
mpv macOS 27 CoreAudio patch: scripts/patches/mpv-macos27-coreaudio.patch
EOF

cat > "$bundle/SOURCE-OFFER.txt" <<EOF
Vesperwind libmpv runtime source and relinking information

The complete corresponding source, exact version pins, local source patches, and
build/relink instructions for this bundle are recorded in:
  scripts/build-libmpv-macos.sh
  docs/libmpv.md
  src-tauri/vendor/libmpv/manifest.json

The source archives are fetched from the named upstream projects and verified by
SHA-256 before use. For at least three years after distribution, the Vesperwind
project will also provide the corresponding source and build material on request,
for no more than the reasonable cost of physically providing it. Open an issue at:
  https://github.com/ovsyannikov-ivan/vesperwind

The libraries are dynamically linked and kept as replaceable files beside libmpv.
No technical measure prevents relinking or replacing the LGPL libraries.
EOF

(
  cd "$bundle"
  shasum -a 256 *.dylib BUILD-INFO.txt LICENSES/* > SHA256SUMS
)

node "$project_root/scripts/verify-libmpv-bundle.js" macos
echo "Created $bundle"
