const configured = new WeakSet()

export const INTELLIGENT_EDITOR_OPTIONS = {
  quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
  quickSuggestionsDelay: 150,
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: 'currentDocument',
  parameterHints: { enabled: true },
  snippetSuggestions: 'inline',
  hover: { enabled: true, delay: 300 },
  autoClosingBrackets: 'languageDefined',
  autoClosingQuotes: 'languageDefined',
  autoSurround: 'languageDefined',
  autoIndent: 'full',
  matchBrackets: 'always',
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true, highlightActiveBracketPair: true, indentation: true },
  renderValidationDecorations: 'on',
  fixedOverflowWidgets: true,
}

export const editorCompilerOptions = (ts) => ({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    allowSyntheticDefaultImports: true,
    // Separate unrelated open scripts instead of merging their global variables.
    moduleDetection: 3,
    noEmit: true,
})

export const configureLanguageServices = (monaco) => {
  if (configured.has(monaco)) return
  // Monaco 0.55+ exposes the service namespaces at the top level.
  const ts = monaco.typescript
  const compilerOptions = editorCompilerOptions(ts)
  for (const [defaults, semantic] of [[ts.javascriptDefaults, false], [ts.typescriptDefaults, true]]) {
    defaults.setCompilerOptions(compilerOptions)
    defaults.setDiagnosticsOptions({ noSyntaxValidation: false, noSemanticValidation: !semantic,
      noSuggestionDiagnostics: false, onlyVisible: false })
    defaults.setEagerModelSync(true)
    defaults.setModeConfiguration({ ...defaults.modeConfiguration,
      completionItems: true, hovers: true, signatureHelp: true, definitions: true,
      references: true, rename: true, diagnostics: true,
      // Prettier owns explicit formatting; editing indentation remains Monaco's.
      documentRangeFormattingEdits: false, onTypeFormattingEdits: false })
  }
  for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults,
    monaco.html.htmlDefaults, monaco.json.jsonDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration,
      completionItems: true, hovers: true, diagnostics: true,
      ...(defaults === monaco.css.lessDefaults ? {} : {
        documentFormattingEdits: false, documentRangeFormattingEdits: false }) })
  }
  monaco.json.jsonDefaults.setDiagnosticsOptions({ ...monaco.json.jsonDefaults.diagnosticsOptions,
    validate: true, allowComments: false, enableSchemaRequest: false, schemas: [] })
  configured.add(monaco)
}

// Eager sync only includes one language when a worker first starts. Explicitly
// sync all open JS/TS models after lifecycle changes, including later/mixed opens.
// This reads model buffers only and never asks a filesystem provider for files.
export const syncLanguageModels = async (monaco, models, refreshDiagnostics = false) => {
  const scripts = [...models].filter(model => !model.isDisposed() &&
    ['javascript', 'typescript'].includes(model.getLanguageId()))
  const resources = scripts.map(model => model.uri)
  if (refreshDiagnostics) {
    // The public extra-libs event also refreshes the built-in diagnostics
    // adapters without terminating a worker that may have pending requests.
    // Preserve the (currently empty) owned extras; no dependency files are added.
    for (const defaults of [monaco.typescript.javascriptDefaults, monaco.typescript.typescriptDefaults]) {
      defaults.setExtraLibs(Object.entries(defaults.getExtraLibs())
        .map(([filePath, lib]) => ({ filePath, content: lib.content })))
    }
  }
  return Promise.allSettled([
    ['javascript', monaco.typescript.getJavaScriptWorker],
    ['typescript', monaco.typescript.getTypeScriptWorker],
  ].filter(([language]) => scripts.some(model => model.getLanguageId() === language))
    .map(async ([, getWorker]) => (await getWorker())(...resources)))
}
