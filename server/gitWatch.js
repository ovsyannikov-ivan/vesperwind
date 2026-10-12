import fs from 'node:fs'
import files from 'node:fs/promises'
import path from 'node:path'
import {
  openRepository,
  repositoryDirectories,
  assertLocal,
  gitOperation,
} from './git.js'

export const createGitWatchRegistry = ({
  delay = 180,
  limit = 2048,
  watch = fs.watch,
} = {}) => {
  const records = new Map(),
    pending = new Map()
  const subscribe = async (socket, requestedPath) => {
    const repo = await openRepository(requestedPath)
    let record = records.get(repo.id)
    if (!record) {
      if (records.size >= 16)
        throw Object.assign(new Error('Open repository watch limit reached'), {
          code: 'EGIT_WATCH_LIMIT',
        })
      record = {
        repo,
        consumers: new Set(),
        aliases: new Set([requestedPath]),
        watchers: new Map(),
        timer: null,
        stopped: false,
        rebuilding: false,
        again: false,
        error: null,
      }
      records.set(repo.id, record)
      const emit = () => {
        for (const consumer of record.consumers)
          consumer.emit('git:changed', {
            repositoryId: repo.id,
            path: repo.path,
            error: record.error,
          })
      }
      const rebuild = async () => {
        if (record.stopped) return
        if (record.rebuilding) {
          record.again = true
          return
        }
        record.rebuilding = true
        try {
          const { directories, limited } = await repositoryDirectories(
            repo,
            limit,
            false,
          )
          const desired = new Set(directories)
          // Git objects are immutable. Observe only mutable refs/logs and admin roots.
          let metadataLimited = false
          const metadata = [...new Set([repo.gitDir, repo.commonDir])]
          for (const root of metadata) {
            await assertLocal([root])
            desired.add(root)
            const queue = ['refs', 'logs'].map((name) => path.join(root, name))
            while (queue.length && desired.size < limit + 256) {
              const dir = queue.shift()
              try {
                await files.lstat(dir)
                await assertLocal([dir])
                desired.add(dir)
                for (const entry of await files.readdir(dir, {
                  withFileTypes: true,
                }))
                  if (entry.isDirectory() && !entry.isSymbolicLink())
                    queue.push(path.join(dir, entry.name))
              } catch (error) {
                desired.delete(dir)
                if (error.code !== 'ENOENT') throw error
              }
            }
            metadataLimited ||= queue.length > 0
          }
          if (record.stopped) return
          record.error =
            limited || metadataLimited
              ? {
                  code: 'EGIT_WATCH_LIMIT',
                  message:
                    'Watcher directory budget reached; periodic recovery is active',
                }
              : null
          for (const [dir, watcher] of record.watchers)
            if (!desired.has(dir)) {
              watcher.close()
              record.watchers.delete(dir)
            }
          for (const dir of desired)
            if (!record.watchers.has(dir)) {
              try {
                const watcher = watch(dir, { persistent: false }, schedule)
                watcher.on('error', (error) => {
                  watcher.close()
                  record.watchers.delete(dir)
                  record.error = { code: 'EGIT_WATCH', message: error.message }
                  schedule()
                })
                record.watchers.set(dir, watcher)
              } catch (error) {
                record.error = { code: 'EGIT_WATCH', message: error.message }
              }
            }
        } catch (error) {
          record.error = {
            code: error.code || 'EGIT_WATCH',
            message: error.message,
          }
        } finally {
          record.rebuilding = false
          if (record.again) {
            record.again = false
            schedule()
          }
        }
      }
      function schedule() {
        if (record.stopped || record.timer) return
        record.timer = setTimeout(async () => {
          record.timer = null
          const previousError = JSON.stringify(record.error)
          emit()
          await rebuild()
          if (JSON.stringify(record.error) !== previousError) emit()
        }, delay)
      }
      record.rebuild = rebuild
      // Recovery repairs topology after missed events, without constant status polling.
      record.recovery = setInterval(() => {
        for (const watcher of record.watchers.values()) watcher.close()
        record.watchers.clear()
        const previousError = JSON.stringify(record.error)
        emit()
        void rebuild().then(() => { if (JSON.stringify(record.error) !== previousError) emit() })
      }, 30000)
      record.recovery.unref?.()
      record.ready = rebuild()
    }
    if (record.consumers.size) await record.rebuild()
    record.aliases.add(requestedPath)
    record.consumers.add(socket)
    await record.ready
    return {
      ok: true,
      repository: repo,
      watching: record.watchers.size > 0,
      error: record.error,
    }
  }
  const unsubscribe = (socket, requestedPath) => {
    for (const [id, record] of records) {
      if (
        requestedPath &&
        requestedPath !== id &&
        requestedPath !== record.repo.path &&
        !record.aliases.has(requestedPath)
      )
        continue
      record.consumers.delete(socket)
      if (record.consumers.size) continue
      record.stopped = true
      clearTimeout(record.timer)
      clearInterval(record.recovery)
      for (const watcher of record.watchers.values()) watcher.close()
      record.watchers.clear()
      records.delete(id)
    }
  }
  // Serialize subscribe/unsubscribe per socket so closing during async setup cannot leak.
  const queue = (socket, action) => {
    const operation = (pending.get(socket) || Promise.resolve())
      .catch(() => {})
      .then(action)
    pending.set(socket, operation)
    void operation
      .finally(() => {
        if (pending.get(socket) === operation) pending.delete(socket)
      })
      .catch(() => {})
    return operation
  }
  return {
    subscribe,
    unsubscribe,
    queue,
    size: () => records.size,
    watcherCount: () =>
      [...records.values()].reduce(
        (sum, record) => sum + record.watchers.size,
        0,
      ),
  }
}
export const registerGitHandlers = (socket, registry) => {
  for (const operation of [
    'detect',
    'status',
    'branches',
    'log',
    'commit',
    'diff',
    'watch',
    'unwatch',
  ]) {
    socket.on(`git:${operation}`, async (payload, acknowledge) => {
      try {
        if (payload?.filesystemId !== 'local')
          throw Object.assign(
            new Error('Git is available only for local filesystems'),
            { code: 'EFILESYSTEM_ID' },
          )
        const response =
          operation === 'watch'
            ? await registry.queue(socket, async () => {
                const result = await registry.subscribe(socket, payload.path)
                if (socket.connected === false) registry.unsubscribe(socket)
                return result
              })
            : operation === 'unwatch'
              ? await registry.queue(socket, () => {
                  registry.unsubscribe(socket, payload.path)
                  return { ok: true }
                })
              : { ok: true, ...(await gitOperation(operation, payload)) }
        acknowledge?.(response)
      } catch (error) {
        acknowledge?.({
          ok: false,
          error: { code: error.code || 'EGIT', message: error.message },
        })
      }
    })
  }
  socket.on('disconnect', () => {
    void registry.queue(socket, () => registry.unsubscribe(socket))
  })
}
