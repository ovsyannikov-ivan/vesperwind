<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GitFileDiff from './GitFileDiff.vue'

const props = defineProps({ viewer: { type: Object, required: true } })
const state = props.viewer.state
const theme = ref(
  document.documentElement.dataset.bsTheme === 'dark' ? 'dark' : 'light',
)
const updateTheme = () => {
  theme.value =
    document.documentElement.dataset.bsTheme === 'dark' ? 'dark' : 'light'
}
const files = computed(() =>
  state.view === 'working' ? state.files : state.historyFiles,
)
const diffScroll = ref(null)
const context = computed(() =>
  state.view === 'working' ? 'working' : state.selectedCommit || 'history',
)
const scrollAnchors = new Map()
let renderedContext = context.value
const records = computed(() =>
  files.value
    .map((file) => props.viewer.diffs.records.get(props.viewer.fileKey(file)))
    .filter(Boolean),
)
const date = (timestamp) => new Date(timestamp * 1000).toLocaleString()
const captureAnchor = () => {
  const root = diffScroll.value
  if (!root) return null
  const top = root.getBoundingClientRect().top
  const element = [...root.querySelectorAll('[data-git-anchor]')].find(
    (element) => element.getBoundingClientRect().bottom > top,
  )
  return element
    ? {
        key: element.dataset.gitAnchor,
        offset: element.getBoundingClientRect().top - top,
        top: root.scrollTop,
      }
    : { top: root.scrollTop }
}
const restoreAnchor = (anchor) => {
  const root = diffScroll.value
  if (!root) return
  const element =
    anchor?.key &&
    [...root.querySelectorAll('[data-git-anchor]')].find(
      (element) => element.dataset.gitAnchor === anchor.key,
    )
  if (element)
    root.scrollTop +=
      element.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      anchor.offset
  else root.scrollTop = anchor?.top || 0
}
watch(
  context,
  async (key, previous) => {
    if (previous) scrollAnchors.set(previous, captureAnchor())
    if (scrollAnchors.size > 32)
      scrollAnchors.delete(scrollAnchors.keys().next().value)
    await nextTick()
    if (context.value !== key) return
    renderedContext = key
    restoreAnchor(scrollAnchors.get(key))
  },
  { flush: 'pre' },
)
watch(
  () =>
    records.value.map((record) => [
      record.key,
      record.expanded,
      record.near,
      record.result,
    ]),
  async () => {
    const key = context.value,
      anchor = captureAnchor()
    if (key !== renderedContext) return
    await nextTick()
    if (key === context.value) restoreAnchor(anchor)
  },
  { flush: 'pre' },
)
const showHistory = () => {
  if (state.commits.length)
    void props.viewer.selectCommit(state.selectedCommit || state.commits[0].sha)
  else {
    state.view = 'history'
    props.viewer.diffs.sync([], 'history')
  }
}
onMounted(() =>
  window.addEventListener('vesperwind:theme-changed', updateTheme),
)
onBeforeUnmount(() =>
  window.removeEventListener('vesperwind:theme-changed', updateTheme),
)
</script>

