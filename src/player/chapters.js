// Source metadata only: chapters are never persisted with resume history.
export const normalizeChapters = (chapters) => (Array.isArray(chapters) ? chapters : [])
  .filter((chapter) => Number.isInteger(chapter?.index) && chapter.index >= 0
    && Number.isFinite(chapter.startTime) && chapter.startTime >= 0)
  .map((chapter) => ({ index: chapter.index,
    title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title : `Chapter ${chapter.index + 1}`,
    startTime: chapter.startTime }))
  .sort((a, b) => a.startTime - b.startTime || a.index - b.index)

export const currentChapterIndex = (chapters, seconds) => {
  let current = null
  for (const chapter of chapters) {
    if (chapter.startTime <= seconds && (!current || chapter.startTime >= current.startTime)) current = chapter
  }
  return current?.index ?? null
}

export const adjacentChapterIndex = (chapters, currentIndex, direction) => {
  const position = chapters.findIndex((chapter) => chapter.index === currentIndex)
  return chapters[position + direction]?.index ?? null
}

export const formatChapterTime = (seconds) => {
  const time = Math.max(0, Math.floor(seconds))
  return [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60]
    .map((value) => String(value).padStart(2, '0')).join(':')
}
