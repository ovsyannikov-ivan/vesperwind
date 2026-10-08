// Monaco has no public API for moving an undo stack to a new immutable URI.
// This small adapter is deliberately pinned to Monaco 0.56.0 and exercised on
// actual models (past + future, EOL, repeated moves). Never mutate model.uri.
export const moveModelHistory = (source, destination) => {
  const service = source._undoRedoService
  const oldKey = service.getUriComparisonKey(source.uri)
  const newKey = service.getUriComparisonKey(destination.uri)
  const stack = service._editStacks.get(oldKey)
  if (!stack) {
    // The destination URI might have a cached history from an earlier closed
    // file with identical text. It must not become this tab's history.
    service.removeElements(destination.uri)
    return
  }
  const entries = [...stack._past, ...stack._future]
  if (stack.locked || entries.some(entry => entry.type !== 0 ||
    typeof entry.actual.setModel !== 'function' || !entry.actual.matchesResource(source.uri))) {
    throw new Error('Cannot move a document while its undo history is busy')
  }
  service.removeElements(destination.uri)
  service._editStacks.delete(oldKey)
  stack.strResource = newKey
  stack.resourceLabel = destination.uri.path
  for (const entry of entries) {
    entry.actual.setModel(destination)
    entry.strResource = newKey
    entry.resourceLabel = destination.uri.path
    entry.strResources = [newKey]
    entry.resourceLabels = [destination.uri.path]
  }
  service._editStacks.set(newKey, stack)
  destination._alternativeVersionId = source.getAlternativeVersionId()
  destination._versionId = source.getVersionId()
}
