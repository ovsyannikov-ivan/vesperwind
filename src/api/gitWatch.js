import { backend } from './backend.js'

// One transport subscription per canonical working tree, with serialized lifetime.
export const createGitWatchRegistry = (
  transport,
  {
    delay = 120,
    targetWindow = globalThis.window,
    targetDocument = globalThis.document,
  } = {},
) => {
  const records = new Map(),
    operations = new Map()
  let stopEvents = null,
    stopConnection = null
  const notify = (record, event = {}) => {
    record.event = event
    if (record.timer) return
    record.timer = setTimeout(() => {
      record.timer = null
      for (const callback of record.consumers) callback(record.event)
    }, delay)
  }
  const queue = (record, operation) => {
    const promise = (operations.get(record.id) || Promise.resolve())
      .catch(() => {})
      .then(() =>
        transport.request(`git:${operation}`, {
          filesystemId: 'local',
          path: record.path,
        }),
      )
      .then((response) => {
        if (operation === 'watch' && records.get(record.id) === record)
          notify(record, {
            error:
              response?.error ||
              (!response?.ok ? { message: 'Git watcher unavailable' } : null),
            watching: response?.watching,
          })
      })
      .catch((error) => {
        if (records.get(record.id) === record)
          notify(record, { error: { message: error.message } })
      })
    operations.set(record.id, promise)
    void promise.finally(() => {
      if (operations.get(record.id) === promise) operations.delete(record.id)
    })
  }
  const recover = () => {
    if (targetDocument?.visibilityState === 'hidden') return
    for (const record of records.values()) {
      queue(record, 'watch')
      notify(record, { recovery: true })
    }
  }
  const subscribe = (repository, callback) => {
    if (!stopEvents) {
      stopEvents = transport.subscribe('git:changed', (event) => {
        const record = records.get(event?.repositoryId)
        if (record) notify(record, event)
      })
      stopConnection = transport.subscribeToConnection?.((connected) => {
        if (connected) recover()
        else
          for (const record of records.values())
            notify(record, {
              error: {
                code: 'EDISCONNECTED',
                message: 'Backend disconnected; reconnecting…',
              },
            })
      })
      targetWindow?.addEventListener('focus', recover)
      targetDocument?.addEventListener('visibilitychange', recover)
    }
    let record = records.get(repository.id)
    if (!record) {
      record = {
        id: repository.id,
        path: repository.path,
        consumers: new Set(),
        timer: null,
      }
      records.set(record.id, record)
      queue(record, 'watch')
    }
    record.consumers.add(callback)
    return () => {
      if (!record.consumers.delete(callback) || record.consumers.size) return
      clearTimeout(record.timer)
      records.delete(record.id)
      queue(record, 'unwatch')
      if (!records.size) {
        stopEvents?.()
        stopConnection?.()
        stopEvents = stopConnection = null
        targetWindow?.removeEventListener('focus', recover)
        targetDocument?.removeEventListener('visibilitychange', recover)
      }
    }
  }
  return { subscribe, count: () => records.size }
}
export const gitWatch = createGitWatchRegistry(backend)
