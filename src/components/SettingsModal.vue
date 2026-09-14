<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettings } from '../composables/useSettings.js'
import { useTheme } from '../composables/useTheme.js'
import { parseEditableFilesText } from '../utils/editableFiles.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close'])
const {
  settings,
  storagePath,
  loadSettings,
  saveSettings,
  resetSettings,
} = useSettings()
const { setThemePreference } = useTheme()
const modalElement = ref(null)
const activeSection = ref('general')
const theme = ref('system')
const locale = ref('')
const suffixesText = ref('')
const editableFilesText = ref('')
const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
let modal = null

const syncDraft = () => {
  theme.value = settings.value.appearance.theme
  locale.value = settings.value.appearance.locale
  suffixesText.value = settings.value.filesystem.hiddenNameSuffixes.join('\n')
  editableFilesText.value = settings.value.editor.editableFiles.join('\n')
}

const loadDraft = async () => {
  loading.value = true
  errorMessage.value = ''
  const response = await loadSettings({ force: true })
  loading.value = false

  if (!response?.ok) {
    errorMessage.value = response?.error?.message || 'Unable to load settings'
    return
  }

  syncDraft()
}

const show = () => {
  activeSection.value = 'general'
  modal?.show()
  loadDraft()
}

const close = () => {
  if (!saving.value) {
    setThemePreference(settings.value.appearance.theme)
    emit('close')
  }
}

const handleHide = (event) => {
  if (saving.value) {
    event.preventDefault()
  }
}

const handleHidden = () => {
  if (props.open) {
    setThemePreference(settings.value.appearance.theme)
    emit('close')
  }
}

const save = async () => {
  saving.value = true
  errorMessage.value = ''
  const hiddenNameSuffixes = suffixesText.value
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  const editableFiles = parseEditableFilesText(editableFilesText.value)
  const response = await saveSettings({
    ...settings.value,
    appearance: {
      ...settings.value.appearance,
      theme: theme.value,
      locale: locale.value,
    },
    filesystem: {
      ...settings.value.filesystem,
      hiddenNameSuffixes,
    },
    editor: {
      ...settings.value.editor,
      editableFiles,
    },
  })
  saving.value = false

  if (!response?.ok) {
    errorMessage.value = response?.error?.message || 'Unable to save settings'
    return
  }

  close()
}

const reset = async () => {
  saving.value = true
  errorMessage.value = ''
  const response = await resetSettings()
  saving.value = false

  if (!response?.ok) {
    errorMessage.value = response?.error?.message || 'Unable to reset settings'
    return
  }

  syncDraft()
}

watch(
  () => props.open,
  (isOpen) => {
    if (!modal) {
      return
    }

    if (isOpen) {
      show()
    } else {
      modal.hide()
    }
  },
)

onMounted(() => {
  modal = new Modal(modalElement.value)
  modalElement.value.addEventListener('hide.bs.modal', handleHide)
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)

  if (props.open) {
    show()
  }
})

