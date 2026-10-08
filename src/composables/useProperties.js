import { computed, ref, watch } from 'vue'
import { video } from '../api/video.js'
import { media } from '../api/media.js'
import { filesystem } from '../api/filesystem.js'
import { createPreviewState, loadFilePreview } from './filePreview.js'
import { getQuickLookKind } from './useQuickLook.js'
import { modeOctal, parseOctal, numericIdentity, permissionChanges } from '../utils/permissions.js'
import { notifyEntryChange } from './useEntryChanges.js'
import { entryChange } from './useEntryChanges.js'
import { directoryWatch } from '../api/directoryWatch.js'
import { getFilesystemParentPath } from '../utils/filesystemPath.js'

export const useProperties = ({ io = filesystem, previewLoader = loadFilePreview, thumbnail = video.getThumbnail, probe = media.getMetadata, preparePreview = media.ensureMediaContentReady, onChanged = () => {} } = {}) => {
  const current = ref(null), properties = ref(null), loading = ref(false), error = ref(null), permissionError = ref(null), saving = ref(false)
  const draft = ref({ mode: '', uid: '', gid: '' }), preview = ref(null), size = ref(null), sizeState = ref('idle'), sizeError = ref(null)
  let generation = 0, metadataSequence = 0, controller = null, job = null, editableFiles, releaseWatch = null
  const values = computed(() => ({ mode: parseOctal(draft.value.mode, properties.value?.permissions?.mode || 0), uid: numericIdentity(draft.value.uid), gid: numericIdentity(draft.value.gid) }))
  const changes = computed(() => permissionChanges(properties.value, values.value))
  const invalid = computed(() => ['mode', 'uid', 'gid'].some((field) => properties.value?.capabilities?.[{ mode: 'changeMode', uid: 'changeOwner', gid: 'changeGroup' }[field]] && values.value[field] === null))
  const canApply = computed(() => !loading.value && !error.value && !saving.value && !invalid.value && Object.keys(changes.value).length > 0)
  const location = () => ({ providerId: current.value.providerId, path: current.value.node.path })
  const sync = (value) => {
    properties.value = value
    draft.value = { mode: value.permissions?.mode == null ? '' : modeOctal(value.permissions.mode), uid: value.permissions?.uid == null ? '' : String(value.permissions.uid), gid: value.permissions?.gid == null ? '' : String(value.permissions.gid) }
  }
  const cancelSize = () => { job?.cancel(); job = null; if (sizeState.value === 'calculating') sizeState.value = 'cancelled' }
  const close = () => {
    if (saving.value) return false
    generation++; releaseWatch?.(); releaseWatch = null; controller?.abort(); controller = null; cancelSize(); current.value = null; properties.value = null; preview.value = null
    return true
  }
  const cloudPreviewPending = computed(() => {
    const p = properties.value
    if (!p?.capabilities.preview) return false
    return ['cloud', 'materializing', 'notReady', 'failed'].includes(p.contentAvailability?.state)
      || p.cloudSync?.localContent === 'notFullyLocal'
  })
  const previewOnDemand = computed(() => cloudPreviewPending.value || Boolean(properties.value?.metadataWarnings?.length))
  const loadPreview = async () => {
    if (!current.value || !properties.value?.capabilities.preview) return
    controller?.abort(); controller = new AbortController()
    const p = properties.value, kind = getQuickLookKind({ ...current.value.node, isDirectory: false }, editableFiles)
    const target = createPreviewState({ ...current.value.node, ...p, isDirectory: false }, current.value.providerId, kind, 'properties')
    preview.value = target
    // Media identity stays compact and never starts a player or reads resume history.
    if (['audio', 'video', 'metadata'].includes(kind)) {
      target.loading = false
      const signal = controller.signal
      try {
        // Cloud media reaches this branch only after explicit Load Preview.
        if (['audio', 'video'].includes(kind) && previewOnDemand.value) {
          target.loading = true
          const ready = await preparePreview(location(), { signal, onStatus: (status) => {
            if (!signal.aborted) { target.statusMessage = status.userMessage; target.preparationProgress = status.progress }
          } })
          if (signal.aborted) return
          if (!ready.ok) { target.error = ready.error; return }
        }
        if (kind === 'video' && !signal.aborted) {
          const result = await thumbnail({ ...location(), time: 0, width: 480, signal })
          if (!signal.aborted && result?.thumbnail?.status === 'ready') target.poster = result.thumbnail.url
        }
        if (['audio', 'video'].includes(kind) && !signal.aborted) {
          const result = await probe(location(), { signal })
          if (!signal.aborted && result?.ok) target.mediaMetadata = result
        }
      } catch (error) { if (!signal.aborted) target.error = { message: error.message || 'Unable to preview this media' } }
      finally { if (!signal.aborted) target.loading = false }
      return
    }
    await previewLoader(preview.value, { signal: controller.signal, io, label: 'preview' })
  }
  const refresh = async ({ load = false, preserveDraft = false } = {}) => {
    if (!current.value) return
    const token = ++metadataSequence, lifecycle = generation
    loading.value = true; error.value = null
    try {
      const result = await io.properties(location())
      if (token !== metadataSequence || lifecycle !== generation) return
      if (!result.ok) { error.value = result.error; return }
      const pending = preserveDraft && Object.keys(changes.value).length ? { ...draft.value } : null
      sync(result.properties)
      if (pending) draft.value = pending
      if (load && !previewOnDemand.value) void loadPreview()
    } catch (e) { if (token === metadataSequence && lifecycle === generation) error.value = { message: e.message || 'Unable to load properties' } }
    finally { if (token === metadataSequence && lifecycle === generation) loading.value = false }
  }
  const open = async (context, rules) => {
    if (!close()) return
    current.value = { node: context.node, providerId: context.filesystemId || context.node.providerId || 'local' }
    editableFiles = rules; permissionError.value = null; size.value = null; sizeState.value = 'idle'; sizeError.value = null
    if (io === filesystem) releaseWatch = directoryWatch.subscribe(current.value.providerId, getFilesystemParentPath(current.value.node.path), () => {
      if (!saving.value) void refresh({ preserveDraft: true })
    })
    await refresh({ load: true })
  }
  const calculate = () => {
    if (!properties.value?.capabilities.calculateSize || sizeState.value === 'calculating') return
    cancelSize(); sizeState.value = 'calculating'; sizeError.value = null; size.value = { bytes: 0, items: 0, errors: 0 }
    const token = generation
    job = io.calculateSize(location(), (event) => {
      if (token !== generation || sizeState.value !== 'calculating') return
      if (event.progress) size.value = event.progress
      if (event.done) { sizeError.value = event.error || null; sizeState.value = event.error ? 'failed' : event.progress?.cancelled ? 'cancelled' : 'done'; job = null }
    })
  }
  const apply = async () => {
    if (!canApply.value) return
    const target = location(), update = { ...changes.value }
    saving.value = true; permissionError.value = null
    try {
      const result = await io.updateProperties(target, update)
      // Refresh both panels and editor trees even if a multi-attribute write was partial.
      const notification = { ok: true, result: { action: 'properties', sourcePath: target.path, targetDirectory: getFilesystemParentPath(target.path) } }
      notifyEntryChange(notification, target.providerId); onChanged()
      if (!result.ok) { permissionError.value = result.error; await refresh(); return }
      sync(result.properties)
    } catch (e) { permissionError.value = { message: e.message || 'Unable to change permissions' } }
    finally { saving.value = false }
  }
  watch(entryChange, (change) => {
    if (current.value && !saving.value && change?.providerId === current.value.providerId && change.sourcePath === current.value.node.path) {
      void refresh({ preserveDraft: true })
    }
  })
  return { current, properties, loading, error, permissionError, saving, draft, values, canApply, invalid, preview, cloudPreviewPending, previewOnDemand,
    size, sizeState, sizeError, open, close, refresh, loadPreview, calculate, cancelSize, apply }
}
