<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DiffView, DiffModeEnum } from '@git-diff-view/vue'
import '@git-diff-view/vue/styles/diff-view-pure.css'
import { getEditorLanguage } from '../utils/editorLanguages.js'

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
const scrollAnchors = new Map()
const selectionKey = computed(
  () =>
    `${state.selectedCommit || 'working'}\0${state.selectedFile ? props.viewer.fileKey(state.selectedFile) : ''}`,
)
const expanded = computed(
  () =>
    state.selectedFile &&
    state.expanded[props.viewer.fileKey(state.selectedFile)] !== false,
)
const diffData = computed(() => {
  if (
    !state.diff?.patch ||
    state.diff.binary ||
    state.diff.oversized ||
    !state.selectedFile
  )
    return null
  return {
    oldFile: {
      fileName: state.selectedFile.oldPath || state.selectedFile.path,
      fileLang: getEditorLanguage(state.selectedFile.path),
    },
    newFile: {
      fileName: state.selectedFile.path,
      fileLang: getEditorLanguage(state.selectedFile.path),
    },
    hunks: [state.diff.patch],
  }
})
const toggleDiff = () => {
  if (!state.selectedFile) return
  const key = props.viewer.fileKey(state.selectedFile)
  state.expanded[key] = !expanded.value
  if (state.expanded[key]) props.viewer.selectFile(state.selectedFile)
}
const showHistory = () => {
  if (state.selectedCommit) state.view = 'history'
  else if (state.commits.length) props.viewer.selectCommit(state.commits[0].sha)
  else {
    state.view = 'history'
    state.selectedFile = null
    state.diff = null
  }
}
const statusIcon = (file) =>
  ({
    added: 'mdi-file-plus-outline',
    untracked: 'mdi-file-question-outline',
    deleted: 'mdi-file-remove-outline',
    renamed: 'mdi-file-move-outline',
    conflicted: 'mdi-alert-outline',
  })[file.status] || 'mdi-file-edit-outline'
const comparison = (file) =>
  ({
    staged: 'HEAD → Index',
    unstaged: 'Index → Worktree',
    untracked: 'Untracked',
    commit: 'Parent → Commit',
  })[file.scope]
const date = (timestamp) => new Date(timestamp * 1000).toLocaleString()
watch(selectionKey, (key, previous) => {
  if (previous && diffScroll.value)
    scrollAnchors.set(previous, diffScroll.value.scrollTop)
  if (scrollAnchors.size > 128)
    scrollAnchors.delete(scrollAnchors.keys().next().value)
  void nextTick(() => {
    if (diffScroll.value)
      diffScroll.value.scrollTop = scrollAnchors.get(key) || 0
  })
})
watch(diffData, async () => {
  const top =
    diffScroll.value?.scrollTop || scrollAnchors.get(selectionKey.value) || 0
  await nextTick()
  if (diffScroll.value) diffScroll.value.scrollTop = top
})
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
            ? `Detached ${state.head?.slice(0, 8)}`
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
      <label class="visually-hidden" :for="`git-mode-${state.repository.id}`"
        >Diff mode</label
      >
      <select
        :id="`git-mode-${state.repository.id}`"
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
      <aside class="git-sidebar" aria-label="Repository changes">
        <div v-if="state.view === 'history'" class="git-history">
          <button
            v-for="commit in state.commits"
            :key="commit.sha"
            class="git-commit"
            :class="{ 'is-active': commit.sha === state.selectedCommit }"
            type="button"
            :title="`${commit.sha}\n${commit.author}\n${date(commit.timestamp)}`"
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
        <div class="git-file-list">
          <template v-for="(file, index) in files" :key="viewer.fileKey(file)">
            <div
              v-if="index === 0 || files[index - 1].scope !== file.scope"
              class="git-list-label"
            >
              {{ comparison(file) }}
            </div>
            <button
              class="git-file"
              :class="{
                'is-active':
                  state.selectedFile &&
                  viewer.fileKey(state.selectedFile) === viewer.fileKey(file),
              }"
              type="button"
              :title="`${file.status}: ${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`"
              @click="viewer.selectFile(file)"
            >
              <i
                class="mdi"
                :class="statusIcon(file)"
                aria-hidden="true"
              /><span class="git-file-path">{{ file.path }}</span>
              <span class="visually-hidden">{{ file.status }}</span
              ><span
                v-if="file.binary || file.oversized"
                class="text-body-secondary"
                >{{ file.oversized ? 'Large' : 'Binary' }}</span
              >
              <span v-else class="git-counts"
                ><span class="text-success">+{{ file.additions }}</span>
                <span class="text-danger">−{{ file.deletions }}</span></span
              >
            </button>
          </template>
          <p v-if="!files.length && !state.loading" class="git-empty">
            {{
              state.view === 'working'
                ? 'Working tree is clean.'
                : 'No changed files.'
            }}
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
        </div>
        <button
          v-if="state.selectedFile"
          class="git-diff-heading"
          type="button"
          :aria-expanded="Boolean(expanded)"
          @click="toggleDiff"
        >
          <i
            class="mdi"
            :class="expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            aria-hidden="true"
          /><span>{{ state.selectedFile.path }}</span
          ><small>{{ comparison(state.selectedFile) }}</small>
        </button>
        <div ref="diffScroll" class="git-diff-scroll selectable-text">
          <template v-if="expanded">
            <p
              v-if="state.diffError"
              class="git-empty text-danger"
              role="alert"
            >
              {{ state.diffError.message }}
            </p>
            <p v-else-if="state.diff?.oversized" class="git-empty">
              This diff exceeds the text display limit (1 MiB).
            </p>
            <p v-else-if="state.diff?.binary" class="git-empty">
              Binary file changed. Text diff is unavailable.
            </p>
            <DiffView
              v-else-if="diffData"
              :data="diffData"
              :diff-view-mode="
                state.mode === 'split'
                  ? DiffModeEnum.Split
                  : DiffModeEnum.Unified
              "
              :diff-view-theme="theme"
              :diff-view-highlight="true"
              :diff-view-font-size="12"
            />
            <p v-else class="git-empty">
              {{
                state.diff
                  ? 'No text changes (metadata, rename or submodule).'
                  : 'Loading diff…'
              }}
            </p>
          </template>
          <p v-else-if="!state.selectedFile" class="git-empty">
            {{
              state.loading
                ? 'Reading repository…'
                : 'Select a changed file to inspect its diff.'
            }}
          </p>
        </div>
      </main>
    </div>
  </section>
</template>
