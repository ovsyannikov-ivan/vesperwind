import { getMediaKind } from '../../shared/mediaTypes.js'

// The bar stays mounted. Pausing also cancels any pending background autoplay;
// closing a foreground viewer deliberately has no inverse/resume operation.
export const createPlaybackCoordinator = ({ pauseBackgroundAudio }) => {
  const beforePlayback = async (kind) => {
    if (kind === 'video' || kind === 'audio') await pauseBackgroundAudio()
  }
  return {
    beforePlayback,
    openMedia: async (context, open, canOpen = () => true) => {
      if (getMediaKind(context?.node?.name) === 'video') await beforePlayback('video')
      return canOpen() ? open(context) : false
    },
  }
}
