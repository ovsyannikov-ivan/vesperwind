import { getFileExtension } from '../../shared/mediaTypes.js'

export const openTextDocument = async (context, { openText, isOpen, closeText, openVideo, onVideo }) => {
  const tab = await openText(context)
  if (getFileExtension(context.node.name) === 'ts' && tab?.error?.code === 'ETEXT_BINARY' && isOpen(tab)) {
    closeText(tab.id)
    onVideo()
    await openVideo({ ...context, type: 'video' })
  }
  return tab
}
