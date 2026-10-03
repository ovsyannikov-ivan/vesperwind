"""Regenerate tiny deterministic fixtures with application-owned FFmpeg 8.0.
Usage: python3 test/fixtures/media/generate.py /absolute/path/to/bundled/ffmpeg
No FFmpeg executable is needed when running the checked-in fixture tests.
"""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
binary = Path(sys.argv[1]).resolve(strict=True)
version = subprocess.check_output([str(binary), "-version"], text=True).splitlines()[0]
assert version.startswith("ffmpeg version 8.0 "), version
metadata = root / "chapters.ffmetadata"
common = [str(binary), "-hide_banner", "-loglevel", "error", "-y"]
audio = ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono"]
for filename, container in [("book.m4b", "mp4"), ("no-chapters.m4b", "mp4")]:
    chapters = ["-f", "ffmetadata", "-i", str(metadata)] if filename == "book.m4b" else []
    subprocess.run(common + audio + chapters + ["-map", "0:a", "-map_chapters", "1" if chapters else "-1",
        "-t", "120", "-c:a", "aac", "-b:a", "8k", "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-f", container, str(root / filename)], check=True)
for filename in ["chapters.mkv", "chapters.mp4"]:
    subprocess.run(common + ["-f", "lavfi", "-i", "color=c=black:s=32x32:r=1", "-f", "ffmetadata", "-i", str(metadata),
        "-map", "0:v", "-map_chapters", "1", "-t", "120", "-c:v", "mpeg4", "-q:v", "31",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", str(root / filename)], check=True)
