# Monaco editor intelligence

Vesperwind uses the bundled Monaco 0.56.0 language services. This extends the
existing editor, tabs, model map, workers, themes and Prettier integration; it
adds no project scanner, external language server or runtime downloads.

## Services and registration

The existing `monaco-editor` entry point registers the editor contributions and
language services. Monaco 0.55+ exports `typescript`, `html`, `css` and `json` at
the top level, rather than under `languages`. `languageServices.js` configures
these namespaces once. No second editor bundle or duplicate parser is imported.
See the upstream [0.56.0 changelog](https://github.com/microsoft/monaco-editor/blob/v0.56.0/CHANGELOG.md).

| Language | Built-in capabilities |
| --- | --- |
| JS / MJS / CJS / JSX | Semantic member completion, inferred hover, signature help, syntax diagnostics, definition, references and symbol rename |
| TS / TSX | The JS capabilities plus TypeScript semantic diagnostics |
| HTML / HTM | Tags, attributes and closing-tag completion, hover, document symbols and matching-tag rename |
| CSS / SCSS / LESS | Property/value completion, hover, syntax diagnostics, and the navigation/rename features the CSS service provides |
| JSON | Syntax diagnostics and structural/schema-free suggestions; external schema requests are disabled |
| Vue and other tokenized languages | Highlighting, contextual pairs, indentation, surrounding selections and current-document word suggestions |

HTML's bundled worker has no `doValidation` API and does not report malformed
markup as syntax diagnostics. Setting the HTML mode's diagnostics option does
not invent validation. Vue does not receive template/props/emits/component
semantic intelligence, Vue definitions or script-block diagnostics. Embedded
JS/TS and CSS tokenization is highlighting, not an embedded semantic model.
Using a JS/TS worker inside a Vue SFC would require virtual files plus offset,
edit and source mapping; that belongs to a future Volar/LSP milestone.

`monacoEnvironment.js` continues to select EditorWorker, TypeScriptWorker,
JsonWorker, HtmlWorker and CssWorker by language label. JS and TS use the same
TypeScript implementation in separate worker instances. CSS, SCSS and LESS use
the corresponding CSS service mode. All assets ship in the frontend bundle.

## Defaults and editor mechanics

JS enables syntactic and suggestion diagnostics with semantic validation off;
`checkJs` is false. TS additionally enables semantic diagnostics. The compiler
uses ESNext target/modules, JSX Preserve and Node-style module resolution for
relative file/extension lookup. This resolver option does not install a Node
runtime or global Node typings. Monaco's standard ES/DOM libraries supply DOM
APIs. Forced module detection isolates unrelated open script globals; shared
browser-script globals are not a supported project system. There is no tsconfig,
package resolver, React typings, @types/node or node_modules indexing.

Both defaults enable eager model synchronization. After open/close/rename,
`syncLanguageModels` also explicitly synchronizes every open JS/TS URI into each
needed worker, including mixed JS/TS files and files opened after worker startup.
The built-in diagnostic adapters are refreshed through the public extra-libs
settings API, preserving the existing extras. This does not add dependency files
or terminate a worker with pending requests. Editing uses Monaco's normal
validation scheduling rather than a second per-keystroke diagnostic loop.

Editor options explicitly enable quick suggestions outside comments/strings
(150 ms delay), trigger-character completion, parameter hints, hover,
inline snippets, language-defined pairs/quotes/surround, full auto-indent,
bracket matching, bracket pair colorization and indentation/bracket guides.
Word-based suggestions use only the current document and are not semantic
IntelliSense. Standard Ctrl+Space, Tab/Enter and Escape behavior is retained.
There is no handcrafted completion, signature, hover or regex diagnostic engine.

Custom configurations cover Vue, TOML, Groovy, Nginx, Apache, Makefile and ignore
files. Quotes/pairs are suppressed in strings/comments where applicable. Make
recipe tabs remain meaningful; ignore patterns do not auto-insert programming
pairs. Existing enriched JS/TS/Python highlighting remains in place.

Markers use Monaco's own squiggles and theme colors. The status bar counts only
the active model's errors/warnings through `onDidChangeMarkers`; there is no
Problems panel or tree-wide count. Overflow widgets use Monaco's fixed-position
option to escape clipped editor containers, without a global z-index override.

## Models, paths and navigation

`editorModelLocation` keeps the real directory hierarchy:

- Local POSIX: `file:///Users/ivan/project/src/main.ts`.
- Windows drive: `file:///C:/project/src/main.ts`.
- UNC: `file://server/share/src/main.ts`.
- Remote: `vesperwind://p-<hex-provider-id>/home/user/project/src/main.ts`.

The remote authority encodes only the existing opaque filesystem provider ID,
never connection URLs, passwords or private keys. Remote/local schemes differ,
so even a UNC server named like a remote authority cannot collide. Spaces,
Unicode and percent signs are passed raw to Monaco URI construction and escaped
once by Monaco. No tab sequence occurs in the path. Tab IDs remain independent.
SMB paths already presented as local/native paths need no special provider.

All successfully loaded text tabs have models, including inactive tabs. Every
model has its own content listener: bulk symbol rename updates each affected
tab's content and dirty state. Closing a tab disposes its model and subscriptions.
Views are saved/restored when switching tabs. Theme changes do not recreate models.

Rename and Save As rebind a model only when its semantic URI changes, retaining
text, language, EOL, indentation, selection, viewport and past/future history.
Monaco exposes no public undo-stack move API. The small `modelHistory.js` adapter
therefore uses the pinned 0.56.0 undo service shape, and must be reverified before
upgrading Monaco. It moves existing single-resource edit-stack entries rather
than replaying edits or changing the old model's immutable URI. A busy or
unsupported history is left intact and rebind is deferred. Save As rejects a
destination already open in another tab; a colliding external rename retains
the original model rather than overwriting another buffer.

The public `editor.registerEditorOpener` integrates standard F12/definition and
reference/peek navigation with existing tabs. It activates an already open target
and reveals the requested range. Built-in F2 rename and references providers are
retained. Only open application models are supported targets; this is not a
full VS Code project system. Built-in library definitions can use Monaco's
standard library handling.

A relative import can resolve an open sibling model, and JS can see an open TS
export. This works with local and remote URI hierarchies. Closing the dependency
removes it and refreshes TypeScript diagnostics. Missing/unopened dependencies
may produce unresolved-module diagnostics in TS. Lazy dependency loading is
explicitly deferred: no neighboring cloud placeholder is materialized, no SFTP
or local tree is read, and node_modules is not crawled for intelligence.

## Opening TypeScript and preserving media

`.ts` is also an MPEG transport-stream extension. Configured editable `.ts` files
now enter the existing text workflow first. The provider-aware text handler uses
its strict UTF-8/text check and existing size limit. Only `ETEXT_BINARY` on a
still-open `.ts` tab closes the failed text tab and falls back to video. Size,
permission and other read errors remain editor errors; closing during a read
prevents a delayed media open. This is a user-initiated file read, not passive
intelligence. Binary MPEG files retain the existing media path.

The default editable list includes `.htm` and `.less`. An untouched previous
default list gains these entries; custom lists are preserved in Node and Rust.
Settings schema remains version 7; no intelligence settings are persisted.

## Prettier, themes and failure isolation

Prettier remains in its independent bundled worker. Standard JS/TS on-type/range
formatting and HTML/CSS/JSON formatters are disabled where Prettier owns formatting;
LESS retains its built-in formatter because Prettier's current integration does
not support LESS. Editing indentation remains separate from Prettier settings.
Format Document keeps the model, and native diagnostics observe the resulting
edit/Undo normally. Save/Save As/Save and Close retain the existing format-before-
write pipeline and error behavior. Intelligence is not a Save prerequisite.

The theme registry and theme assets are unchanged. Monaco supplies suggestion,
hover, signature, peek, diagnostic and bracket colors from the selected theme.
Worker-sync failures are isolated with settled promises; text buffers, Save and
Prettier continue to operate. No CDN, npm, GitHub or external language API is
contacted by runtime intelligence. Documentation links in built-in hover are
normal links and are followed only if the user opens them.

## Verification

`editorIntelligence.test.js` instantiates the actual bundled TypeScript, CSS,
HTML and JSON worker implementations. It covers object/DOM completion, inferred
hover, signatures, TS type errors, malformed brackets, valid strings/comments/
templates, JS variants and JSX/TSX, mixed JS-to-TS imports, Unicode/space paths,
local/SFTP provider isolation, import hover/definition/references/rename, removal
of dependencies, HTML tag/attribute/closing completion, CSS/SCSS/LESS suggestions
and diagnostics, JSON validation, conservative defaults and failure isolation.

`editorTextOpening.test.js` and `fileTypes.test.js` cover strict provider-aware
TypeScript reads, MPEG fallback and cancellation/error distinctions. Save tests
cover destination collision rejection. Node/Rust settings tests verify additive
changes to untouched defaults without changing custom editable lists.

Open `test/fixtures/editor/monaco-intelligence.html` through Vite for real browser
Web Worker and Vue component integration. Seven checks pass: JS features and live
markers; definition tab activation and bulk rename of inactive dirty buffers;
URI rebinding with cursor/EOL/indentation and Undo/Redo; actual HTML/CSS/SCSS/LESS
providers and JSON/TS markers; Prettier model identity and Undo; model disposal
and virtual SFTP; contextual pairs, duplicate-closer prevention and JS/Vue Enter
indentation. The fixture does not issue filesystem reads. The existing Monaco
formatting fixture remains a separate regression check.

Native macOS acceptance runs the bundled debug QA app at `tauri://localhost`
with a distinct temporary product/bundle identifier and a separate test settings
file. JS trigger-character completion, Ctrl+Space, Tab acceptance, inferred hover,
DOM completion and setTimeout signature help have been observed in the native
WebView. The final QA app opened TypeScript sources with ordinary double-click. F12
activated the exported definition; F2 renamed three references in two tabs,
marked both buffers dirty and both saved the updated text. Shift+F12 showed three
references and Option+F12 showed the exported definition in the standard Peek UI.
A semantic type-error marker cleared after correction; Prettier kept working and
Cmd+Z restored the unformatted valid source. Invalid JSON produced one marker,
then correction/formatting/saving gave Saved with zero errors. HTML suggested
class; SCSS and LESS suggested display and rendered syntax errors. All of these
used the bundled native WebView, rather than a dev-server page.

Native widgets were visually checked on Vesperwind Dark 2026, One Dark Pro,
Dracula, Nord and GitHub Light. GitHub Light retained a white editor within the
dark application, with readable suggestions, hover, signature help and Peek.
Nested brackets retained theme colors. Native pairs (), [], {}, double/single
quotes and duplicate-closer skipping passed. Template-backtick pairs passed the
actual browser editor check; a physical backtick check through the current
Russian VNC keyboard layout was not used as evidence. The existing MPEG .ts
fixture successfully fell back to the video viewer and loaded/played.
The temporary QA settings path is a per-launch environment override, not a
production default or checked-in application configuration.

Bundle comparison against the preceding main: main JS 802,490 -> 803,004 bytes
(+514); EditorWorkspace 4,017,582 -> 4,025,336 (+7,754). The TypeScript worker remains
7,031,801 bytes and the Prettier dispatcher worker 2,116 bytes, byte-identical by
asset name. No second Monaco entry point was introduced. Vite reports only the
existing large-chunk notice, with no new static/dynamic import warnings.

Delivery checks passed: npm test (500 passed), cargo test (157 passed, 8 existing
ignored), cargo fmt --check, git diff --check, frontend build and debug Tauri app
build. The full tests use a host runtime because existing filesystem-watcher and
loopback tests cannot run inside the restricted sandbox. Physical Windows/Linux UI and an actual remote SFTP
connection are distinct from macOS and virtual provider test evidence.

Deferred: lazy imports, project configs/typings, LSP/Volar/ESLint, external VS Code
extensions, Git, Problems panel, package-manager integration and project-code
execution.

## Header follow-up

At the user's request the main toolbar has no standalone vertical separators.
Settings is an accessible, compact icon button after the connection indicator at
the right edge, with the existing tooltip/action. Toolbar markup and its shared
SCSS partial supply this change; button group outlines remain normal controls.
The final native editor view was visually verified, and the relocated icon
opened Settings with the isolated QA storage path.
