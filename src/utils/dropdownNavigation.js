const keys = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

export const navigateDropdown = (event, menu) => {
  if (!menu || !keys.has(event.key) || !menu.contains(document.activeElement)) return false

  const items = Array.from(menu.querySelectorAll('.dropdown-item:not(:disabled)'))
  if (!items.length) return false

  const index = items.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
        : (index < 0 ? items.length - 1 : index - 1 + items.length) % items.length

  event.preventDefault()
  items[next].focus({ preventScroll: true })
  return true
}
