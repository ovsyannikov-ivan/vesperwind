// Monaco's standalone default only navigates within the source editor's current
// model. Use its existing open-handler extension point for Vesperwind tabs.
export const installEditorNavigation = (monaco, editor, findTab, activate) =>
  monaco.editor.registerEditorOpener({ async openCodeEditor(source, resource, selection) {
    if (source !== editor && !findTab(source?.getModel()?.uri)) return false
    const tab = findTab(resource)
    if (!tab || tab.loading || tab.error) return false
    await activate(tab.id)
    if (editor.getModel()?.uri.toString() !== resource.toString()) return false
    if (selection) {
      const range = 'lineNumber' in selection
        ? { startLineNumber: selection.lineNumber, startColumn: selection.column,
          endLineNumber: selection.lineNumber, endColumn: selection.column }
        : selection
      editor.setSelection(range)
      editor.revealRangeInCenter(range)
    }
    editor.focus()
    return true
  } })
