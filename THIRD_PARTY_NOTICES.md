# Third-party notices

## Visual Studio Code Dark 2026 theme data

Vesperwind includes a generated Monaco Editor port of the built-in Visual
Studio Code **Dark 2026** theme. The source theme and its inherited theme files
come from the Microsoft Visual Studio Code repository at commit
`53e9983e61535999978c09e080fedfe3356309ed`:

<https://github.com/microsoft/vscode/tree/53e9983e61535999978c09e080fedfe3356309ed/extensions/theme-defaults/themes>

Visual Studio Code is copyright Microsoft Corporation and is distributed under
the MIT License:

<https://github.com/microsoft/vscode/blob/53e9983e61535999978c09e080fedfe3356309ed/LICENSE.txt>

The generated theme data retains the resolved `2026-dark.json` include chain
and is converted to Monaco's `IStandaloneThemeData` format by
`scripts/update-monaco-dark-2026.js`.

## Native media runtime

The Tauri macOS bundle vendors a dynamically linked, LGPL-compatible libmpv
runtime built from pinned source. It includes mpv/libmpv 0.41.0, FFmpeg 8.0,
libplacebo 7.351.0, libass 0.17.4, FreeType 2.14.1, FriBidi 1.0.16, and HarfBuzz
11.5.0. The exact commits, build flags, local compatibility patches, artifact
limitations, license analysis, source/relinking offer, and per-component license
texts are recorded in `docs/libmpv.md`, `scripts/build-libmpv-macos.sh`, and
`src-tauri/vendor/libmpv/macos`.

Vesperwind's MIT license does not relicense these libraries. The build excludes
mpv's GPL source set and FFmpeg GPL/non-free/version-3-only components. Final
public binary distribution remains subject to signing/notarization and legal
review of the assembled dependency bundle.
