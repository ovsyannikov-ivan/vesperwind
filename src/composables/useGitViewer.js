import { reactive } from 'vue'
import { git } from '../api/git.js'
import { gitWatch } from '../api/gitWatch.js'

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
    selectedFile: null,
    mode: 'split',
    expanded: {},
    diff: null,
    loading: true,
    updating: false,
    live: false,
    watchError: null,
    error: null,
    diffError: null,
  })
  let stopped = false,
    refreshGeneration = 0,
    selectionGeneration = 0,
    diffGeneration = 0,
    historyGeneration = 0
  let busy = false,
    requested = false,
    diffBusy = false,
    diffRequested = false,
    historyReady = false,
    forceHistory = false
  const fileKey = (file) => `${file.scope}\0${file.path}`
  const visibleFiles = () =>
    state.view === 'working' ? state.files : state.historyFiles
  const loadDiff = async () => {
    if (stopped) return
    diffRequested = true
    if (diffBusy) return
    diffBusy = true
    try {
      while (diffRequested && !stopped) {
        diffRequested = false
        const file = state.selectedFile,
          generation = ++diffGeneration,
          sha = state.selectedCommit
        if (!file || state.expanded[fileKey(file)] === false) {
          state.diff = null
          continue
        }
        const result = await api.diff(repository.path, {
          file: file.path,
          oldPath: file.oldPath,
          scope: file.scope,
          sha,
        })
        if (
          stopped ||
          generation !== diffGeneration ||
          fileKey(file) !==
            (state.selectedFile && fileKey(state.selectedFile)) ||
          sha !== state.selectedCommit
        )
          continue
        state.diffError = result?.ok ? null : result?.error
        if (result?.ok && JSON.stringify(state.diff) !== JSON.stringify(result))
          state.diff = result
      }
    } finally {
      diffBusy = false
    }
  }
  const selectFile = (file) => {
    diffGeneration++
    state.selectedFile = file
    state.diff = null
    state.diffError = null
    if (file) state.expanded[fileKey(file)] = true
    void loadDiff()
  }
  const keepFile = () => {
    const files = visibleFiles(),
      previous = state.selectedFile && fileKey(state.selectedFile)
    const next =
      files.find((file) => fileKey(file) === previous) || files[0] || null
    if ((next && fileKey(next)) !== previous) selectFile(next)
    else if (next && state.selectedFile) Object.assign(state.selectedFile, next)
  }
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
          keepFile()
          diffGeneration++
          void loadDiff()
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
    diffGeneration++
    state.view = 'working'
    state.selectedCommit = null
    state.commit = null
    state.selectedFile = null
    keepFile()
  }
  const selectCommit = async (sha) => {
    const generation = ++selectionGeneration
    diffGeneration++
    state.view = 'history'
    state.selectedCommit = sha
    state.selectedFile = null
    state.diff = null
    state.historyFiles = []
    state.commit = null
    state.diffError = null
    const result = await api.commit(repository.path, sha)
    if (stopped || generation !== selectionGeneration) return
    if (!result?.ok) {
      state.diffError = result?.error
      return
    }
    state.commit = result.commit
    state.historyFiles = result.files
    state.diffError = null
    keepFile()
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
    selectFile,
    selectCommit,
    showWorking,
    more,
    refresh: () => refresh(true),
    fileKey,
    dispose: () => {
      stopped = true
      refreshGeneration++
      selectionGeneration++
      diffGeneration++
      historyGeneration++
      stop()
    },
  }
}
