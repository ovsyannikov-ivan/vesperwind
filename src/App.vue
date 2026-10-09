<script setup>
import FileManager from './components/FileManager.vue'
import PermissionSetupModal from './components/PermissionSetupModal.vue'
import { usePermissionSetup } from './composables/usePermissionSetup.js'
const permissionSetup = usePermissionSetup()
void permissionSetup.initialize()
</script>

<template>
  <FileManager v-if="permissionSetup.ready.value" />
  <div v-else class="h-100 d-flex align-items-center justify-content-center text-body-secondary small" role="status">Preparing Vesperwind…</div>
  <PermissionSetupModal :open="permissionSetup.open.value" />
</template>
