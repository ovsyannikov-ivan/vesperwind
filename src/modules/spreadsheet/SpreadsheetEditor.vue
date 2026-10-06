<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import { modelToUniver } from './adapters/univer.js'
import { attachSpreadsheetRuntime } from './runtime.js'
import '@univerjs/preset-sheets-core/lib/index.css'
import './styles/spreadsheet.scss'

const props = defineProps({ tab: { type: Object, required: true }, visible: Boolean })
const host = ref(null)
let univer = null
let univerAPI = null
let workbook = null
let disposeRuntime = null
let disposeCommands = null

const updateTheme = (event) => {
  const dark = (event?.detail?.theme || document.documentElement.getAttribute('data-bs-theme')) !== 'light'
  univerAPI?.toggleDarkMode(dark)
}

onMounted(() => {
  if (!host.value || !props.tab.model) return
  try {
    const dark = document.documentElement.getAttribute('data-bs-theme') !== 'light'
    const created = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS) },
      darkMode: dark,
      presets: [UniverSheetsCorePreset({ container: host.value })],
    })
    univer = created.univer
    univerAPI = created.univerAPI
    workbook = univerAPI.createWorkbook(modelToUniver(props.tab.model, props.tab.fileName))
    disposeRuntime = attachSpreadsheetRuntime(props.tab.id, {
      snapshot: () => workbook.save(),
      finishEditing: () => workbook.endEditingAsync?.(true),
    })
    disposeCommands = workbook.onCommandExecuted((command) => {
      if (command?.type !== univerAPI.Enum.CommandType.MUTATION) return
      props.tab.revision += 1
      props.tab.dirty = true
      props.tab.saveError = null
    })
    window.addEventListener('vesperwind:theme-changed', updateTheme)
  } catch (error) {
    props.tab.error = { code: 'EUNIVER_INIT', message: error?.message || 'Unable to initialize spreadsheet editor' }
    disposeCommands?.dispose()
    disposeRuntime?.()
    univer?.dispose()
    workbook = null
    univer = null
    univerAPI = null
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('vesperwind:theme-changed', updateTheme)
  disposeCommands?.dispose()
  disposeRuntime?.()
  univer?.dispose()
  workbook = null
  univer = null
  univerAPI = null
})
</script>

<template>
  <div class="spreadsheet-editor" :aria-label="`Spreadsheet: ${tab.fileName}`">
    <div class="spreadsheet-warning" role="note">
      {{ tab.fileName.toLowerCase().endsWith('.xls') ? 'Legacy XLS: ' : 'Excel workbook: ' }}styles, charts and advanced features may be lost on Save.
      <span v-if="tab.model?.warnings?.length">{{ tab.model.warnings.join('; ') }}.</span>
    </div>
    <div ref="host" class="spreadsheet-editor-host" />
  </div>
</template>
