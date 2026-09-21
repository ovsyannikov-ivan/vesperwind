export const DOCUMENT_FIND_INTENTS = Object.freeze({
  OPEN: 'open',
  OPEN_REPLACE: 'open-replace',
  NEXT: 'next',
  PREVIOUS: 'previous',
  CLOSE: 'close',
})

export const isMacPlatform = () =>
  /Mac|iPhone|iPad|iPod/u.test(navigator.userAgentData?.platform || navigator.platform || '')

export const getDocumentFindIntent = (event, mac = isMacPlatform()) => {
  const key = String(event.key || '').toLocaleLowerCase()
  const primaryModifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

  if (key === 'escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return DOCUMENT_FIND_INTENTS.CLOSE
  }

  if (primaryModifier && !event.shiftKey && !event.altKey && key === 'f') {
    return DOCUMENT_FIND_INTENTS.OPEN
  }

  if (
    (mac && primaryModifier && event.altKey && !event.shiftKey && key === 'f') ||
    (!mac && primaryModifier && !event.altKey && !event.shiftKey && key === 'h')
  ) {
    return DOCUMENT_FIND_INTENTS.OPEN_REPLACE
  }

  if (
    (mac && primaryModifier && !event.altKey && key === 'g') ||
    (!mac && !event.metaKey && !event.ctrlKey && !event.altKey && key === 'f3')
  ) {
    return event.shiftKey
      ? DOCUMENT_FIND_INTENTS.PREVIOUS
      : DOCUMENT_FIND_INTENTS.NEXT
  }

  return null
}
