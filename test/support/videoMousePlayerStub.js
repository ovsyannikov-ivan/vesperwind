import {
  MediaPlayerBackend,
  PlayerStatus,
} from '../../src/player/mediaPlayerBackend.js'
export { PlayerStatus }
export const players = []
export class WebMediaPlayerBackend extends MediaPlayerBackend {
  constructor() {
    super()
    this.seeks = []
    this.commands = []
    players.push(this)
    this.update({
      status: PlayerStatus.PAUSED,
      currentTime: 60,
      duration: 200,
    })
  }
  async setSource() {}
  async play() {
    this.commands.push('play')
    this.update({ status: PlayerStatus.PLAYING })
  }
  async pause() {
    this.commands.push('pause')
    this.update({ status: PlayerStatus.PAUSED })
  }
  async seek(target) {
    this.seeks.push(target)
    this.update({ currentTime: target })
  }
  async refresh() {
    return { state: this.snapshot() }
  }
  close() {
    this.listeners.clear()
  }
  dispose() {
    this.listeners.clear()
  }
}
export class NativeMpvPlayerBackend extends WebMediaPlayerBackend {
  constructor({ sessionId }) {
    super()
    this.sessionId = sessionId
  }
}
export const selectPlayerBackend = async () => 'web'
export const setNativeTransitionCover = async () => true
export const emptyComponent = {
  setup(_, { expose }) {
    expose({ hidePreview() {} })
    return () => null
  },
}
export const useThumbnailPreview = () => ({
  preview: {},
  hide() {},
  show() {},
})
const contextListeners = new Set()
export const overlayActions = []
export const mediaOverlay = {
  onContext(callback) {
    contextListeners.add(callback)
    return () => contextListeners.delete(callback)
  },
  context(value) {
    for (const listener of contextListeners) listener(value)
  },
  onTransition() {
    return () => {}
  },
  snapshot: async () => ({
    context: { sessionId: 'mouse-test', path: '/movie.mp4' },
  }),
  sendAction: async (action) => {
    overlayActions.push(action)
  },
}
export default emptyComponent
