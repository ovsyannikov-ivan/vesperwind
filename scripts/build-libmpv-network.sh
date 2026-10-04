#!/usr/bin/env bash
# Replace only FFmpeg's ABI-compatible networking/demux library. Existing
# codec, hardware acceleration, audio, libmpv and renderer binaries stay intact.
set -euo pipefail
platform="${1:?Expected macos or windows}"; toolchain="${2:-}"
project="$(cd "$(dirname "$0")/.." && pwd)"
work="${VESPERWIND_NETWORK_BUILD_DIR:-/private/tmp/vesperwind-network-build}"
mkdir -p "$work/src" "$work/build-$platform"
archive="$work/ffmpeg-n8.0.tar.gz"
[[ -f "$archive" ]] || curl --fail --location --output "$archive" https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n8.0
[[ "$(shasum -a 256 "$archive" | awk '{print $1}')" == dd4030dbfdc34d9ff255a116bdd1caade42500ac2981efa27f8b151cc54c7b9e ]]
tar -xzf "$archive" --strip-components=1 -C "$work/src"
cd "$work/build-$platform"
flags=(--enable-shared --disable-static --disable-programs --disable-doc --disable-debug --disable-autodetect --disable-gpl --disable-nonfree --disable-version3)
if [[ "$platform" == macos ]]; then
  "$work/src/configure" --prefix="$work/prefix-macos" --cc=/usr/bin/clang --cxx=/usr/bin/clang++ "${flags[@]}" --enable-securetransport --enable-videotoolbox --disable-audiotoolbox --enable-pic --extra-cflags='-O2 -mmacosx-version-min=12.0' --extra-ldflags='-mmacosx-version-min=12.0'
  make -j8 libavformat/libavformat.62.dylib
  destination="$project/src-tauri/vendor/libmpv/macos/libavformat.62.dylib"
  cp libavformat/libavformat.62.dylib "$destination"
  install_name_tool -id @loader_path/libavformat.62.dylib "$destination"
  for name in libavcodec.62.dylib libavutil.60.dylib libswresample.6.dylib; do
    install_name_tool -change "$work/prefix-macos/lib/$name" "@loader_path/$name" "$destination"
  done
  codesign --force --sign - "$destination"
elif [[ "$platform" == windows && -d "$toolchain" ]]; then
  # Pinned official llvm-mingw 20260826 UCRT macOS cross toolchain. The ordinary
  # Windows full-bundle script enables Schannel with MSYS2 UCRT64 GCC as well.
  "$work/src/configure" --prefix="$work/prefix-windows" --cc="$toolchain/bin/x86_64-w64-mingw32-clang" --cxx="$toolchain/bin/x86_64-w64-mingw32-clang++" --ar="$toolchain/bin/llvm-ar" --ranlib="$toolchain/bin/llvm-ranlib" --nm="$toolchain/bin/llvm-nm" --strip="$toolchain/bin/llvm-strip" --windres="$toolchain/bin/x86_64-w64-mingw32-windres" "${flags[@]}" --enable-cross-compile --target-os=mingw32 --arch=x86_64 --enable-schannel --enable-d3d11va --enable-dxva2 --disable-vulkan --enable-w32threads --disable-x86asm --extra-cflags="-O2 -ffile-prefix-map=$work=."
  python3 - "$work" "$toolchain" <<'PY'
from pathlib import Path
import sys
p = Path('config.h')
p.write_text('\n'.join(line.replace(sys.argv[1], '<build-root>').replace(sys.argv[2], '<toolchain>') if line.startswith('#define FFMPEG_CONFIGURATION ') else line for line in p.read_text().splitlines()) + '\n')
PY
  make -j8 libavformat/avformat-62.dll DLLTOOL="$toolchain/bin/llvm-dlltool"
  cp libavformat/avformat-62.dll "$project/src-tauri/vendor/libmpv/windows/avformat-62.dll"
else
  echo 'Expected macos, or windows with the pinned llvm-mingw UCRT toolchain directory' >&2; exit 1
fi
echo 'Update BUILD-INFO evidence and SHA256SUMS, then run verify-libmpv-bundle.js on each target OS.'
