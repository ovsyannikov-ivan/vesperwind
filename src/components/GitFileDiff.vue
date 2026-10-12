<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DiffView, DiffModeEnum } from '@git-diff-view/vue'
import '@git-diff-view/vue/styles/diff-view-pure.css'
import { getEditorLanguage } from '../utils/editorLanguages.js'

const props = defineProps({
  record: { type: Object, required: true },
  collection: { type: Object, required: true },
  scrollRoot: { type: Object, default: null },
  theme: { type: String, required: true },
  mode: { type: String, required: true },
})
const section = ref(null),
  content = ref(null),
  retainedHeight = ref(64)
let observer = null,
  resizeObserver = null,
  stopped = false
const file = computed(() => props.record.file)
const comparison = computed(
  () =>
    ({
      staged: 'HEAD → Index',
      unstaged: 'Index → Worktree',
      untracked: 'Untracked',
      commit: 'Parent → Commit',
    })[file.value.scope],
)
const statusIcon = computed(
  () =>
    ({
      added: 'mdi-file-plus-outline',
      untracked: 'mdi-file-question-outline',
      deleted: 'mdi-file-remove-outline',
      renamed: 'mdi-file-move-outline',
      conflicted: 'mdi-alert-outline',
    })[file.value.status] || 'mdi-file-edit-outline',
)
const data = computed(() => {
  const result = props.record.result
  if (!result?.patch || result.binary || result.oversized) return null
  return {
    oldFile: {
      fileName: file.value.oldPath || file.value.path,
      fileLang: getEditorLanguage(file.value.path),
    },
    newFile: {
      fileName: file.value.path,
      fileLang: getEditorLanguage(file.value.path),
    },
    hunks: [result.patch],
  }
})
const manual = computed(
  () => props.collection.isLarge(props.record) && !props.record.manual,
)
const unavailable = computed(
  () =>
    file.value.binary ||
    file.value.oversized ||
    props.record.result?.binary ||
    props.record.result?.oversized,
)
const connect = () => {
  observer?.disconnect()
  if (!section.value) return
  if (typeof IntersectionObserver === 'undefined') {
    props.collection.setNear(props.record.key, true)
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      props.collection.setNear(
        props.record.key,
        entries.some((entry) => entry.isIntersecting),
      )
    },
    { root: props.scrollRoot, rootMargin: '300px 0px' },
  )
  observer.observe(section.value)
}
watch(() => props.scrollRoot, connect)
watch(
  () => props.record.near,
  (near) => {
    if (!near && content.value && data.value)
      retainedHeight.value = Math.max(64, content.value.offsetHeight)
  },
  { flush: 'pre' },
)
watch(content, async (element) => {
  resizeObserver?.disconnect()
  if (!element || typeof ResizeObserver === 'undefined') return
  await nextTick()
  if (stopped || content.value !== element) return
  resizeObserver = new ResizeObserver(() => {
    if (props.record.near && data.value)
      retainedHeight.value = Math.max(64, element.offsetHeight)
  })
  resizeObserver.observe(element)
})
onMounted(connect)
onBeforeUnmount(() => {
  stopped = true
  observer?.disconnect()
  resizeObserver?.disconnect()
  props.collection.setNear(props.record.key, false)
})
</script>

<template>
  <article ref="section" class="git-file-diff" :data-git-anchor="record.key">
    <button
      class="git-diff-heading"
      type="button"
      :aria-expanded="record.expanded"
      :title="`${file.status}: ${file.path}`"
      @click="collection.toggle(record.key)"
    >
      <i
        class="mdi"
        :class="record.expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'"
        aria-hidden="true"
      />
      <i class="mdi" :class="statusIcon" aria-hidden="true" />
      <span class="git-file-path"
        >{{ file.oldPath ? `${file.oldPath} → ` : '' }}{{ file.path }}</span
      >
      <span class="visually-hidden">{{ file.status }}</span>
      <small>{{ comparison }}</small>
      <span v-if="file.binary || file.oversized" class="text-body-secondary">{{
        file.oversized ? 'Large' : 'Binary'
      }}</span>
      <span v-else class="git-counts"
        ><span class="text-success">+{{ file.additions }}</span>
        <span class="text-danger">&nbsp;−{{ file.deletions }}</span></span
      >
    </button>
    <div v-if="record.expanded" ref="content" class="git-file-diff-content">
      <p v-if="unavailable" class="git-empty text-body-secondary">
        {{
          file.oversized || record.result?.oversized
            ? 'This diff exceeds the text display limit (1 MiB).'
            : 'Binary file changed. Text diff is unavailable.'
        }}
      </p>
      <div v-else-if="manual" class="git-load-diff">
        <button
          class="btn btn-sm btn-neutral"
          type="button"
          :aria-label="`Load diff for ${file.path}`"
          @click="collection.load(record.key)"
        >
          Load diff
        </button>
        <span class="text-body-secondary"
          >Large diffs are not rendered by default.</span
        >
      </div>
      <div v-else-if="record.error" class="git-load-diff" role="alert">
        <span class="text-danger">{{ record.error.message }}</span>
        <button
          class="btn btn-sm btn-neutral"
          type="button"
          @click="collection.load(record.key)"
        >
          Retry
        </button>
      </div>
      <div v-else-if="record.near && data" class="selectable-text">
        <DiffView
          :data="data"
          :diff-view-mode="
            mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified
          "
          :diff-view-theme="theme"
          :diff-view-highlight="true"
          :diff-view-font-size="12"
        />
      </div>
      <p v-else-if="record.near && record.result" class="git-empty">
        No text changes (metadata, rename or submodule).
      </p>
      <div
        v-else
        class="git-diff-placeholder text-body-secondary"
        :style="{ height: `${retainedHeight}px` }"
      >
        {{ record.near ? 'Loading diff…' : '' }}
      </div>
    </div>
  </article>
</template>
