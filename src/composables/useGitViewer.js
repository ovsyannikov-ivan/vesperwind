import { reactive } from 'vue'
import { git } from '../api/git.js'
import { gitWatch } from '../api/gitWatch.js'
import { createGitDiffs } from './useGitDiffs.js'

// This state belongs to a Git tab, survives hiding/switching views, and never
// becomes document content. Only closing the tab disposes it.
export const createGitViewer = (
  repository,
  { api = git, registry = gitWatch } = {},
) => {
  const state = reactive({
    repository,
    branch: null,
    head: null,
    detached: false,
    files: [],
    commits: [],
    hasMore: false,
    view: 'working',
    selectedCommit: null,
    commit: null,
    historyFiles: [],
    mode: 'split',
    commitLoading: false,
    commitError: null,
    loading: true,
    updating: false,
    live: false,
    watchError: null,
    error: null,
  })
  let stopped = false,
    refreshGeneration = 0,
    selectionGeneration = 0,
    historyGeneration = 0
  let busy = false,
    requested = false,
    historyReady = false,
    forceHistory = false
  const diffs = createGitDiffs({
    load: (file, context) =>
      api.diff(repository.path, {
        file: file.path,
        oldPath: file.oldPath,
        scope: file.scope,
        sha: context === 'working' ? null : context,
      }),
  })
  const readHistory = async (count) => {
    const commits = []
    let hasMore = true
    while (hasMore && commits.length < count && !stopped) {
      const page = await api.log(
        repository.path,
        commits.length,
        Math.min(100, count - commits.length),
      )
      if (!page?.ok) return page
      commits.push(...page.commits)
      hasMore = page.hasMore
      if (!page.commits.length) break
    }
    return { ok: true, commits, hasMore }
  }
  const refresh = async (force = false) => {
    forceHistory ||= force
    if (stopped) return
    // Event arriving during IO invalidates the pending result and queues one refresh.
    refreshGeneration++
    if (state.view === 'working') diffs.invalidate()
    requested = true
    if (busy) return
    busy = true
    state.updating = true
    try {
      while (requested && !stopped) {
        requested = false
        const generation = refreshGeneration
        const status = await api.status(repository.path)
        if (stopped || generation !== refreshGeneration) continue
        const shouldReadHistory =
          !historyReady ||
          forceHistory ||
          (status?.ok && status.head !== state.head)
        const history = shouldReadHistory
          ? ++historyGeneration
          : historyGeneration
        const log = shouldReadHistory
          ? await readHistory(Math.max(50, state.commits.length))
          : null
        if (stopped || generation !== refreshGeneration) continue
        state.error = status?.ok ? null : status?.error
        if (status?.ok) {
          state.branch = status.branch
          state.head = status.head
          state.detached = status.detached
          state.files = status.files
        }
        if (log?.ok && history === historyGeneration) {
          state.commits = log.commits
          state.hasMore = log.hasMore
          historyReady = true
          forceHistory = false
        }
        if (state.view === 'working') {
          diffs.sync(state.files, 'working', { refresh: true })
        }
      }
    } finally {
      if (!stopped) {
        state.loading = false
        state.updating = false
      }
      busy = false
    }
  }
  const showWorking = () => {
    selectionGeneration++
    state.view = 'working'
    state.selectedCommit = null
    state.commit = null
    state.commitError = null
    state.commitLoading = false
    diffs.sync(state.files, 'working')
  }
  const selectCommit = async (sha) => {
    if (
      state.view === 'history' &&
      state.selectedCommit === sha &&
      state.commit
    )
      return
    const generation = ++selectionGeneration
    state.view = 'history'
    state.selectedCommit = sha
    state.historyFiles = []
    state.commit = null
    state.commitError = null
    state.commitLoading = true
    diffs.sync([], sha)
    const result = await api.commit(repository.path, sha)
    if (stopped || generation !== selectionGeneration) return
    state.commitLoading = false
    if (!result?.ok) {
      state.commitError = result?.error
      return
    }
    state.commit = result.commit
    state.historyFiles = result.files
    diffs.sync(state.historyFiles, sha)
  }
  const more = async () => {
    const generation = ++historyGeneration,
      offset = state.commits.length
    const result = await api.log(repository.path, offset)
    if (!stopped && generation === historyGeneration && result?.ok) {
      state.commits.push(
        ...result.commits.filter(
          (commit) =>
            !state.commits.some((existing) => existing.sha === commit.sha),
        ),
      )
      state.hasMore = result.hasMore
    }
  }
  const stop = registry.subscribe(repository, (event) => {
    state.watchError = event.error || null
    state.live = !event.error && event.watching !== false
    void refresh(Boolean(event.recovery))
  })
  void refresh()
  return {
    state,
    diffs,
    selectCommit,
    showWorking,
    more,
    refresh: () => refresh(true),
    fileKey: diffs.fileKey,
    dispose: () => {
      stopped = true
      refreshGeneration++
      selectionGeneration++
      historyGeneration++
      diffs.dispose()
      stop()
    },
  }
}
