import test from 'node:test'
import assert from 'node:assert/strict'
import { URI } from 'monaco-editor/base/common/uri.js'
import { TypeScriptWorker } from 'monaco-editor/languages/features/typescript/tsWorker.js'
import { CSSWorker } from 'monaco-editor/languages/features/css/cssWorker.js'
import { HTMLWorker } from 'monaco-editor/languages/features/html/htmlWorker.js'
import { JSONWorker } from 'monaco-editor/languages/features/json/jsonWorker.js'
import { editorModelLocation } from '../src/editor/modelUri.js'
import { editorCompilerOptions, configureLanguageServices, syncLanguageModels } from '../src/editor/languageServices.js'
import { CUSTOM_LANGUAGE_CONFIGURATIONS as configurations } from '../src/editor/languageConfigurations.js'

const compiler = editorCompilerOptions({ ScriptTarget: { ESNext: 99 }, ModuleKind: { ESNext: 99 },
  ModuleResolutionKind: { NodeJs: 2 }, JsxEmit: { Preserve: 1 } })
const location = (filePath, filesystemId = 'local') => URI.from(editorModelLocation({ filePath, filesystemId }))
const mirror = (filePath, text, provider = 'local') => ({ uri: location(filePath, provider), version: 1,
  text, getValue() { return this.text }, change(value) { this.text = value; this.version++ } })
const tsWorker = (models) => new TypeScriptWorker({ getMirrorModels: () => models },
  { compilerOptions: compiler, extraLibs: {}, inlayHintsOptions: {} })
const labels = completion => new Set(completion?.entries?.map(entry => entry.name))

test('model URIs preserve hierarchy, Unicode, percent signs and provider identity', () => {
  const uri = location('/Users/Ivan/Проект с пробелом/100%/main.ts')
  assert.equal(URI.parse(uri.toString()).path, '/Users/Ivan/Проект с пробелом/100%/main.ts')
  assert.equal(uri.path, '/Users/Ivan/Проект с пробелом/100%/main.ts')
  assert.equal(location('c:\\work\\src\\main.ts').path, '/C:/work/src/main.ts')
  assert.equal(location('C:/work/src/main.ts').toString(), location('c:\\work\\src\\main.ts').toString())
  assert.equal(location('\\\\SERVER\\share\\main.ts').authority, 'server')
  assert.equal(location('\\\\SERVER\\share\\main.ts').path, '/share/main.ts')
  assert.notEqual(location('/home/user/main.ts', 'sftp:server-a').toString(), location('/home/user/main.ts', 'sftp:server-b').toString())
  assert.notEqual(location('/home/user/main.ts').toString(), location('/home/user/main.ts', 'sftp:server-a').toString())
  assert.equal(location('/home/user/main.ts', 'sftp:server-a').path, '/home/user/main.ts')
  const remote = location('/share/main.ts', 'sftp:server-a')
  assert.notEqual(location(`\\\\${remote.authority}\\share\\main.ts`).toString(), remote.toString())
})

test('custom language configurations provide contextual quotes, brackets and comments', () => {
  for (const id of ['vue', 'toml', 'groovy', 'nginx']) {
    assert.ok(configurations[id].comments)
    assert.ok(configurations[id].brackets.some(([open, close]) => open === '{' && close === '}'))
    assert.ok(configurations[id].autoClosingPairs.some(pair => pair.open === '"' && pair.notIn.includes('comment')))
  }
  assert.deepEqual(configurations.groovy.comments.blockComment, ['/*', '*/'])
  assert.equal(configurations.nginx.comments.lineComment, '#')
  assert.equal(configurations.toml.comments.lineComment, '#')
  assert.ok(configurations.vue.indentationRules.increaseIndentPattern.test('<template>'))
  assert.ok(!configurations.vue.indentationRules.increaseIndentPattern.test('<input>'))
  assert.equal(configurations.ignore.autoClosingPairs.length, 0)
})

test('actual TypeScript worker offers semantic JS members, DOM APIs, hover and signatures', async () => {
  const model = mirror('/qa/test.js', "const user={name:'Ivan',age:42};\nuser.")
  const worker = tsWorker([model])
  const members = labels(await worker.getCompletionsAtPosition(model.uri.toString(), model.text.length))
  assert.ok(members.has('name') && members.has('age'))
  const hover = await worker.getQuickInfoAtPosition(model.uri.toString(), model.text.indexOf('user') + 1)
  assert.match(hover.displayParts.map(part => part.text).join(''), /name: string/)
  model.change("const element=document.querySelector('div');\nelement.")
  const dom = labels(await worker.getCompletionsAtPosition(model.uri.toString(), model.text.length))
  assert.ok(dom.has('classList') && dom.has('addEventListener'))
  model.change('setTimeout(')
  assert.ok((await worker.getSignatureHelpItems(model.uri.toString(), model.text.length)).items.length)
})

