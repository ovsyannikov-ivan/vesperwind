export const createTerminalTab = ({ id, type = 'local', profile, localNumber = 1 }) => ({
  id,
  type,
  connectionId: type === 'ssh' ? profile?.id || null : null,
  title:
    type === 'ssh'
      ? profile?.name || `${profile?.username || ''}@${profile?.host || ''}`
      : localNumber === 1
        ? 'Local'
        : `Local ${localNumber}`,
  status: 'connecting',
  error: '',
})

export const closeTerminalTab = (tabs, activeId, id) => {
  const index = tabs.findIndex((tab) => tab.id === id)

  if (index < 0) {
    return { tabs, activeId }
  }

  const remaining = tabs.filter((tab) => tab.id !== id)
  return {
    tabs: remaining,
    activeId:
      activeId === id
        ? remaining[Math.min(index, remaining.length - 1)]?.id || null
        : activeId,
  }
}
