import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') {
      return new JsonWorker()
    }

    if (['css', 'scss', 'less'].includes(label)) {
      return new CssWorker()
    }

    if (['html', 'handlebars', 'razor'].includes(label)) {
      return new HtmlWorker()
    }

    if (['typescript', 'javascript'].includes(label)) {
      return new TypeScriptWorker()
    }

    return new EditorWorker()
  },
}
