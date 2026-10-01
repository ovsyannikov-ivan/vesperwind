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

The Tauri macOS and Windows bundles vendor a dynamically linked, LGPL-compatible libmpv
runtime built from pinned source. It includes mpv/libmpv 0.41.0, FFmpeg 8.0,
libplacebo 7.351.0, libass 0.17.4, FreeType 2.14.1, FriBidi 1.0.16, and HarfBuzz
11.5.0. The exact commits, build flags, local compatibility patches, artifact
limitations, license analysis, source/relinking offer, and per-component license
texts are recorded in `docs/libmpv.md`, the platform build scripts and
`src-tauri/vendor/libmpv/{macos,windows}`. Windows uses MSYS2 UCRT64 GCC/MinGW
for the shared C-ABI libraries and an MSVC application. Its closure also includes
GCC/libstdc++/libgcc runtime support (GPL with GCC Runtime Library Exception),
winpthreads (MIT/BSD) and GNU libiconv (LGPL); their notices are in
`windows/LICENSES`. The libplacebo generated OpenGL loader and fast_float notices
are retained there as well. `windows/BUILD-INFO.txt` records compiler packages,
archive hashes, recursive source revisions and feature flags; `SHA256SUMS`
covers the complete Windows runtime and accompanying texts. The D3D11 presentation
backend additionally bundles MSYS2 UCRT64 shaderc and SPIRV-Cross shared libraries.
shaderc and its incorporated SPIRV-Tools code use Apache-2.0; SPIRV-Cross uses
Apache-2.0, and glslang includes BSD/MIT/Apache-2.0 notices. Complete upstream
texts are retained under `windows/LICENSES/{shaderc,spirv-cross,spirv-tools,glslang}`;
the exact package revisions are recorded in the manifest and build evidence.

Vesperwind's MIT license does not relicense these libraries. The build excludes
mpv's GPL source set and FFmpeg GPL/non-free/version-3-only components. Final
public binary distribution remains subject to signing/notarization and legal
review of the assembled dependency bundle.

## Spreadsheet editor

The offline spreadsheet editor bundles Univer 1.0.2 (`@univerjs/presets` and
`@univerjs/preset-sheets-core`) and SheetJS Community Edition 0.20.3. Both are
licensed under Apache-2.0. SheetJS CE is installed from the official tarball
vendored at `vendor/xlsx-0.20.3.tgz`; no spreadsheet runtime asset is fetched
from a CDN. Sources and license texts are available at
<https://github.com/dream-num/univer> and <https://git.sheetjs.com/sheetjs/sheetjs>.

## Word document editor

The offline Word module uses these pinned direct dependencies:

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@docx-editor.dev/core` | 2.22.0 | Apache-2.0 | Native OOXML parsing, canonical document model, pagination, and DOCX serialization. |
| `@docx-editor.dev/vue` | 2.22.0 | Apache-2.0 | Official Vue 3 document editor and toolbar. |
| `@docx-editor.dev/fonts` | 2.22.0 | Apache-2.0 AND OFL-1.1 AND LicenseRef-GUST-Font-License | Locally packaged substitute fonts for offline layout. |

The editor packages also install `@docx-editor.dev/i18n` 2.23.0 (Apache-2.0)
for interface strings. No `@docx-editor.dev/pro`, `@docx-editor.dev/editor-api`,
React adapter, remote font service, or remote conversion service is included.
Project source and bundled notices: <https://github.com/eigenpal/docx-editor>.

RTF and legacy DOC import can call a separately installed local LibreOffice.
LibreOffice is discovered only at import time and is not bundled with Vesperwind.
