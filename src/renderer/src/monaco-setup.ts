// Bundles Monaco and its workers locally so the editor works offline in the packaged app.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

monaco.editor.defineTheme('iris-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#15151c',
    'editor.lineHighlightBackground': '#1c1c26',
    'editorLineNumber.foreground': '#4a4a5e',
    'editorLineNumber.activeForeground': '#9d9db5'
  }
})

monaco.editor.defineTheme('iris-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fbfbfd',
    'editor.lineHighlightBackground': '#f1f1f6',
    'editorLineNumber.foreground': '#b4b4c4',
    'editorLineNumber.activeForeground': '#6e6e85'
  }
})

export { monaco }