test('actual TypeScript worker reports semantic and malformed bracket diagnostics and updates after edits', async () => {
  const model = mirror('/qa/errors.ts', "const age: number = 'hello'")
  const worker = tsWorker([model])
  assert.ok((await worker.getSemanticDiagnostics(model.uri.toString())).some(d => d.code === 2322))
  for (const text of ['function foo( {', 'const x = [1, 2', 'const x = {a:1', 'foo(']) {
    model.change(text)
    assert.ok((await worker.getSyntacticDiagnostics(model.uri.toString())).length, text)
  }
  model.change("const x = '{[(}'; // {[(\nconst y = `braces ${1} } (`;\n")
  assert.equal((await worker.getSyntacticDiagnostics(model.uri.toString())).length, 0)
  model.change('const age: number = 42')
  assert.equal((await worker.getSemanticDiagnostics(model.uri.toString())).length, 0)
})

test('JS variants, JSX/TSX and mixed JS-to-TS imports use the standard parser and inferred types', async () => {
  for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']) {
    const model = mirror(`/qa/variant.${extension}`, `const user={name:'Ivan',age:42};\nuser.`)
    const members = labels(await tsWorker([model]).getCompletionsAtPosition(model.uri.toString(), model.text.length))
    assert.ok(members.has('name') && members.has('age'), extension)
    if (extension.endsWith('x')) {
      model.change('const view = <div className="hello" />')
      assert.equal((await tsWorker([model]).getSyntacticDiagnostics(model.uri.toString())).length, 0)
    }
  }
  const utils = mirror('/qa/utils.ts', 'export const answer: number = 42')
  const main = mirror('/qa/main.js', "import {answer} from './utils';\nanswer.toFixed(2)")
  const info = await tsWorker([utils, main]).getQuickInfoAtPosition(main.uri.toString(), main.text.lastIndexOf('answer') + 1)
  assert.match(info.displayParts.map(part => part.text).join(''), /answer: number/)
})

test('open TS and JS files resolve imports, exported types, definition, references and rename on every provider', async () => {
  for (const provider of ['local', 'sftp:server-a', 'sftp:server-b']) {
    for (const extension of ['ts', 'js']) {
      const utils = mirror(`/qa/Проект с пробелом/src/utils.${extension}`, 'export const answer = {value:42}', provider)
      const main = mirror(`/qa/Проект с пробелом/src/main.${extension}`, `import { answer } from './utils${extension === 'js' ? '.js' : ''}';\nanswer.value`, provider)
      const other = mirror(utils.uri.path, 'export const answer = {wrong:42}', `${provider}:other`)
      const models = [utils, main, other], worker = tsWorker(models), uri = main.uri.toString()
      const offset = main.text.lastIndexOf('answer') + 1
      const definition = await worker.getDefinitionAtPosition(uri, offset)
      assert.ok(definition.some(item => item.fileName === utils.uri.toString()))
      assert.ok(!definition.some(item => item.fileName === other.uri.toString()))
      const hover = await worker.getQuickInfoAtPosition(uri, offset)
      assert.match(hover.displayParts.map(part => part.text).join(''), /value: number/)
      assert.equal((await worker.getSemanticDiagnostics(uri)).filter(d => d.category === 1).length, 0)
      assert.ok((await worker.getReferencesAtPosition(uri, offset)).length >= 2)
      const rename = await worker.findRenameLocations(utils.uri.toString(), utils.text.indexOf('answer') + 1, false, false, true)
      assert.ok(rename.some(item => item.fileName === uri))
      models.splice(0, 1)
      assert.ok(!(await worker.getDefinitionAtPosition(uri, offset))?.some(item => item.fileName === utils.uri.toString()))
      if (extension === 'ts') assert.ok((await worker.getSemanticDiagnostics(uri)).some(d => d.code === 2307))
    }
  }
})

test('HTML uses built-in attribute, tag and closing-tag completion and hover', async () => {
  const model = mirror('/qa/index.html', '<div cla')
  const worker = new HTMLWorker({ getMirrorModels: () => [model] },
    { languageId: 'html', languageSettings: { data: { useDefaultDataProvider: true } } })
  assert.ok((await worker.doComplete(model.uri.toString(), { line: 0, character: 8 })).items.some(item => item.label === 'class'))
  model.change('<di')
  assert.ok((await worker.doComplete(model.uri.toString(), { line: 0, character: 3 })).items.some(item => item.label === 'div'))
  model.change('<div>\n</')
  assert.ok((await worker.doComplete(model.uri.toString(), { line: 1, character: 2 })).items.some(item => item.label.includes('div')))
  assert.ok(await worker.doHover(model.uri.toString(), { line: 0, character: 2 }))
  // Monaco's HTMLWorker has no doValidation API: HTML is deliberately not a syntax checker.
  assert.equal(typeof worker.doValidation, 'undefined')
})

