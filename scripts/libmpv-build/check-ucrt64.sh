# Reports the UCRT64 build environment for scripts/libmpv-build/windows.js.
# Run as a script file by MSYS2 bash; no output is parsed from nested quoting.
for tool in gcc g++ cmake meson ninja pkg-config nasm make git curl python cygpath tar; do
  if location="$(command -v "$tool")"; then echo "tool $tool $location"; else echo "missing $tool"; fi
done
echo "machine $(gcc -dumpmachine 2>/dev/null)"
echo "msystem ${MSYSTEM:-}"
echo "toolchain $(gcc --version 2>/dev/null | head -n 1)"
