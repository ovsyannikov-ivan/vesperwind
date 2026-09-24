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

export const isPanelSwapHandle = (target) =>
  !target?.closest?.(INTERACTIVE_HEADER_SELECTOR)

export const crossedPanelSwapThreshold = (startX, startY, clientX, clientY) =>
  Math.hypot(clientX - startX, clientY - startY) >= PANEL_SWAP_THRESHOLD
