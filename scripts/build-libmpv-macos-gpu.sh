#!/usr/bin/env bash
# Private build dependency closure; no installed/user Vulkan loader is used.
set -euo pipefail
work_root="$1"; prefix="$2"; sdk_root="$3"; deployment_target="$4"
source_root="$work_root/src"; build_root="$work_root/build"
mkdir -p "$work_root/archives" "$prefix/lib/pkgconfig" "$prefix/share/vesperwind-gpu/licenses"
download_extract() {
  local name="$1" url="$2" checksum="$3" destination="$4"
  local archive="$work_root/archives/$name.tar.gz"
  [[ -f "$archive" ]] || curl --fail --location --retry 3 -o "$archive" "$url"
  [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" == "$checksum" ]] || { echo "Checksum mismatch: $name" >&2; exit 1; }
  if [[ ! -d "$destination" ]]; then
    mkdir -p "$destination"
    tar -xzf "$archive" --strip-components=1 -C "$destination"
  fi
}
mvk_commit=49b97f26ae013b9e5bfb3098ee5dea5e4f58e9e8
# GitHub regenerated this codeload archive in 2026-10 (new gzip bytes); its tree
# was re-verified file by file against a clone of $mvk_commit.
download_extract moltenvk "https://codeload.github.com/KhronosGroup/MoltenVK/tar.gz/$mvk_commit" \
  f74f127e3df73e323c8c97cee2bfcf75eecd6ffb732b7fec8df21ae60da4140b "$source_root/moltenvk"
(
  cd "$source_root/moltenvk"
  # Xcode 27 no longer builds dependencies targeting macOS 10.15. Match the
  # application minimum, including upstream's explicitly pinned project setting.
  python3 - "$deployment_target" <<'PYCODE'
from pathlib import Path
import sys
p = Path('ExternalDependencies.xcodeproj/project.pbxproj')
p.write_text(p.read_text().replace('MACOSX_DEPLOYMENT_TARGET = 10.15;', f'MACOSX_DEPLOYMENT_TARGET = {sys.argv[1]};'))
PYCODE
  ./fetchDependencies --macos --keep-cache
  # fetchDependencies is pinned by the archive; verify every checked-out ref.
  for name in cereal Vulkan-Headers SPIRV-Cross SPIRV-Tools Vulkan-Tools Volk; do
    [[ "$(git -C "External/$name" rev-parse HEAD)" == "$(cat "ExternalRevisions/${name}_repo_revision")" ]]
  done
  [[ "$(git -C External/SPIRV-Tools/external/spirv-headers rev-parse HEAD)" == "$(cat ExternalRevisions/SPIRV-Headers_repo_revision)" ]]
  xcodebuild -quiet -project MoltenVKPackaging.xcodeproj \
    -scheme 'MoltenVK Package (macOS only)' -destination 'generic/platform=macOS' \
    -derivedDataPath "$build_root/moltenvk" ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
    MACOSX_DEPLOYMENT_TARGET="$deployment_target" CODE_SIGNING_ALLOWED=NO
)
cp "$source_root/moltenvk/Package/Latest/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib" "$prefix/lib/"
cp -R "$source_root/moltenvk/External/Vulkan-Headers/include/" "$prefix/include/"
mkdir -p "$prefix/share/vulkan/registry"
cp "$source_root/moltenvk/External/Vulkan-Headers/registry/vk.xml" "$prefix/share/vulkan/registry/"
cat > "$prefix/lib/pkgconfig/vulkan.pc" <<PC
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: Vulkan
Description: Vesperwind pinned MoltenVK (direct link; no loader or ICD search)
Version: 1.3.313
Libs: -L\${libdir} -lMoltenVK
Cflags: -I\${includedir}
PC
download_extract glslang https://codeload.github.com/KhronosGroup/glslang/tar.gz/refs/tags/15.1.0 \
  4bdcd8cdb330313f0d4deed7be527b0ac1c115ff272e492853a6e98add61b4bc "$source_root/glslang"
cmake -S "$source_root/glslang" -B "$build_root/glslang" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment_target" -DCMAKE_OSX_SYSROOT="$sdk_root" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_OPT=OFF -DENABLE_GLSLANG_BINARIES=OFF \
  -DENABLE_SPVREMAPPER=OFF -DENABLE_HLSL=OFF -DBUILD_TESTING=OFF -DGLSLANG_TESTS=OFF
cmake --build "$build_root/glslang" --parallel
cmake --install "$build_root/glslang"
licenses="$prefix/share/vesperwind-gpu/licenses"
cp "$source_root/moltenvk/LICENSE" "$licenses/MoltenVK-Apache-2.0.txt"
cp "$source_root/glslang/LICENSE.txt" "$licenses/glslang-LICENSE.txt"
for name in cereal Vulkan-Headers SPIRV-Cross SPIRV-Tools Vulkan-Tools Volk; do
  # Preserve the upstream notice, including embedded shader compiler licenses.
  notice="$source_root/moltenvk/External/$name/LICENSE"
  if [[ ! -f "$notice" ]]; then
    if [[ -f "$notice.txt" ]]; then notice="$notice.txt"; else notice="$notice.md"; fi
  fi
  cp "$notice" "$licenses/$name-LICENSE.txt"
done
notice="$source_root/moltenvk/External/SPIRV-Tools/external/spirv-headers/LICENSE"
[[ -f "$notice" ]] || notice="$notice.md"
cp "$notice" "$licenses/SPIRV-Headers-LICENSE.txt"
{
  echo "MoltenVK: 1.3.0 ($mvk_commit); dynamic direct Vulkan link"
  echo 'glslang: 15.1.0; static, optimizer disabled'
  for revision in "$source_root/moltenvk/ExternalRevisions/"*_repo_revision; do
    echo "$(basename "$revision"): $(cat "$revision")"
  done
} > "$prefix/share/vesperwind-gpu/BUILD-INFO.txt"