onBeforeUnmount(() => {
  modalElement.value?.removeEventListener('hide.bs.modal', handleHide)
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  modal?.dispose()
  modal = null
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="modalElement"
      class="modal fade"
      tabindex="-1"
      aria-labelledby="settings-title"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable settings-modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="settings-title" class="modal-title fs-6 d-flex align-items-center gap-2">
              <i class="mdi mdi-cog-outline" aria-hidden="true" />
              Settings
            </h1>
            <button
              class="btn-close"
              type="button"
              aria-label="Close"
              :disabled="saving"
              @click="close"
            />
          </div>

          <div class="modal-body p-0">
            <div class="settings-content">
              <nav class="settings-navigation nav nav-pills flex-column" role="tablist" aria-label="Settings sections">
                <button
                  class="nav-link d-flex align-items-center gap-2 text-start"
                  :class="{ active: activeSection === 'general' }"
                  type="button"
                  role="tab"
                  :aria-selected="activeSection === 'general'"
                  @click="activeSection = 'general'"
                >
                  <i class="mdi mdi-tune-variant" aria-hidden="true" />
                  General
                </button>
                <button
                  class="nav-link d-flex align-items-center gap-2 text-start"
                  :class="{ active: activeSection === 'editor' }"
                  type="button"
                  role="tab"
                  :aria-selected="activeSection === 'editor'"
                  @click="activeSection = 'editor'"
                >
                  <i class="mdi mdi-file-document-edit-outline" aria-hidden="true" />
                  Editor
                </button>
              </nav>

              <section class="settings-page" :aria-busy="loading">
                <div class="settings-panels">
                  <section
                    class="settings-panel"
                    :class="{ 'is-active': activeSection === 'general' }"
                    :aria-hidden="activeSection !== 'general'"
                    :inert="activeSection !== 'general'"
                  >
                  <h2 class="h6 mb-1">Appearance and locale</h2>
                  <p class="text-body-secondary mb-3">
                    Choose the color mode and date formatting used by the application.
                  </p>

                  <label class="form-label" for="appearance-theme">
                    Theme
                  </label>
                  <select
                    id="appearance-theme"
                    v-model="theme"
                    class="form-select form-select-sm"
                    @change="setThemePreference(theme)"
                  >
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                  <div class="form-text">
                    System follows the current OS appearance automatically.
                  </div>

                  <label class="form-label mt-3" for="appearance-locale">
                    Locale
                  </label>
                  <select
                    id="appearance-locale"
                    v-model="locale"
                    class="form-select form-select-sm"
                  >
                    <option value="">Default — DD.MM.YYYY HH:mm</option>
                    <option value="ru-RU">Russian — ru-RU</option>
                    <option value="en-GB">English — en-GB</option>
                  </select>
                  <div class="form-text">
                    Locale-specific formats use the browser’s Intl date formatter.
                  </div>

                  <hr class="my-4">

                  <h2 class="h6 mb-1">File visibility</h2>
                  <p class="text-body-secondary mb-4">
                    Control which entries are hidden in both file panels.
                  </p>

                  <label class="form-label" for="hidden-name-suffixes">
                    Hidden name suffixes
                  </label>
                  <textarea
                    id="hidden-name-suffixes"
                    v-model="suffixesText"
                    class="form-control form-control-sm font-monospace settings-textarea"
                    rows="7"
                    spellcheck="false"
                    placeholder=".localized"
                  />
                  <div class="form-text">
                    One suffix per line. Matching is case-insensitive and applies to files and folders.
                  </div>
                  </section>

                  <section
                    class="settings-panel"
                    :class="{ 'is-active': activeSection === 'editor' }"
                    :aria-hidden="activeSection !== 'editor'"
                    :inert="activeSection !== 'editor'"
                  >
                  <h2 class="h6 mb-1">Editor</h2>
                  <p class="text-body-secondary mb-4">
                    Choose which files open in the Monaco text editor.
                  </p>

                  <label class="form-label" for="editable-files">
                    Editable files
                  </label>
                  <textarea
                    id="editable-files"
                    v-model="editableFilesText"
                    class="form-control form-control-sm font-monospace settings-textarea"
                    rows="9"
                    spellcheck="false"
                    placeholder=".js .ts .vue .env"
                  />
                  <div class="form-text">
                    Separate values with spaces, commas, or new lines. Extensions are case-insensitive;
                    exact names such as Dockerfile are supported too.
                  </div>
                  </section>
                </div>

                <div class="alert alert-secondary d-flex align-items-start gap-2 mt-4 mb-0" role="status">
                  <i class="mdi mdi-database-outline" aria-hidden="true" />
                  <div class="min-w-0">
                    <div>Stored locally as JSON</div>
                    <code class="settings-storage-path">{{ storagePath }}</code>
                  </div>
                </div>

                <div v-if="errorMessage" class="alert alert-danger d-flex align-items-center gap-2 mt-4 mb-0" role="alert">
                  <i class="mdi mdi-alert-outline" aria-hidden="true" />
                  {{ errorMessage }}
                </div>

                <div v-if="loading" class="settings-loading-overlay text-body-secondary">
                  <span class="spinner-border spinner-border-sm" aria-hidden="true" />
                  Loading settings…
                </div>
              </section>
            </div>
          </div>

          <div class="modal-footer justify-content-between">
            <button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              :disabled="loading || saving"
              @click="reset"
            >
              Reset defaults
            </button>
            <div class="d-flex gap-2">
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                :disabled="saving"
                @click="close"
              >
                Cancel
              </button>
              <button
                class="btn btn-sm btn-primary"
                type="button"
                :disabled="loading || saving"
                @click="save"
              >
                <span v-if="saving" class="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
