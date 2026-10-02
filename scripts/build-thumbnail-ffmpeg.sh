#!/usr/bin/env bash
set -euo pipefail
# App-owned static FFmpeg 8.0 CLI. No installed FFmpeg is used at build/runtime.
project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
work_root="${VESPERWIND_THUMBNAIL_BUILD_DIR:-/private/tmp/vesperwind-thumbnail-ffmpeg}"
archive="$work_root/ffmpeg-n8.0.tar.gz"
source_root="$work_root/source"
mkdir -p "$work_root" "$project_root/src-tauri/binaries"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n8.0' -o "$archive"
fi
expected='dd4030dbfdc34d9ff255a116bdd1caade42500ac2981efa27f8b151cc54c7b9e'
actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
[[ "$actual" == "$expected" ]] || { echo 'FFmpeg source checksum mismatch' >&2; exit 1; }
if [[ ! -d "$source_root" ]]; then
  mkdir -p "$source_root"
  tar -xzf "$archive" -C "$source_root" --strip-components=1
fi
target_triple="$(rustc -vV | sed -n 's/^host: //p')"
case "$target_triple" in
  aarch64-apple-darwin|x86_64-apple-darwin|aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu) ;;
  *) echo "This recipe supports native macOS/Linux builds only: $target_triple" >&2; exit 1 ;;
esac
platform_flags=()
case "$target_triple" in
  *-apple-darwin) platform_flags+=(--enable-videotoolbox) ;;
esac
cd "$source_root"
./configure --enable-static --disable-shared --disable-autodetect --disable-network \
  --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-x86asm "${platform_flags[@]}"
make -j"${VESPERWIND_THUMBNAIL_BUILD_JOBS:-8}" ffmpeg
cp ffmpeg "$project_root/src-tauri/binaries/ffmpeg-$target_triple"
chmod 755 "$project_root/src-tauri/binaries/ffmpeg-$target_triple"
cp COPYING.LGPLv2.1 "$project_root/src-tauri/binaries/FFmpeg-LGPL-2.1.txt"
printf '%s\n' "FFmpeg 8.0 source: https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n8.0" \
  "Source SHA256: $expected" "Build recipe: scripts/build-thumbnail-ffmpeg.sh" \
  'libav* are statically linked; only OS runtime libraries remain.' \
  > "$project_root/src-tauri/binaries/FFmpeg-BUILD-INFO.txt"