<template>
  <section class="git-viewer" aria-label="Git repository viewer">
    <header class="git-toolbar">
      <i class="mdi mdi-git" aria-hidden="true" />
      <strong :title="state.repository.path">{{
        state.repository.name
      }}</strong>
      <span class="git-branch"
        ><i class="mdi mdi-source-branch" aria-hidden="true" />
        {{
          state.branch ||
          (state.detached
            ? 'Detached ' + state.head?.slice(0, 8)
            : 'No commits')
        }}</span
      >
      <span
        class="git-live"
        role="status"
        :title="
          state.watchError?.message ||
          'Observes filesystem and Git metadata changes'
        "
        >{{
          state.updating ? 'Updating…' : state.live ? 'Live' : 'Reconnecting…'
        }}</span
      >
      <button
        class="compact-icon-button"
        type="button"
        title="Refresh repository"
        aria-label="Refresh repository"
        @click="viewer.refresh"
      >
        <i class="mdi mdi-refresh" aria-hidden="true" />
      </button>
      <label class="visually-hidden" :for="'git-mode-' + state.repository.id"
        >Diff mode</label
      >
      <select
        :id="'git-mode-' + state.repository.id"
        v-model="state.mode"
        class="form-select form-select-sm git-mode"
        aria-label="Diff mode"
      >
        <option value="split">Split</option>
        <option value="unified">Unified</option>
      </select>
    </header>
    <nav class="git-views" aria-label="Repository views">
      <button
        class="compact-button"
        :class="{ 'is-active': state.view === 'working' }"
        type="button"
        :aria-pressed="state.view === 'working'"
        @click="viewer.showWorking"
      >
        Working Changes <span>{{ state.files.length }}</span>
      </button>
      <button
        class="compact-button"
        :class="{ 'is-active': state.view === 'history' }"
        type="button"
        :aria-pressed="state.view === 'history'"
        @click="showHistory"
      >
        Commit History
      </button>
    </nav>
    <div v-if="state.error" class="git-notice text-danger" role="alert">
      {{ state.error.message }}
    </div>
    <div
      v-if="state.watchError"
      class="git-notice text-body-secondary"
      role="status"
    >
      {{ state.watchError.message }}
    </div>
    <div class="git-content">
      <aside
        v-if="state.view === 'history'"
        class="git-sidebar"
        aria-label="Commit history"
      >
        <div class="git-history">
          <button
            v-for="commit in state.commits"
            :key="commit.sha"
            class="git-commit"
            :class="{ 'is-active': commit.sha === state.selectedCommit }"
            type="button"
            :title="
              commit.sha + '\n' + commit.author + '\n' + date(commit.timestamp)
            "
            @click="viewer.selectCommit(commit.sha)"
          >
            <span>{{ commit.subject }}</span
            ><small>{{ commit.sha.slice(0, 8) }} · {{ commit.author }}</small>
          </button>
          <button
            v-if="state.hasMore"
            class="btn btn-sm btn-neutral m-2"
            type="button"
            @click="viewer.more"
          >
            Load more commits
          </button>
          <p v-if="!state.commits.length && !state.loading" class="git-empty">
            No commits yet.
          </p>
        </div>
      </aside>
      <main class="git-diff-pane">
        <div
          v-if="state.view === 'history' && state.commit"
          class="git-commit-detail"
        >
          <strong class="selectable-text">{{ state.commit.subject }}</strong>
          <span class="selectable-text"
            >{{ state.commit.author }} ·
            {{ date(state.commit.timestamp) }}</span
          >
          <code class="selectable-text">{{ state.commit.sha }}</code>
          <span
            v-if="state.commit.parents.length"
            class="git-parents selectable-text"
            >Parents:
            {{
              state.commit.parents.map((sha) => sha.slice(0, 8)).join(', ')
            }}</span
          >
          <span class="text-body-secondary"
            >{{ files.length }} changed files</span
          >
        </div>
        <div
          ref="diffScroll"
          class="git-diff-scroll"
          aria-label="Changed file diffs"
        >
          <p
            v-if="state.commitError"
            class="git-empty text-danger"
            role="alert"
          >
            {{ state.commitError.message }}
          </p>
          <p v-else-if="state.loading || state.commitLoading" class="git-empty">
            Reading repository…
          </p>
          <template v-else>
            <GitFileDiff
              v-for="record in records"
              :key="context + record.key"
              :record="record"
              :collection="viewer.diffs"
              :scroll-root="diffScroll"
              :theme="theme"
              :mode="state.mode"
            />
            <p v-if="!files.length" class="git-empty">
              {{
                state.view === 'working'
                  ? 'Working tree is clean.'
                  : 'No changed files.'
              }}
            </p>
          </template>
        </div>
      </main>
    </div>
  </section>
</template>
