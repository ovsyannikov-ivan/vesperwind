const locateTextItem = (offset, itemOffsets, itemLengths, preferPrevious = false) => {
  if (itemOffsets.length === 0) {
    return null
  }

  for (let index = 0; index < itemOffsets.length; index += 1) {
    const start = itemOffsets[index]
    const end = start + itemLengths[index]

    if (offset < end || (preferPrevious && offset === end)) {
      return { index, offset: Math.max(0, Math.min(offset - start, itemLengths[index])) }
    }
  }

  const index = itemOffsets.length - 1
  return { index, offset: itemLengths[index] }
}

export const buildPdfTextMatchSegments = (
  textItems,
  matchStarts = [],
  matchLengths = [],
  selectedMatchIndex = -1,
) => {
  const itemOffsets = []
  const itemLengths = []
  let documentOffset = 0

  for (const text of textItems) {
    itemOffsets.push(documentOffset)
    itemLengths.push(text.length)
    documentOffset += text.length
  }

  const matches = matchStarts.map((start, index) => {
    const length = matchLengths[index] || 0
    const begin = locateTextItem(start, itemOffsets, itemLengths)
    const end = locateTextItem(
      start + length,
      itemOffsets,
      itemLengths,
      true,
    )

    return {
      index,
      start,
      end: start + length,
      beginItem: begin?.index ?? -1,
      endItem: end?.index ?? -1,
      selected: index === selectedMatchIndex,
    }
  })

  return textItems.map((text, itemIndex) => {
    const itemStart = itemOffsets[itemIndex]
    const itemEnd = itemStart + itemLengths[itemIndex]
    const boundaries = new Set([0, text.length])

    for (const match of matches) {
      if (match.end <= itemStart || match.start >= itemEnd) {
        continue
      }

      boundaries.add(Math.max(0, match.start - itemStart))
      boundaries.add(Math.min(text.length, match.end - itemStart))
    }

    const sortedBoundaries = [...boundaries].sort((left, right) => left - right)
    const segments = []

    for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
      const from = sortedBoundaries[index]
      const to = sortedBoundaries[index + 1]

      if (from === to) {
        continue
      }

      const absoluteOffset = itemStart + from
      const match = matches.find(
        (candidate) =>
          absoluteOffset >= candidate.start && absoluteOffset < candidate.end,
      )

      segments.push({
        text: text.slice(from, to),
        matchIndex: match?.index ?? -1,
        selected: match?.selected ?? false,
        position: !match
          ? ''
          : match.beginItem === match.endItem
            ? 'single'
            : itemIndex === match.beginItem
              ? 'begin'
              : itemIndex === match.endItem
                ? 'end'
                : 'middle',
      })
    }

    return segments
  })
}
