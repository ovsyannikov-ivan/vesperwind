import { isSameOrDescendantPath } from './filesystemPath.js'

export const PANEL_SWAP_THRESHOLD = 6

const INTERACTIVE_HEADER_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
].join(', ')

export const oppositePanelSide = (side) => (side === 'left' ? 'right' : 'left')

export const swapPanelPair = ({ left, right }) => ({ left: right, right: left })

export const restorePanelViewState = (saved, providerId, filesystemRoot, initial) => {
  const withinRoot = (path) => isSameOrDescendantPath(filesystemRoot.path, path)
  if (saved?.providerId !== providerId || !withinRoot(saved?.root?.path)) {
    return {
      root: initial,
      selectedNode: initial,
      selectedEntries: [],
      anchorPath: '',
      expandedPaths: [],
      scrollTop: 0,
      restored: false,
    }
  }

  const selectedEntries = (saved.selectedEntries || []).filter((entry) =>
    (!entry.providerId || entry.providerId === providerId) && withinRoot(entry.path))
  return {
    root: saved.root,
    selectedNode: withinRoot(saved.selectedNode?.path) ? saved.selectedNode : saved.root,
    selectedEntries,
    anchorPath: selectedEntries.some((entry) => entry.path === saved.anchorPath)
      ? saved.anchorPath : selectedEntries[0]?.path || '',
    expandedPaths: (saved.expandedPaths || []).filter(withinRoot),
    scrollTop: Math.max(0, Number(saved.scrollTop) || 0),
    restored: true,
  }
}

export const isPanelSwapHandle = (target) =>
  !target?.closest?.(INTERACTIVE_HEADER_SELECTOR)

export const crossedPanelSwapThreshold = (startX, startY, clientX, clientY) =>
  Math.hypot(clientX - startX, clientY - startY) >= PANEL_SWAP_THRESHOLD
