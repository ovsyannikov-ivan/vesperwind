<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
const props = defineProps({ request: Object, busy: Boolean, error: String })
const emit = defineEmits(['submit', 'close'])
const element = ref(null), input = ref(null), value = ref(''), displayed = ref(null)
let modal
const close = () => emit('close')
const shown = () => { if (!props.request) modal?.hide(); else input.value?.focus() }
const hiding = (event) => { if (props.busy) event.preventDefault(); else if (props.request) close() }
const hidden = () => { if (props.request) modal?.show() }
watch(() => props.request, async (request) => {
  if (request) { displayed.value = request; value.value = request.value || ''; await nextTick(); modal?.show() }
  else modal?.hide()
})
onMounted(() => {
  modal = new Modal(element.value)
  element.value.addEventListener('shown.bs.modal', shown)
  element.value.addEventListener('hide.bs.modal', hiding)
  element.value.addEventListener('hidden.bs.modal', hidden)
})
onBeforeUnmount(() => {
  element.value?.removeEventListener('shown.bs.modal', shown)
  element.value?.removeEventListener('hide.bs.modal', hiding)
  element.value?.removeEventListener('hidden.bs.modal', hidden)
  modal?.dispose()
})
</script>
<template>
  <Teleport to="body">
    <div ref="element" class="modal fade" tabindex="-1" aria-labelledby="playlist-command-title" aria-describedby="playlist-command-description" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <form class="modal-content" @submit.prevent="!busy && emit('submit', value)">
          <div class="modal-header">
            <h1 id="playlist-command-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi mdi-playlist-music" aria-hidden="true" />{{ displayed?.title }}</h1>
            <button class="btn-close" type="button" aria-label="Close" @click="close" />
          </div>
          <div class="modal-body">
            <p id="playlist-command-description" class="small text-body-secondary text-break">{{ displayed?.description }}</p>
            <label class="form-label" for="playlist-command-input">{{ displayed?.mode === 'url' ? 'HTTP / HTTPS URL' : 'Filename or path' }}</label>
            <input id="playlist-command-input" ref="input" v-model="value" class="form-control form-control-sm" :disabled="busy" autocomplete="off" :placeholder="displayed?.mode === 'url' ? 'https://example.com/stream.m3u8' : 'playlist.m3u8'">
            <div v-if="error" class="text-danger mt-2" role="alert">{{ error }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-neutral" type="button" @click="close">Cancel</button>
            <button class="btn btn-sm btn-primary" type="submit" :disabled="busy">{{ busy ? 'Preparing…' : displayed?.button }}</button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
