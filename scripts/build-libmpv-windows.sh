#!/usr/bin/env bash
set -euo pipefail
[[ "${MSYSTEM:-}" == UCRT64 ]] || { echo 'Use the PowerShell wrapper with MSYS2 UCRT64' >&2; exit 1; }
project_root="$(cygpath -u "$VESPERWIND_LIBMPV_PROJECT")"
work_root="$(cygpath -u "$VESPERWIND_LIBMPV_BUILD_DIR")"
jobs="${VESPERWIND_LIBMPV_JOBS:-4}"
node="$(cygpath -u "$VESPERWIND_NODE")"
export PATH="/ucrt64/bin:/usr/bin:/c/Windows/System32"
export PKG_CONFIG_PATH="$work_root/prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
# Reviewed UCRT64 shader toolchain dependencies; codec/font dependencies must
# still resolve from our source-built prefix.
export PKG_CONFIG_PATH="$PKG_CONFIG_PATH:/ucrt64/lib/pkgconfig"
export CMAKE_PREFIX_PATH="$work_root/prefix"
export CC=gcc CXX=g++
prefix="$work_root/prefix"
source_root="$work_root/src"
build_root="$work_root/build"
archive_root="$work_root/archives"
stage="$work_root/bundle"
for tool in gcc g++ cmake meson ninja pkg-config nasm make git curl python; do
  command -v "$tool" >/dev/null || { echo "Missing UCRT64 build tool: $tool" >&2; exit 1; }
done
[[ "$(gcc -dumpmachine)" == x86_64-w64-mingw32 ]] || exit 1
mkdir -p "$prefix" "$source_root" "$build_root" "$archive_root" "$stage/LICENSES"
# Source/toolchain changes require a fresh BuildRoot. PresentationOnly explicitly
# reconfigures mpv/libplacebo while reusing the verified codec/font prefix.
common_flags="-O2 -D_WIN32_WINNT=0x0A00 -ffile-prefix-map=$(cygpath -m "$work_root")=. -ffile-prefix-map=$work_root=."
export CFLAGS="$common_flags" CXXFLAGS="$common_flags"
export LDFLAGS='-Wl,--no-insert-timestamp'

"$node" "$project_root/scripts/libmpv-windows-fetch.js" "$(cygpath -m "$archive_root")"
for name in mpv ffmpeg freetype fribidi harfbuzz libass; do
  if [[ ! -d "$source_root/$name" ]]; then
    mkdir -p "$source_root/$name"
    tar -xzf "$archive_root/$name.tar.gz" --strip-components=1 -C "$source_root/$name"
  fi
done
libplacebo_commit=3188549fba13bbdf3a5a98de2a38c2e71f04e21e
if [[ ! -d "$source_root/libplacebo/.git" ]]; then
  git clone --depth 1 --recurse-submodules --shallow-submodules --branch v7.351.0 --single-branch \
    https://code.videolan.org/videolan/libplacebo.git "$source_root/libplacebo"
fi
if ! git -C "$source_root/libplacebo" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$source_root/libplacebo" fetch --depth 1 origin tag v7.351.0
  git -C "$source_root/libplacebo" checkout --detach "$libplacebo_commit"
fi
[[ "$(git -C "$source_root/libplacebo" rev-parse HEAD)" == "$libplacebo_commit" ]] || exit 1
git -C "$source_root/libplacebo" submodule update --init --recursive --depth 1
git -C "$source_root/libplacebo" submodule status --recursive > "$build_root/libplacebo-submodules.txt"

meson_build() {
  local name="$1"; shift
  local library_flags=()
  if [[ "$name" != mpv ]]; then library_flags=(-Ddefault_library=shared); fi
  local reconfigure=()
  if [[ -f "$build_root/$name/build.ninja" ]]; then reconfigure=(--reconfigure); fi
  meson setup "${reconfigure[@]}" "$build_root/$name" "$source_root/$name" \
    --prefix "$prefix" --libdir lib --buildtype release "${library_flags[@]}" \
    --auto-features=disabled --wrap-mode=nofallback -Db_ndebug=true \
    "-Dpkg_config_path=$(cygpath -m "$prefix/lib/pkgconfig"),$(cygpath -m /ucrt64/lib/pkgconfig)" "$@"
  if [[ "$name" == mpv ]]; then
    # mpv embeds Meson's prefix in CONFIGURATION; retain options, omit local paths.
    VESPERWIND_CONFIG="$(cygpath -m "$build_root/mpv/config.h")" VESPERWIND_TOOLCHAIN="$(cygpath -m /ucrt64)" \
      VESPERWIND_REMAP_ROOT="$(cygpath -m "$work_root")" VESPERWIND_REMAP_POSIX="$work_root" python - <<'PY'
import os
from pathlib import Path
p = Path(os.environ['VESPERWIND_CONFIG'])
original = p.read_text()
updated = original.replace(os.environ['VESPERWIND_REMAP_ROOT'], '<build-root>').replace(os.environ['VESPERWIND_REMAP_POSIX'], '<build-root>').replace(os.environ['VESPERWIND_TOOLCHAIN'], '<ucrt64>')
if updated != original:
    p.write_text(updated)
PY
  fi
  meson compile -C "$build_root/$name" -j "$jobs"
  meson install -C "$build_root/$name"
}
if [[ "${VESPERWIND_LIBMPV_PRESENTATION_ONLY:-0}" != 1 ]]; then
cmake -S "$source_root/freetype" -B "$build_root/freetype" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=ON \
  -DFT_DISABLE_ZLIB=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON \
  -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON
