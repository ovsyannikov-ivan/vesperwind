# Monaco themes and bundled Prettier

Vesperwind adds independent Monaco appearance and an offline Prettier formatter
without project plugins, executable configuration, Git integration or language servers.
Settings remain in the existing JSON settings file and API/transport pipeline.

## Files and settings

- `shared/editorThemes.json` is the single catalog of stable IDs, labels and theme types.
  `editorThemeCatalog.js` exposes it to JavaScript without eagerly loading theme data;
  the Rust settings store includes the same JSON catalog for validation.
- `shared/editorFormatting.js` defines the defaults and strict option normalization.
- `shared/defaultSettings.js` and `src-tauri/src/settings/mod.rs` use settings version 7.
  The version-6 editable-files migration remains restricted to versions below 6;
  upgrading a customized v6 list does not silently add file types again.
- `src/composables/settingsState.js` contains the existing shared reactive settings
  value, extracted from `useSettings.js`. There is no second settings or editor state.
- `SettingsModal.vue` has Editor appearance, Formatting and Editable files sections.
  Save applies editor preferences live. Reset defaults restores `auto` and disables
  format-on-save. Cancel leaves the saved editor preferences unchanged.

Formatting defaults are: formatOnSave false, printWidth 100, tabWidth 2,
useTabs false, semi true, singleQuote false, bracketSpacing true, trailingComma all,
arrowParens always and endOfLine auto. Widths must be integers in 40–300 and 1–8;
booleans must be actual booleans. Invalid options fall back to their defaults.
The three enum options accept only the values listed in Settings.

## Themes, loading and attribution

`src/editor/themes/registry.js` combines catalog metadata with an explicit loader
map. A settings value cannot construct an import path. Theme data is packaged as plain ES modules, avoiding JSON import-attribute
mismatches between Node, Vite and WebKit. Data and registration are cached; a theme is defined only once for each Monaco instance. A request generation
check prevents a slow previous import from overriding a later selection.
Missing/failed data safely falls back to the application-appropriate built-in theme.

The curated options are Follow application theme, Vesperwind Dark 2026, One Dark
Pro, Dracula, Nord, Night Owl, Monokai, Monokai Bright, GitHub Dark, GitHub Light,
Solarized Dark, Solarized Light, Oceanic Next, Cobalt2, Tomorrow Night, Tomorrow
Night Eighties, Zenburnesque and Xcode Default. Zenburnesque is explicitly labelled
as the available upstream variant, rather than claiming to be original Zenburn.

Auto uses Monaco `vs` in light mode and the existing Vesperwind Dark 2026 in dark
mode, including its existing HTML/Monarch bridges. Fixed themes ignore changes to
the application's theme; they never change Bootstrap appearance. Switching calls
`defineTheme`/`setTheme`, without recreating models, changing content, closing tabs
or resetting cursor, selection, scroll or undo history.

`compatibility.js` derives custom Monarch token colors from each theme's own
palette for import/declaration keywords, constants, functions, variables and
embedded HTML/Vue tokens. It checks foreground/background contrast and falls back
to readable foreground colors when a candidate has contrast below 4.5:1. The adapter also expands shorthand hex colors and omits VS Code null color overrides,
which Monaco does not accept. This central overlay leaves the original bundled data intact.

The exact source repository, revision, file and output SHA-256 for every external
theme are in `src/editor/themes/SOURCES.json`. Full attribution and license texts
are in `src/editor/themes/THIRD-PARTY-NOTICES.md` and `licenses/`:

| Theme | Source / upstream | License |
| --- | --- | --- |
| Vesperwind Dark 2026, Monokai | Microsoft VS Code | MIT |
| One Dark Pro | Binaryify/OneDark-Pro | MIT |
| Dracula | brijeshb42 Monaco port; dracula/textmate | MIT |
| Nord | nordtheme/visual-studio-code | MIT |
| Night Owl | sdras/night-owl-vscode-theme; official theme, not Night Owlish | MIT |
| GitHub Dark / Light | dongchengjie port; primer/github-vscode-theme | MIT |
| Monokai Bright, Zenburnesque | brijeshb42 port; JetBrains/colorSchemeTool | Apache-2.0 |
| Solarized Dark / Light | brijeshb42 TextMate port; Ethan Schoonover's Solarized | MIT |
| Oceanic Next | brijeshb42 port; Dmitri Voronianski's Oceanic Next | MIT declared in upstream README |
| Cobalt2 | wesbos/cobalt2-vscode | MIT |
| Tomorrow Night / Eighties | brijeshb42 port; Chris Kempson's Tomorrow Theme | MIT |
| Xcode Default | brijeshb42 port; Carmine Paolino / Ajax.org Ace distribution | BSD-3-Clause |

The aggregation notices are retained in addition to upstream notices. The Vite
build emits the texts to `editor-notices/`, so they ship in browser, SEA and Tauri
frontend distributions. No theme or formatter downloads occur at runtime.

## Formatter and Monaco integration

Prettier 3.9.9 is a pinned application dependency. `formatting/prettier.js` uses
`prettier/standalone` and explicit lazy imports of bundled Babel, Estree,
TypeScript, HTML, PostCSS, Markdown and YAML plugins. Vue/HTML/Markdown requests
also load parsers for embedded scripts, style blocks and fenced code.

Supported extensions: js, mjs, cjs, jsx, ts, tsx, vue, json, html, htm, css, scss,
md, markdown, yaml and yml. Rust, Python, PHP, SQL, Go, Java, C/C++ and other
unsupported files retain ordinary saves and have no Prettier button.

