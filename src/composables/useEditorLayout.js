import { reactive, watch } from 'vue'

const STORAGE_KEY = 'vesperwind.editor.layout.v1'
const MIN_TREE_WIDTH = 180
const MAX_TREE_WIDTH = 520

const readStoredWidth = () => {
  try {
    const value = Number.parseInt(localStorage.getItem(STORAGE_KEY) || '', 10)
    return Number.isFinite(value) ? value : 260
  } catch {
    return 260
  }
}

const state = reactive({
  treeWidth: Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, readStoredWidth())),
})

watch(
  () => state.treeWidth,
  (treeWidth) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(treeWidth))
    } catch {
      // The layout still works when storage is unavailable.
    }
  },
)

export const useEditorLayout = () => {
  const setTreeWidth = (value, availableWidth = window.innerWidth) => {
    const responsiveMaximum = Math.max(
      MIN_TREE_WIDTH,
      Math.min(MAX_TREE_WIDTH, availableWidth - 320),
    )
    state.treeWidth = Math.min(
      responsiveMaximum,
      Math.max(MIN_TREE_WIDTH, Math.round(value)),
    )
  }

  return { editorLayout: state, setTreeWidth }
}