cmake --build "$build_root/freetype" --parallel "$jobs"
cmake --install "$build_root/freetype"
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
meson_build harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
  -Dcairo=disabled -Dchafa=disabled -Dicu=disabled -Dgraphite2=disabled \
  -Dcoretext=disabled -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
meson_build libass -Dtest=disabled -Dcompare=disabled -Dprofile=disabled \
  -Dfuzz=disabled -Dcheckasm=disabled -Dfontconfig=disabled -Dcoretext=disabled \
  -Ddirectwrite=enabled -Dlibunibreak=disabled

ffmpeg_flags=(--enable-shared --disable-static --disable-programs --disable-doc \
  --disable-debug --disable-autodetect --disable-gpl --disable-nonfree \
  --disable-version3 --enable-schannel --enable-d3d11va --enable-dxva2 --disable-vulkan \
  --target-os=mingw32 --arch=x86_64 --enable-w32threads)
printf '%s\n' "${ffmpeg_flags[@]}" > "$build_root/ffmpeg-flags.txt"
mkdir -p "$build_root/ffmpeg"
(
  cd "$build_root/ffmpeg"
  if [[ ! -f ffbuild/config.mak ]] || ! grep -q '^#define CONFIG_SCHANNEL 1$' config.h; then
    "$source_root/ffmpeg/configure" --prefix="$prefix" --cc=gcc --cxx=g++ \
      "${ffmpeg_flags[@]}" --extra-cflags="$common_flags" --extra-ldflags="$LDFLAGS"
  fi
  grep -q '^#define CONFIG_SCHANNEL 1$' config.h
  grep -q '^#define CONFIG_HTTPS_PROTOCOL 1$' config_components.h
  grep -q '^#define CONFIG_HLS_DEMUXER 1$' config_components.h
  grep -q '^#define CONFIG_D3D11VA 1$' config.h
  grep -q '^#define CONFIG_H264_D3D11VA_HWACCEL 1$' config_components.h
  grep -q '^#define CONFIG_HEVC_D3D11VA_HWACCEL 1$' config_components.h
  # avcodec_configuration() retains configure arguments in the DLL. Keep the
  # feature evidence while replacing local build paths in that diagnostic string.
  VESPERWIND_REMAP_ROOT="$(cygpath -m "$work_root")" VESPERWIND_REMAP_POSIX="$work_root" python - <<'PY'
import os
from pathlib import Path
p = Path('config.h')
original = p.read_text()
lines = original.splitlines()
for i, line in enumerate(lines):
    if line.startswith('#define FFMPEG_CONFIGURATION '):
        root = os.environ['VESPERWIND_REMAP_ROOT']
        lines[i] = line.replace(root, '<build-root>').replace(os.environ['VESPERWIND_REMAP_POSIX'], '<build-root>')
updated = '\n'.join(lines) + '\n'
if updated != original:
    p.write_text(updated)
PY
  make -j"$jobs"
  make install
)
else
  # Incrementally rebuild presentation against the existing pinned codec/font
  # prefix. Do not silently substitute MSYS2 media packages for missing stages.
  for dependency in libavcodec libavutil freetype2 fribidi harfbuzz libass; do
    [[ -f "$prefix/lib/pkgconfig/$dependency.pc" ]] || { echo "Missing source-built $dependency; run a full build" >&2; exit 1; }
  done
  [[ -f "$build_root/d3d11va-probe.json" ]] || exit 1
fi
pkg-config --exists shaderc spirv-cross-c-shared || {
  echo 'Install UCRT64 shaderc and spirv-cross build dependencies first' >&2; exit 1;
}
meson_build libplacebo -Dvulkan=disabled -Dopengl=enabled -Dgl-proc-addr=enabled \
  -Dd3d11=enabled -Dglslang=disabled -Dshaderc=enabled -Dlcms=disabled \
  -Ddovi=disabled -Dlibdovi=disabled -Ddemos=false -Dtests=false \
  -Dbench=false -Dfuzz=false -Dunwind=disabled -Dxxhash=disabled
mpv_flags=(-Dgpl=false -Dcplayer=false -Dlibmpv=true -Ddefault_library=shared \
  -Dbuild-date=false -Dtests=false -Dgl=enabled -Dplain-gl=enabled \
  -Dgl-win32=enabled -Dwasapi=enabled -Dwin32-threads=enabled -Dd3d-hwaccel=enabled \
  -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
  -Diconv=disabled -Dmanpage-build=disabled)
printf '%s\n' "${mpv_flags[@]}" > "$build_root/mpv-flags.txt"
meson_build mpv "${mpv_flags[@]}"

gcc "$project_root/scripts/probe-libmpv-d3d11va.c" -I"$prefix/include" \
  -L"$prefix/lib" -lavcodec -lavutil -o "$build_root/probe-d3d11va.exe"
PATH="$prefix/bin:$PATH" "$build_root/probe-d3d11va.exe" > "$build_root/d3d11va-probe.json"
gcc --version | head -n 1 > "$build_root/toolchain.txt"
pacman -Q > "$build_root/toolchain-packages.txt"
"$node" "$project_root/scripts/package-libmpv-windows.js" \
  "$(cygpath -m "$work_root")" "$(cygpath -m /ucrt64)"
