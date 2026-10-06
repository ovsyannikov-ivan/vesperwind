import { reactive } from 'vue'

// An outbound native drag (Finder/Explorer) replaces the HTML5 drag in the
// desktop app. While it is active, panels treat it like an internal file
// drag; the drop itself arrives from the native layer with page coordinates.
export const nativeDrag = reactive({ active: null })

export const beginNativeDrag = (payload) => { nativeDrag.active = payload }
export const endNativeDrag = () => { nativeDrag.active = null }
export const activeNativeDrag = () => nativeDrag.active

/** Resolve the drop target under a native drop point. */
export const nativeDropTarget = (x, y, documentRef = globalThis.document) => {
  const element = documentRef?.elementFromPoint?.(x, y)
  if (!element) return null
  const terminal = element.closest?.('[data-terminal-drop-target]')
  if (terminal) return { kind: 'terminal', element: terminal }
  const panel = element.closest?.('[data-panel-side]')
  if (!panel) return null
  const row = element.closest?.('[data-directory-drop-target]')
  const path = row ? row.dataset.dropPath : panel.dataset.currentPath
  const name = row ? row.dataset.dropName : panel.dataset.currentName
  if (!path) return null
  return {
    kind: 'directory',
    targetPanel: panel.dataset.panelSide,
    target: { providerId: panel.dataset.providerId, path, name, isDirectory: true },
  }
}
