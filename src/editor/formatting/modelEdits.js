// A minimal replacement lets Monaco track selections outside the changed span.
export const replacementEdit = (model, text) => {
  const before = model.getValue()
  if (before === text) return null
  let start = 0, end = before.length, nextEnd = text.length
  while (start < end && start < nextEnd && before[start] === text[start]) start++
  while (end > start && nextEnd > start && before[end - 1] === text[nextEnd - 1]) { end--; nextEnd-- }
  const from = model.getPositionAt(start), to = model.getPositionAt(end)
  return { range: { startLineNumber: from.lineNumber, startColumn: from.column,
    endLineNumber: to.lineNumber, endColumn: to.column }, text: text.slice(start, nextEnd), forceMoveMarkers: true }
}

export const applyFormattedText = (model, result, editor, monaco) => {
  const active = editor?.getModel() === model
  const selection = active ? editor.getSelection() : null
  const view = active ? editor.saveViewState() : null
  const tracked = selection && !selection.isEmpty()
    ? model.deltaDecorations([], [{ range: selection, options: {} }]) : []
  const targetEol = result.text.includes('\r\n') ? '\r\n' : '\n'
  const text = result.text.replace(/\r\n|\r|\n/g, targetEol)
  model.pushStackElement()
  if (model.getEOL() !== targetEol) model.pushEOL(targetEol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
  const edit = replacementEdit(model, text)
  if (edit) model.pushEditOperations(selection ? [selection] : [], [edit], () => null)
  model.pushStackElement()
  if (active && editor.getModel() === model) {
    if (view) editor.restoreViewState(view)
    // Nonempty selections use Monaco's tracked range; a caret uses Prettier's mapping.
    if (selection?.isEmpty() && result.cursorOffset >= 0) {
      const offset = result.text.slice(0, result.cursorOffset).replace(/\r\n|\r|\n/g, targetEol).length
      editor.setPosition(model.getPositionAt(offset))
    } else if (tracked.length) {
      const range = model.getDecorationRange(tracked[0])
      if (range) editor.setSelection(monaco.Selection.fromRange(range, selection.getDirection()))
    }
  }
  if (tracked.length) model.deltaDecorations(tracked, [])
  return model.getValue()
}
