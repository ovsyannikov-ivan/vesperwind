const excludedFocus = [
  'input', 'textarea', 'select', 'button', 'a[href]', '[contenteditable]:not([contenteditable="false"])',
  '.monaco-editor', '.editor-workspace', '.xterm', '.terminal-panel',
  '.word-editor', '.spreadsheet-editor', '.panel-address-form',
  '.modal', '[role="dialog"]', '[role="menu"]', '[role="menuitem"]', '.dropdown-menu',
].join(', ')

export const canOpenQuickLook = (event, { workspaceMode, selected, blocked = false, panelVisible = true }) =>
  Boolean(event.key === ' ' && !event.defaultPrevented && !event.repeat && !event.isComposing &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
    workspaceMode === 'files' && panelVisible && !blocked && selected && !selected.isDirectory &&
    event.target?.closest?.('.file-panel.is-active') && !event.target.closest(excludedFocus))

export const canCloseQuickLook = (event) => Boolean(event.key === 'Escape' && !event.defaultPrevented &&
  !event.target.closest?.('.dropdown-menu, [role="menu"], [role="dialog"] [role="dialog"]'))
