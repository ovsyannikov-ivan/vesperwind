<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import '../../editor/monacoEnvironment.js'
import { settings } from '../../composables/settingsState.js'
import { monacoTypographyOptions } from '../../../shared/editorTypography.js'
import { applyEditorTheme } from '../../editor/themes/registry.js'
const props = defineProps({ modelValue: String, visible: Boolean })
const emit = defineEmits(['update:modelValue', 'run'])
const host = ref(null)
let editor, model, change, themeSequence = 0
const theme = () => { const sequence = ++themeSequence; void applyEditorTheme(monaco, settings.value.editor.theme, document.documentElement.dataset.bsTheme, () => sequence === themeSequence && Boolean(editor)) }
onMounted(() => {
  model = monaco.editor.createModel(props.modelValue || '', 'sql')
  editor = monaco.editor.create(host.value, { model, editContext: false, ...monacoTypographyOptions(settings.value.editor), automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 8 }, ariaLabel: 'SQL query', fixedOverflowWidgets: true })
  change = model.onDidChangeContent(() => emit('update:modelValue', model.getValue()))
  editor.addAction({ id: 'vesperwind.sql.run', label: 'Run SQL', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => emit('run', getQuery()) })
  theme()
  window.addEventListener('vesperwind:theme-changed', theme)
  window.addEventListener('vesperwind:native-edit-history', history)
})
const history = event => {
  if (!props.visible || !editor?.hasTextFocus()) return
  event.preventDefault()
  if (event.detail === 'selectAll') editor.setSelection(model.getFullModelRange())
  else editor.trigger('native', event.detail, null)
}
const getQuery = () => { const selection = editor?.getSelection(); return selection && !selection.isEmpty() ? model.getValueInRange(selection) : model?.getValue() || props.modelValue }
watch(() => props.visible, visible => { if (visible) editor?.layout() })
watch(() => props.modelValue, text => { if (model && model.getValue() !== text) model.setValue(text || '') })
watch(() => [settings.value.editor.fontFamily, settings.value.editor.fontSize], () => editor?.updateOptions(monacoTypographyOptions(settings.value.editor)))
watch(() => settings.value.editor.theme, theme)
onBeforeUnmount(() => { themeSequence++; window.removeEventListener('vesperwind:theme-changed', theme); window.removeEventListener('vesperwind:native-edit-history', history); change?.dispose(); editor?.dispose(); editor = null; model?.dispose() })
defineExpose({ getQuery })
</script>
<template><div ref="host" class="sqlite-query-editor monaco-editor-host" /></template>