test('CSS, SCSS and LESS use actual built-in property/value completion and syntax diagnostics', async () => {
  for (const languageId of ['css', 'scss', 'less']) {
    const model = mirror(`/qa/style.${languageId}`, '.foo { disp }')
    const worker = new CSSWorker({ getMirrorModels: () => [model] },
      { languageId, options: { validate: true, data: { useDefaultDataProvider: true } } })
    assert.ok((await worker.doComplete(model.uri.toString(), { line: 0, character: 11 })).items.some(item => item.label === 'display'))
    model.change('.foo { display: }')
    assert.ok((await worker.doComplete(model.uri.toString(), { line: 0, character: 16 })).items.some(item => item.label === 'flex'))
    model.change('.foo { color: ; @@@')
    assert.ok((await worker.doValidation(model.uri.toString())).some(d => d.severity === 1))
  }
})

test('JSON syntax diagnostics distinguish invalid/valid JSON without schema network requests', async () => {
  const model = mirror('/qa/data.json', '{"foo":1,"bar":}')
  const worker = new JSONWorker({ getMirrorModels: () => [model] },
    { languageId: 'json', languageSettings: { validate: true, allowComments: false,
      enableSchemaRequest: false, schemas: [] } })
  assert.ok((await worker.doValidation(model.uri.toString())).some(d => d.severity === 1))
  model.change('{"foo":1,"bar":2}')
  assert.equal((await worker.doValidation(model.uri.toString())).length, 0)
  model.change('{"$schema":"https://example.invalid/no-network.json","foo":1}')
  assert.equal((await worker.doValidation(model.uri.toString())).filter(d => d.severity === 1).length, 0)
})

test('mixed/later model synchronization is failure-isolated and excludes non-script/disposed models', async () => {
  const requests = []
  const monaco = { typescript: {
    getJavaScriptWorker: async () => (...uris) => { requests.push(uris); throw new Error('Worker unavailable') },
    getTypeScriptWorker: async () => (...uris) => { requests.push(uris) },
  } }
  const models = ['javascript', 'typescript', 'vue', 'javascript'].map((language, i) => ({
    uri: `uri-${i}`, getLanguageId: () => language, isDisposed: () => i === 3,
  }))
  const result = await syncLanguageModels(monaco, models)
  assert.deepEqual(requests, [['uri-0', 'uri-1'], ['uri-0', 'uri-1']])
  assert.deepEqual(result.map(item => item.status), ['rejected', 'fulfilled'])
})

test('service defaults keep JS conservative, TS semantic, schemas offline and Prettier independent', () => {
  const defaults = () => ({ modeConfiguration: { rename: true, documentFormattingEdits: true },
    getExtraLibs: () => ({}), setExtraLibs() {},
    setCompilerOptions(value) { this.compiler = value },
    setDiagnosticsOptions(value) { this.diagnosticsOptions = value },
    setEagerModelSync(value) { this.eager = value },
    setModeConfiguration(value) { this.modeConfiguration = value },
  })
  const ts = { ScriptTarget: { ESNext: 99 }, ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { NodeJs: 2 }, JsxEmit: { Preserve: 1 },
    javascriptDefaults: defaults(), typescriptDefaults: defaults() }
  const monaco = { typescript: ts, css: { cssDefaults: defaults(), scssDefaults: defaults(), lessDefaults: defaults() },
    html: { htmlDefaults: defaults() }, json: { jsonDefaults: defaults() } }
  configureLanguageServices(monaco)
  assert.equal(ts.javascriptDefaults.diagnosticsOptions.noSemanticValidation, true)
  assert.equal(ts.typescriptDefaults.diagnosticsOptions.noSemanticValidation, false)
  for (const mode of [ts.javascriptDefaults, ts.typescriptDefaults]) {
    assert.equal(mode.diagnosticsOptions.noSyntaxValidation, false)
    assert.equal(mode.diagnosticsOptions.noSuggestionDiagnostics, false)
    assert.equal(mode.compiler.checkJs, false)
    assert.equal(mode.eager, true)
    assert.equal(mode.modeConfiguration.documentRangeFormattingEdits, false)
    assert.equal(mode.modeConfiguration.onTypeFormattingEdits, false)
  }
  assert.equal(monaco.json.jsonDefaults.diagnosticsOptions.enableSchemaRequest, false)
  assert.equal(monaco.css.lessDefaults.modeConfiguration.documentFormattingEdits, true)
  assert.equal(monaco.html.htmlDefaults.modeConfiguration.documentFormattingEdits, false)
})
