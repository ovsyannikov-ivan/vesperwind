# Bundled editor themes and Prettier

All theme data is shipped offline. SOURCES.json records the exact source
repository, revision, file and output SHA-256. VS Code themes are converted
by flattening tokenColors into Monaco rules; the runtime applies a centralized
Monarch compatibility overlay. Original license texts are retained in licenses/.
The Vite build emits these notices into editor-notices/ for browser, SEA and
Tauri distributions.

| Theme | Data source | Upstream | License |
| --- | --- | --- | --- |
| nord | https://github.com/nordtheme/visual-studio-code @ `8ead09822c02` | https://github.com/nordtheme/visual-studio-code | MIT |
| cobalt2 | https://github.com/wesbos/cobalt2-vscode @ `c4e9574372b8` | https://github.com/wesbos/cobalt2-vscode | MIT |
| night-owl | https://github.com/sdras/night-owl-vscode-theme @ `cc291eba7976` | https://github.com/sdras/night-owl-vscode-theme | MIT |
| one-dark-pro | https://github.com/Binaryify/OneDark-Pro @ `ce79c5f71166` | https://github.com/Binaryify/OneDark-Pro | MIT |
| github-dark | https://github.com/dongchengjie/monaco-editor-themes @ `041579b715b0` | https://github.com/primer/github-vscode-theme | MIT |
| github-light | https://github.com/dongchengjie/monaco-editor-themes @ `041579b715b0` | https://github.com/primer/github-vscode-theme | MIT |
| monokai | https://github.com/microsoft/vscode @ `53e9983e6153` | https://github.com/microsoft/vscode | MIT |
| dracula | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/dracula/textmate | MIT |
| monokai-bright | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/JetBrains/colorSchemeTool | Apache-2.0 |
| solarized-dark | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/altercation/solarized | MIT |
| solarized-light | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/altercation/solarized | MIT |
| oceanic-next | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/voronianski/oceanic-next-color-scheme | MIT |
| tomorrow-night | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/chriskempson/tomorrow-theme | MIT |
| tomorrow-night-eighties | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/chriskempson/tomorrow-theme | MIT |
| zenburn | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/JetBrains/colorSchemeTool | Apache-2.0 |
| xcode-default | https://github.com/brijeshb42/monaco-themes @ `92a2aa78967b` | https://github.com/ajaxorg/ace | BSD-3-Clause |

Vesperwind Dark 2026 retains the Microsoft MIT attribution in the repository's
THIRD_PARTY_NOTICES.md and licenses/vscode.txt. Auto/light uses Monaco's built-in
`vs` theme, covered by Monaco/Microsoft MIT.

- One Dark Pro: Copyright (c) 2013-2022 Binaryify, MIT; licenses/one-dark-pro.txt.
- Dracula: Dracula Theme, MIT; licenses/dracula.txt.
- Nord: Arctic Ice Studio / Sven Greb, MIT; licenses/nord.txt.
- Night Owl: Sarah Drasner, MIT; licenses/night-owl.txt. This is the official
  Night Owl, not the aggregator's Night Owlish variant.
- GitHub themes: GitHub/Primer MIT plus dongchengjie aggregation MIT;
  licenses/github.txt and licenses/monaco-editor-themes.txt.
- Solarized: Ethan Schoonover MIT; licenses/solarized.txt. The Monaco port
  follows the TextMate Solarized adaptation documented by the aggregator.
- Tomorrow: Chris Kempson MIT; licenses/tomorrow.txt.
- Oceanic Next: Dmitri Voronianski, declared MIT in the upstream README;
  the complete upstream attribution/README is retained in licenses/oceanic-next.txt.
- Cobalt2: Wes Bos MIT; licenses/cobalt2.txt.
- Monokai: Microsoft VS Code's Monokai port, MIT; licenses/vscode.txt.
- Monokai Bright and Zenburnesque: JetBrains colorSchemeTool Apache-2.0 port;
  licenses/jetbrains.txt. Zenburnesque attributes William D. Neumann and is
  explicitly named as that variant rather than the original Zenburn.
- Xcode Default: Carmine Paolino's theme distributed by Ajax.org Ace under its
  BSD license; licenses/ace.txt. Apple does not supply or endorse this port.
- All brijeshb42 Monaco conversions also retain licenses/monaco-themes.txt.

Bundled Prettier 3.9.9 and its standard plugins retain the Prettier MIT license
in licenses/prettier.txt. No external plugins or runtime downloads are used.
