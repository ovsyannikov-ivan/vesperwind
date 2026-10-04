export const MIN_WORKSPACE_HEIGHT = 140
export const verticalWorkspaceSizes = ({ availableHeight, terminalVisible, playlistVisible, terminalHeight, playlistHeight }) => {
  // The terminal header remains present when collapsed. Both consumers share one budget.
  const separators = (terminalVisible ? 6 : 31) + (playlistVisible ? 6 : 0)
  const budget = Math.max(0, availableHeight - MIN_WORKSPACE_HEIGHT - separators)
  const terminal = terminalVisible ? Math.max(0, terminalHeight) : 0
  const playlist = playlistVisible ? Math.max(0, playlistHeight) : 0
  const terminalMinimum = terminalVisible ? Math.min(120, terminal) : 0
  const playlistMinimum = playlistVisible ? Math.min(80, playlist) : 0
  const minimum = terminalMinimum + playlistMinimum
  if (terminal + playlist <= budget) return { terminal: terminalVisible ? terminal : 31, playlist, budget }
  if (minimum > budget) {
    const scale = budget / minimum
    return { terminal: terminalVisible ? terminalMinimum * scale : 31, playlist: playlistMinimum * scale, budget }
  }
  const extra = terminal + playlist - minimum
  const scale = extra > 0 ? (budget - minimum) / extra : 0
  return { terminal: terminalVisible ? terminalMinimum + (terminal - terminalMinimum) * scale : 31,
    playlist: playlistMinimum + (playlist - playlistMinimum) * scale, budget }
}
