<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import FilePreview from './FilePreview.vue'
import { getFileIcon } from '../utils/fileIcons.js'
import { formatFileSize, formatModifiedAtTitle } from '../utils/fileMetadata.js'
import { getFileStatusBadge } from '../utils/contentAvailability.js'
import { runtime } from '../api/runtime.js'
import { PERMISSION_ROWS, PERMISSION_COLUMNS, permissionMatrix, matrixMode, modeOctal, symbolicMode } from '../utils/permissions.js'
const props = defineProps({ state: { type: Object, required: true } })
const emit = defineEmits(['close'])
const element = ref(null)
const p = computed(() => props.state.properties.value)
const current = computed(() => props.state.current.value)
const icon = computed(() => getFileIcon({ ...current.value.node, isDirectory: p.value?.type === 'directory' }).icon)
const badge = computed(() => getFileStatusBadge(p.value, current.value.providerId))
const showPermissions = computed(() => Boolean(p.value?.permissions) || runtime.mode === 'tauri')
const matrix = computed(() => permissionMatrix(props.state.values.value.mode ?? p.value?.permissions?.mode))
const toggle = (row, column, checked) => {
  const next = matrix.value.map((row) => [...row]); next[row][column] = checked
  props.state.draft.value.mode = modeOctal(matrixMode(next, p.value.permissions.mode))
}
const identity = (name, id, label) => id == null ? 'Not provided' : name ? `${name} (${id})` : `${label} ${id}`
let modal, previousFocus
onMounted(() => {
  previousFocus = document.activeElement
  modal = new Modal(element.value, { keyboard: false })
  element.value.addEventListener('hide.bs.modal', (event) => { if (props.state.saving.value) event.preventDefault() })
  element.value.addEventListener('hidden.bs.modal', () => emit('close'), { once: true })
  modal.show()
})
onBeforeUnmount(() => { modal?.hide(); modal?.dispose(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) })
</script>
<template>
  <Teleport to="body">
    <div ref="element" class="modal properties-modal" tabindex="-1" aria-labelledby="properties-title" aria-describedby="properties-description" @keydown.esc.prevent.stop="!state.saving.value && $emit('close')">
      <div class="modal-dialog modal-xl modal-dialog-centered">
        <form class="modal-content" @submit.prevent="state.apply()">
          <div class="modal-header">
            <h1 id="properties-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi" :class="icon" aria-hidden="true" />Properties — {{ current.node.name }}</h1>
            <button class="btn-close" type="button" aria-label="Close properties" :disabled="state.saving.value" @click="$emit('close')" />
          </div>
          <div class="modal-body">
            <p id="properties-description" class="visually-hidden">File information, preview and permissions. Changes affect only this item.</p>
            <div v-if="state.loading.value && !p" class="p-3" role="status">Loading properties…</div>
            <div v-if="state.error.value" class="alert alert-danger py-2 small" role="alert">{{ state.error.value.message }} <button class="btn btn-sm btn-neutral" type="button" @click="state.refresh({ load: true })">Retry</button></div>
            <div v-if="p" class="properties-columns">
              <div class="properties-details">
                <section aria-labelledby="properties-general">
                  <h2 id="properties-general" class="fs-6 mb-3">General</h2>
                  <dl class="properties-metadata">
                    <dt>Name</dt><dd>{{ p.name }}</dd>
                    <dt>Kind</dt><dd>{{ p.type === 'symlink' ? 'Symbolic link' : p.type === 'alias' ? 'Finder alias' : p.type === 'directory' ? 'Folder' : p.name.includes('.') ? `${p.name.split('.').at(-1).toUpperCase()} file` : p.type }}</dd>
                    <dt>Path</dt><dd>{{ p.path }}</dd>
                    <template v-if="p.target"><dt>Target</dt><dd>{{ p.target }}</dd></template>
                    <dt>Size</dt><dd v-if="p.type !== 'directory'">{{ p.size == null ? '—' : formatFileSize(p.size) }}</dd>
                    <dd v-else>
                      <span v-if="state.size.value">{{ formatFileSize(state.size.value.bytes) }} · {{ state.size.value.items.toLocaleString() }} items</span>
                      <span v-else>Not calculated</span>
                      <div class="mt-1 d-flex align-items-center gap-2">
                        <span v-if="state.sizeState.value === 'calculating'" class="small" role="status">Calculating…</span>
                        <span v-else-if="state.sizeState.value === 'cancelled'" class="small text-body-secondary">Cancelled · partial result</span>
                        <button v-if="state.sizeState.value === 'calculating'" class="btn btn-sm btn-neutral" type="button" @click="state.cancelSize()">Cancel calculation</button>
                        <button v-else-if="p.capabilities.calculateSize" class="btn btn-sm btn-neutral" type="button" @click="state.calculate()">{{ state.size.value ? 'Recalculate' : 'Calculate' }}</button>
                      </div>
                      <div v-if="state.size.value?.errors" class="small text-body-secondary">{{ state.size.value.errors }} items could not be inspected</div>
                      <div v-if="state.sizeError.value" class="small text-danger" role="alert">{{ state.sizeError.value.message }}</div>
                    </dd>
                    <dt>Created</dt><dd>{{ formatModifiedAtTitle(p.createdAt) || (current.providerId.startsWith('sftp:') ? 'Not provided by server' : '—') }}</dd>
                    <dt>Modified</dt><dd>{{ formatModifiedAtTitle(p.modifiedAt) || '—' }}</dd>
                    <template v-if="badge || p.metadataWarnings?.length"><dt>Availability</dt><dd><span v-if="badge">{{ badge.label }}</span><div v-for="(warning, index) in p.metadataWarnings" :key="index" class="small text-danger" role="alert">{{ warning.message }}</div></dd></template>
                  </dl>
                </section>
                <section v-if="showPermissions" aria-labelledby="properties-permissions" class="mt-4">
                  <h2 id="properties-permissions" class="fs-6 mb-3">Permissions</h2>
                  <p v-if="p.permissionsMessage" class="small text-body-secondary">{{ p.permissionsMessage }}</p>
                  <template v-if="p.permissions">
                    <div class="row g-2 mb-3">
                      <div class="col-6"><label for="properties-uid" class="form-label">Owner</label>
                        <div class="small mb-1">{{ identity(p.permissions.ownerName, p.permissions.uid, 'UID') }}</div>
                        <input v-if="p.capabilities.changeOwner" id="properties-uid" v-model="state.draft.value.uid" class="form-control form-control-sm" inputmode="numeric" aria-label="Owner UID" :disabled="state.saving.value">
                      </div>
                      <div class="col-6"><label for="properties-gid" class="form-label">Group</label>
                        <div class="small mb-1">{{ identity(p.permissions.groupName, p.permissions.gid, 'GID') }}</div>
                        <input v-if="p.capabilities.changeGroup" id="properties-gid" v-model="state.draft.value.gid" class="form-control form-control-sm" inputmode="numeric" aria-label="Group GID" :disabled="state.saving.value">
                      </div>
                    </div>
                    <table v-if="p.permissions.mode != null" class="table table-sm permissions-matrix align-middle mb-2">
                      <thead><tr><th scope="col"></th><th v-for="column in PERMISSION_COLUMNS" :key="column" scope="col">{{ column }}</th></tr></thead>
                      <tbody><tr v-for="(row, ri) in PERMISSION_ROWS" :key="row"><th scope="row">{{ row }}</th>
                        <td v-for="(column, ci) in PERMISSION_COLUMNS" :key="column"><input type="checkbox" class="form-check-input" :checked="matrix[ri][ci]" :aria-label="`${row} ${column}`" :disabled="!p.capabilities.changeMode || state.saving.value" @change="toggle(ri, ci, $event.target.checked)"></td>
                      </tr></tbody>
                    </table>
                    <div v-if="p.permissions.mode != null" class="d-flex gap-2 align-items-center">
                      <label for="properties-mode" class="form-label mb-0">Mode</label>
                      <input id="properties-mode" v-model="state.draft.value.mode" class="form-control form-control-sm properties-mode" maxlength="4" inputmode="numeric" :readonly="!p.capabilities.changeMode" :disabled="state.saving.value" :aria-invalid="state.values.value.mode === null">
                      <code>{{ symbolicMode(state.values.value.mode ?? p.permissions.mode) }}</code>
                    </div>
                    <p v-if="p.permissions.mode & 0o7000" class="small text-body-secondary mt-2 mb-0">Special bits are preserved.</p>
                    <p v-if="state.invalid.value" class="small text-danger mt-2 mb-0">Use valid numeric IDs and three octal rwx digits; keep existing special bits.</p>
                  </template>
                  <div v-if="state.permissionError.value" class="small text-danger mt-2" role="alert">{{ state.permissionError.value.message }}</div>
                </section>
              </div>
              <section class="properties-preview-column" :aria-label="p.type === 'directory' ? 'Folder summary' : 'Preview'">
                <h2 class="fs-6 mb-3">{{ p.type === 'directory' ? 'Folder' : 'Preview' }}</h2>
                <div v-if="p.type === 'directory'" class="properties-folder-summary">
                  <i class="mdi mdi-folder-outline" aria-hidden="true" /><p class="mb-1">{{ p.name }}</p><p class="small text-body-secondary">{{ current.providerId }}</p>
                  <p v-if="state.size.value">{{ formatFileSize(state.size.value.bytes) }} · {{ state.size.value.items.toLocaleString() }} items</p>
                </div>
                <template v-else-if="state.preview.value">
                  <FilePreview :preview="state.preview.value" compact />
                  <button v-if="state.preview.value.error" class="btn btn-sm btn-neutral align-self-center mt-2" type="button" @click="state.loadPreview()">Retry preview</button>
                </template>
                <div v-else-if="p.capabilities.preview" class="properties-preview-prompt">
                  <p>{{ p.metadataWarnings?.length ? 'File availability could not be checked. Load Preview will prepare this file.' : state.cloudPreviewPending.value ? 'Preview requires downloading this file' : 'Preview is available on demand' }}</p>
                  <button class="btn btn-sm btn-neutral" type="button" @click="state.loadPreview()">Load Preview</button>
                </div>
                <div v-else class="properties-preview-prompt">Preview is unavailable for this entry.</div>
              </section>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-neutral" type="button" :disabled="state.saving.value" @click="$emit('close')">Cancel</button>
            <button class="btn btn-sm btn-primary" type="submit" :disabled="!state.canApply.value">{{ state.saving.value ? 'Applying…' : 'Apply' }}</button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
<style lang="scss" scoped>
.properties-modal {
  .modal-dialog { max-width: min(1100px, calc(100vw - 2rem)); }
  .modal-content { max-height: calc(100dvh - 2rem); }
  .modal-title { overflow-wrap: anywhere; }
  .modal-body { overflow: auto; min-height: 0; }
  .properties-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; }
  .properties-details { min-width: 0; user-select: text; }
  .properties-metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .5rem 1rem; font-size: .875rem; dd { margin: 0; overflow-wrap: anywhere; } dt { font-weight: 500; color: var(--bs-secondary-color); } }
  .permissions-matrix { font-size: .8rem; th { font-weight: 500; } td, th:not(:first-child) { text-align: center; } }
  .properties-mode { width: 5rem; }
  .properties-preview-column { display: flex; flex-direction: column; min-width: 0; height: min(58vh, 540px); }
  .properties-folder-summary, .properties-preview-prompt { margin: auto; padding: 1rem; text-align: center; overflow-wrap: anywhere; .mdi { font-size: 6rem; color: var(--bs-secondary-color); } }
  @media (max-width: 767px) { .properties-columns { grid-template-columns: minmax(0, 1fr); } .properties-preview-column { height: 320px; } }
}
</style>
