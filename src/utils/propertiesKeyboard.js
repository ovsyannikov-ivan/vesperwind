const excludedFocus = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .editor-workspace, .modal, [role="dialog"], [role="menu"], .dropdown-menu'
export const propertiesShortcutLabel = (platform = globalThis.navigator?.platform) => /Mac|iPhone|iPad/i.test(platform || '') ? '⌘I' : 'Ctrl+I'
export const canOpenProperties = (event, { selectedCount, workspaceMode, blocked, panelVisible = true }, platform = globalThis.navigator?.platform) => {
  const mac = /Mac|iPhone|iPad/i.test(platform || '')
  const shortcut = mac ? event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'i'
    : (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'i')
      || (event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'Enter')
  return Boolean(shortcut && !event.shiftKey && !event.defaultPrevented && !event.isComposing && !event.repeat
    && selectedCount === 1 && workspaceMode === 'files' && !blocked && panelVisible
    && event.target?.closest?.('.file-panel.is-active') && !event.target.closest(excludedFocus))
}
