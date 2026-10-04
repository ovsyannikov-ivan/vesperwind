import { getMediaKind } from '../../shared/mediaTypes.js'
import { isSameOrDescendantPath, getFilesystemPathName } from '../utils/filesystemPath.js'

export const audioIdentity = ({ providerId = 'local', path }) => JSON.stringify([providerId, path])
export const createAudioPlaylistState = () => ({
  visible: false, items: [], selectedId: null, currentId: null,
  autoplay: false, playbackStatus: 'idle', playRevision: 0, repeat: 'off', shuffle: false,
  upcoming: [], history: [], historyIndex: -1,
})
const shuffled = (items, random) => {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// Session-only logical queue. Playback is owned by the common media backend.
export const createAudioPlaylist = ({ state = createAudioPlaylistState(), random = Math.random,
  getMetadata = null, concurrency = 2, onStop = () => {}, onPlay = () => {} } = {}) => {
  const find = (id) => state.items.find((item) => item.id === id)
  let disposed = false
  let activeProbes = 0
  const probing = new Set()
  const queueMetadata = () => queueMicrotask(pumpMetadata)
  const pumpMetadata = () => {
    if (disposed || !getMetadata) return
    while (activeProbes < Math.max(1, concurrency)) {
      const item = state.items.find((entry) => !entry.metadataLoaded && entry.id !== state.currentId && !probing.has(entry))
      if (!item) break
      const id = item.id, revision = item.metadataRevision
      const location = { providerId: item.providerId, path: item.path }
      probing.add(item)
      activeProbes++
      void Promise.resolve().then(() => getMetadata(location))
        .then((metadata) => {
          if (disposed || find(id) !== item || revision !== item.metadataRevision || id === state.currentId) return
          if (metadata?.ok) {
            item.duration = Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : null
            item.chapters = metadata.chapters || []
          }
        }).catch(() => {}).finally(() => {
          if (find(id) === item && revision === item.metadataRevision && id !== state.currentId) item.metadataLoaded = true
          probing.delete(item)
          activeProbes--
          pumpMetadata()
        })
    }
  }
  const record = (id) => {
    state.history = state.history.slice(0, state.historyIndex + 1)
    state.history.push(id)
    state.historyIndex = state.history.length - 1
    state.upcoming = state.upcoming.filter((entry) => entry !== id)
  }
  const play = (id, { navigation = false } = {}) => {
    const item = find(id)
    if (!item) return false
    state.currentId = id
    state.selectedId = id
    state.visible = true
    state.autoplay = true
    state.playRevision++
    if (!navigation) record(id)
    onPlay(item)
    queueMetadata()
    return true
  }
  const add = (sources) => {
    const added = []
    for (const source of sources || []) {
      if (!source?.path || source.isDirectory || getMediaKind(source.name) !== 'audio') continue
      const providerId = source.providerId || 'local'
      const id = audioIdentity({ providerId, path: source.path })
      if (find(id)) continue
      const item = { id, key: id, providerId, path: source.path, name: source.name, kind: 'audio',
        duration: null, chapters: [], metadataLoaded: false, metadataRevision: 0 }
      state.items.push(item)
      added.push(id)
    }
    if (!state.selectedId && added.length) state.selectedId = added[0]
    if (state.shuffle) state.upcoming.push(...shuffled(added, random))
    queueMetadata()
    return added
  }
  const open = (node, providerId = 'local') => {
    add([{ ...node, providerId }])
    return play(audioIdentity({ providerId, path: node.path }))
  }
  const setShuffle = (enabled) => {
    state.shuffle = Boolean(enabled)
    state.history = state.currentId ? [state.currentId] : []
    state.historyIndex = state.history.length - 1
    state.upcoming = enabled ? shuffled(state.items.map((item) => item.id).filter((id) => id !== state.currentId), random) : []
  }
  const target = (direction) => {
    if (!state.items.length) return null
    if (state.shuffle) {
      if (direction < 0) return state.history[state.historyIndex - 1] || null
      return state.history[state.historyIndex + 1] || state.upcoming[0] || (state.repeat === 'all' ? 'cycle' : null)
    }
    if (!state.currentId) return state.selectedId || state.items[0].id
    let index = state.items.findIndex((item) => item.id === state.currentId) + direction
    if (index < 0 || index >= state.items.length) {
      if (state.repeat !== 'all') return null
      index = (index + state.items.length) % state.items.length
    }
    return state.items[index]?.id || null
  }
  const step = (direction) => {
    let id = target(direction)
    if (!id) return false
    if (state.shuffle) {
      if (id === 'cycle') {
        state.upcoming = shuffled(state.items.map((item) => item.id), random)
        if (state.upcoming.length > 1 && state.upcoming[0] === state.currentId) {
          ;[state.upcoming[0], state.upcoming[1]] = [state.upcoming[1], state.upcoming[0]]
        }
        id = state.upcoming[0]
      }
      if (direction < 0) state.historyIndex--
      else if (state.historyIndex + 1 < state.history.length) state.historyIndex++
      else record(id)
      return play(id, { navigation: true })
    }
    return play(id)
  }
  const ended = () => {
    if (!state.currentId) return
    if (state.repeat === 'one') return play(state.currentId, { navigation: true })
    if (!step(1)) state.autoplay = false
  }
  const pause = () => { state.autoplay = false; return onStop() }
  const hide = () => { state.visible = false; return pause() }
  const toggleVisible = () => state.visible ? hide() : (state.visible = true)
  const remove = (ids) => {
    const removed = new Set(ids)
    const anchor = state.items.findIndex((item) => item.id === (removed.has(state.currentId) ? state.currentId : state.selectedId))
    const currentRemoved = removed.has(state.currentId)
    if (currentRemoved) { pause(); state.currentId = null }
    state.items = state.items.filter((item) => !removed.has(item.id))
    if (currentRemoved || removed.has(state.selectedId)) state.selectedId = state.items[Math.max(0, Math.min(anchor, state.items.length - 1))]?.id || null
    state.upcoming = state.upcoming.filter((id) => !removed.has(id))
    const before = state.history.slice(0, state.historyIndex + 1).filter((id) => !removed.has(id))
    const after = state.history.slice(state.historyIndex + 1).filter((id) => !removed.has(id))
    state.history = [...before, ...after]
    state.historyIndex = before.length - 1
  }
  const clear = () => {
    pause()
    state.items = []; state.currentId = null; state.selectedId = null
    state.upcoming = []; state.history = []; state.historyIndex = -1
  }
  const sync = ({ action, providerId = 'local', sourcePath, destinationPath, destinationProviderId = providerId }) => {
    const affected = state.items.filter((item) => item.providerId === providerId && isSameOrDescendantPath(sourcePath, item.path))
    if (action === 'delete') return remove(affected.map((item) => item.id))
    if (!['rename', 'move'].includes(action) || !destinationPath) return
    for (const item of affected) {
      const previousId = item.id
      item.path = `${destinationPath}${item.path.slice(sourcePath.length)}`
      item.providerId = destinationProviderId
      item.name = getFilesystemPathName(item.path)
      item.id = audioIdentity(item)
      item.metadataRevision++; item.metadataLoaded = false
      if (state.currentId === previousId) state.currentId = item.id
      if (state.selectedId === previousId) state.selectedId = item.id
      state.upcoming = state.upcoming.map((id) => id === previousId ? item.id : id)
      state.history = state.history.map((id) => id === previousId ? item.id : id)
    }
    // A move onto an existing queued identity must not leave duplicates.
    const seen = new Set()
    state.items = state.items.filter((item) => !seen.has(item.id) && seen.add(item.id))
    state.upcoming = [...new Set(state.upcoming)]
    queueMetadata()
  }
  const acceptState = (id, snapshot) => {
    const item = find(id)
    if (!item || state.currentId !== id) return
    if (snapshot.source && snapshot.source !== `${item.providerId}:${item.path}` && snapshot.source !== item.url) return
    state.playbackStatus = snapshot.status
    if (Number.isFinite(snapshot.duration) && snapshot.duration > 0) {
      item.duration = snapshot.duration
      item.chapters = snapshot.chapters || []
      item.metadataLoaded = true
      item.metadataRevision++
    }
  }
  return { state, add, open, play, pause, hide, toggleVisible, setShuffle, step, target, ended, remove, clear, sync, acceptState,
    cycleRepeat: () => { state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat] },
    dispose: () => { disposed = true },
  }
}
