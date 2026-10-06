import { runtime } from '../api/runtime.js'
import { FILE_ENTRY_MIME } from './fileDrag.js'
import { activeNativeDrag } from './nativeDragSession.js'

/**
 * internal: an HTML5 Vesperwind drag (browser runtime, or a drag that stayed
 * HTML5); native: our own outbound native drag hovering the window;
 * external: files from Finder/Explorer.
 */
export const fileDropKind = (event, capabilities = runtime.capabilities) => {
  const types = Array.from(event?.dataTransfer?.types || [])
  if (types.includes(FILE_ENTRY_MIME)) return 'internal'
  if (activeNativeDrag()) return 'native'
  if (capabilities?.externalFileDrop && types.includes('Files')) return 'external'
  return null
}
