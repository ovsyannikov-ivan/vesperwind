// Own Space before focused controls/Media Chrome can toggle playback again.
export const consumeVideoSpace = (event, toggle) => {
  if (event.key !== ' ' || event.defaultPrevented || event.isComposing ||
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  // The repeat of the key that opened the modal must not pause the video.
  if (!event.repeat) void toggle()
  return true
}