An initial Node benchmark of JavaScript documents measured approximately 21 ms
for 4,389 bytes, 44 ms for 44,889 bytes and 278 ms for 458,889 bytes. These are
indicative measurements, not target-platform timing guarantees. Because larger
files can visibly stall a UI, the application uses a module Web Worker. The worker
loads only the required bundled parsers and returns a complete formatted result;
model edits and disk writes stay in the existing editor/save pipeline.

Monaco has normal document-formatting providers for supported language IDs, plus
an explicit Format Document (Prettier) action with Option+Shift+F on macOS and
Alt+Shift+F elsewhere. The status bar has a compact Prettier button whose tooltip
also reports format-on-save state.

`modelEdits.js` uses the smallest contiguous replacement, `pushEditOperations`,
`pushEOL` and undo stack boundaries. It never formats via `model.setValue`.
Formatting is one undoable operation, including LF/CRLF conversion. A caret uses
Prettier's `formatWithCursor` mapping; nonempty selections use tracked Monaco
ranges. The current view/scroll state is restored. Monaco indentation controls
remain independent of Prettier options.

On macOS, system Edit → Undo/Redo previously targeted WebKit's DOM undo stack,
which does not contain Monaco model edits. The two native menu items now emit
history commands through `src/api/nativeAppMenu.js`. A focused Monaco consumes
these using its own command/undo stack. Ordinary fields retain DOM undo behavior;
inactive windows ignore the event. Other native Edit menu items are unchanged.

## Save orchestration and failure semantics

All entry points continue calling `useEditorWorkspace.saveTab`: the Save button,
Cmd/Ctrl+S, Save As and Save and Close. The function takes a per-tab saving lock
before formatting. Manual/provider formatting has the corresponding formatting
lock; another save or close cannot race with either operation.

Before file creation or writing, `prepareTextSave` invokes the registered Monaco
adapter on the requested tab's existing model, including inactive tabs. Save As
selects the parser from the destination name. The adapter checks model version,
closed/disposed models and cancellation before applying a result. Content is
synchronized, then `contentBeingSaved` is captured. Successful writing updates
savedContent from that same formatted snapshot, so dirty becomes false and the
status is Saved. Save and Close removes the tab only after successful saving.

A syntax/plugin/worker failure leaves the original model intact, returns a clear
Formatting failed error, cancels writing and keeps the dirty tab open. Save As
cannot create an empty destination before a formatter failure. Unsupported files
skip formatting. There is no silent fallback to saving unformatted input.

Monaco supports LF and CRLF internally. For the supported Prettier bare-CR option,
the editor uses its normalized LF representation while retaining CR serialization
for disk writing, including ordinary saves after manual formatting. savedContent
uses the same logical model representation, avoiding a false Unsaved status.

## Verification

Automated checks include real formatter outputs for JavaScript/JSX, TypeScript/TSX,
Vue SFC with TypeScript/template/SCSS, JSON, HTML, CSS, SCSS, Markdown and YAML;
settings defaults, invalid values, migration and Reset defaults; all theme loaders,
contrast checks and cached registration; actual save orchestration, destination
parser choice, failures before destination creation, concurrent-save/close guards
and CR serialization. Rust tests cover native validation, persisted settings across
store instances, customized v6 editable files and Reset defaults.

`test/fixtures/editor/monaco-formatting.html` runs integration assertions on actual
Monaco models and an editor in the browser. It verifies one-step Undo/Redo,
cursor, nonempty selection, CRLF restoration, independent indentation settings
and unchanged model/undo history after syntax errors. Open it through Vite; the
page displays each PASS/FAIL result, including real defineTheme/setTheme calls and
background verification for all 17 themes. All five checks passed in the in-app browser, including every curated theme.

Native macOS acceptance uses the built debug .app and separate test files/settings
under /tmp, without changing the user's normal settings. Option+Shift+F formatted
JavaScript, the Undo button restored the source, and Cmd+S wrote formatted JS and
Vue SFC bytes to disk with Saved status. One Dark Pro and format-on-save survived a native restart. The updated native
Cmd+Z and Cmd+Shift+Z restored/reapplied formatted text. Save As wrote formatted
copy.js; Save and Close reformatted an undone document before removing its tab.
A syntax-error save showed Formatting failed and left the disk source unchanged.
Live Dark 2026, One Dark Pro, Dracula and Nord changes retained the same Vue tab,
undo history and cursor at line 1, column 26. The final .app showed GitHub Light with a white editor background while the
application stayed dark. Returning to auto followed application Light (`vs`)
and Dark (Vesperwind Dark 2026) live. These checks ran at `tauri://localhost`
from bundled assets. Cmd+Z also restored 120 → 100 in the ordinary Print width
Settings input, verifying the DOM fallback for native Undo.

Automated delivery checks passed: npm test (484 passed), cargo test (156 passed,
8 ignored), cargo fmt --check and git diff --check. npm run build and the native
debug .app build passed; the existing large-chunk notice remains, with no new
static/dynamic-import warnings. Windows/Linux physical UI acceptance and Windows CI are distinct from
local macOS evidence. Eight pre-existing Rust tests are explicitly ignored.

Deferred: project declarative configs, executable configs, external plugins,
format selection, user-imported themes/marketplace, Git, diagnostics, ESLint,
LSP and project language services.
