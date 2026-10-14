<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { sqlite } from '../../api/sqlite.js'
import { quoteSqliteIdentifier } from '../../../shared/sqlitePolicy.js'
import SqlQueryEditor from './SqlQueryEditor.vue'
import SqliteResult from './SqliteResult.vue'
const props = defineProps({ tab: Object, visible: Boolean })
const section = ref('data')
const selected = ref(props.tab.objects[0]?.name || '')
const offset = ref(0)
const pageOffsets = ref([])
const result = ref(null)
const structure = ref(null)
const results = ref([])
const resultIndex = ref(0)
const query = ref(selected.value ? `SELECT * FROM ${quoteSqliteIdentifier(selected.value)} LIMIT 100;` : 'SELECT sqlite_version();')
const queryEditor = ref(null)
const busy = ref(false)
const error = ref('')
const elapsed = ref(null)
const closed = ref(false)
let controller = null, disposed = false
const currentResult = computed(() => results.value[resultIndex.value])
async function perform(action, payload = {}) {
  if (busy.value || closed.value || disposed) return null
  busy.value = true; error.value = ''; controller = new AbortController()
  try {
    const response = await sqlite.run(props.tab.sessionId, action, payload, { signal: controller.signal })
    if (disposed) return null
    props.tab.inTransaction = response.inTransaction ?? props.tab.inTransaction
    if (!response.ok) {
      error.value = response.error.message
      if (['ECANCELLED','ESQLITE_CLOSED','ETIMEDOUT'].includes(response.error.code)) { closed.value = true; props.tab.inTransaction = false }
      return null
    }
    return response
  } finally { busy.value = false; controller = null }
}
const refreshSchema = async () => {
  const response = await perform('schema')
  if (response) {
    props.tab.objects = response.objects
    if (!response.objects.some(o => o.name === selected.value)) { selected.value = response.objects[0]?.name || ''; offset.value = 0; pageOffsets.value = []; result.value = null; structure.value = null }
  }
}
const load = async () => {
  if (!selected.value || section.value === 'sql') return
  if (section.value === 'data') { const response = await perform('data', { table: selected.value, offset: offset.value }); if (response) result.value = response.results[0] }
  else { const response = await perform('structure', { table: selected.value }); if (response) structure.value = response }
}
const choose = async name => { if (busy.value) return; selected.value = name; offset.value = 0; pageOffsets.value = []; result.value = null; structure.value = null; await load() }
const switchSection = async value => { section.value = value; await load() }
const page = async delta => {
  if (delta > 0) { pageOffsets.value.push(offset.value); offset.value += result.value.rows.length }
  else offset.value = pageOffsets.value.pop() || 0
  await load()
}
const run = async text => {
  const response = await perform('query', { sql: typeof text === 'string' ? text : queryEditor.value?.getQuery() || query.value })
  if (response) { results.value = response.results; resultIndex.value = 0; elapsed.value = response.elapsedMs }
  // A failed script can still have committed earlier statements or changed schema.
  const queryError = error.value
  if (!closed.value && !disposed) await refreshSchema()
  if (queryError) error.value = queryError
}
const refresh = async () => { await refreshSchema(); await load() }
const reopen = async () => {
  busy.value = true; error.value = ''; controller = new AbortController()
  try {
    const response = await sqlite.open({ providerId: props.tab.filesystemId, path: props.tab.filePath }, { signal: controller.signal })
    if (disposed) { if (response.ok) void sqlite.close(response.sessionId); return }
    if (response.ok) { Object.assign(props.tab, { sessionId: response.sessionId, objects: response.objects, inTransaction: false }); closed.value = false }
    else error.value = response.error.message
  } finally { busy.value = false; controller = null }
  if (!closed.value) await refresh()
}
const stop = () => controller?.abort()
void load()
onBeforeUnmount(() => { disposed = true; controller?.abort() })
</script>
<template>
  <div class="sqlite-workspace">
    <aside class="sqlite-objects" aria-label="Database tables and views">
      <div class="sqlite-toolbar"><span>Tables and views</span><button class="compact-icon-button" title="Refresh database" aria-label="Refresh database" :disabled="busy || closed" @click="refresh"><i class="mdi mdi-refresh" aria-hidden="true" /></button></div>
      <div class="sqlite-object-list">
        <button v-for="object in tab.objects" :key="object.name" class="sqlite-object" :class="{ 'is-selected': object.name === selected }" :disabled="busy || closed" :title="object.name" @click="choose(object.name)"><i class="mdi" :class="object.type === 'view' ? 'mdi-table-eye' : 'mdi-table'" aria-hidden="true" /><span>{{ object.name }}</span></button>
        <p v-if="!tab.objects.length" class="p-2">No tables or views.</p>
      </div>
    </aside>
    <section class="sqlite-main">
      <div class="sqlite-toolbar">
        <div class="d-flex gap-1" role="tablist" aria-label="Database sections"><button v-for="item in ['data','structure','sql']" :key="item" class="compact-button" :class="{ 'is-active': section === item }" role="tab" :aria-selected="section === item" :disabled="busy" @click="switchSection(item)">{{ item === 'sql' ? 'SQL' : item === 'data' ? 'Data' : 'Structure' }}</button></div>
        <span v-if="tab.inTransaction" class="ms-auto">Transaction open</span>
        <button v-if="tab.inTransaction" class="compact-button" :disabled="busy" @click="perform('query', { sql: 'COMMIT' })">Commit</button>
        <button v-if="tab.inTransaction" class="compact-button" :disabled="busy" @click="perform('query', { sql: 'ROLLBACK' }).then(refresh)">Rollback</button>
        <button v-if="busy" class="compact-button ms-auto" @click="stop">Stop</button>
      </div>
      <div v-if="error" class="sqlite-error selectable-text" role="alert">{{ error }} <button v-if="closed" class="btn btn-sm btn-neutral ms-2" :disabled="busy" @click="reopen">Reopen database</button></div>
      <template v-if="section === 'data'">
        <div class="sqlite-toolbar"><span class="text-truncate">{{ selected || 'Choose a table' }}</span><span v-if="result" class="ms-auto">{{ result.rows.length ? offset + 1 : 0 }}–{{ offset + (result?.rows.length || 0) }}</span><button class="compact-button" :disabled="busy || closed || !offset" @click="page(-1)">Previous</button><button class="compact-button" :disabled="busy || closed || !result?.hasMore" @click="page(1)">Next</button></div>
        <SqliteResult v-if="result" :result="result" />
      </template>
      <div v-else-if="section === 'structure' && structure" class="sqlite-structure">
        <table class="table table-sm sqlite-table"><thead><tr><th>Column</th><th>Type</th><th>Not null</th><th>Default</th><th>Primary key</th></tr></thead><tbody><tr v-for="column in structure.columns" :key="column.cid"><td class="selectable-text">{{ column.name }}</td><td class="selectable-text">{{ column.type }}</td><td>{{ column.notnull ? 'Yes' : '' }}</td><td class="selectable-text">{{ column.dflt_value }}</td><td>{{ column.pk || '' }}</td></tr></tbody></table>
        <h2 class="fs-6">Definition</h2><pre class="selectable-text">{{ structure.object.sql }}</pre>
        <h2 v-if="structure.indexes.length" class="fs-6">Indexes</h2><div v-for="index in structure.indexes" :key="index.name"><p class="selectable-text mb-1">{{ index.name }}</p><pre class="selectable-text">{{ index.sql || 'Automatic index' }}</pre></div>
        <h2 v-if="structure.foreignKeys.length" class="fs-6">Foreign keys</h2><p v-for="key in structure.foreignKeys" :key="`${key.id}:${key.seq}`" class="selectable-text">{{ key.from }} → {{ key.table }}.{{ key.to }} · ON DELETE {{ key.on_delete }} · ON UPDATE {{ key.on_update }}</p>
      </div>
      <div v-show="section === 'sql'" class="sqlite-sql">
        <SqlQueryEditor ref="queryEditor" v-model="query" :visible="visible && section === 'sql'" @run="run" />
        <div class="sqlite-toolbar"><button class="compact-button" :disabled="busy || closed || !query.trim()" title="Run selection or script (Cmd/Ctrl+Enter)" @click="run"><i class="mdi mdi-play" aria-hidden="true" />Run SQL</button><span>Cmd/Ctrl+Enter · selection or script</span><span v-if="elapsed !== null" class="ms-auto">{{ elapsed }} ms</span></div>
        <div v-if="results.length" class="sqlite-toolbar"><select v-if="results.length > 1" v-model="resultIndex" class="form-select form-select-sm w-auto" aria-label="Statement result"><option v-for="(_, index) in results" :key="index" :value="index">Statement {{ index + 1 }}</option></select><span>{{ currentResult?.rows.length || 0 }} rows · {{ currentResult?.changes || 0 }} row changes<span v-if="currentResult?.truncated"> · Preview limited to 500 rows / 4 MiB</span></span></div>
        <SqliteResult v-if="currentResult" :result="currentResult" />
      </div>
    </section>
  </div>
</template>
<style lang="scss">
.sqlite-workspace {
  display: flex; flex: 1; min-height: 0; overflow: hidden; background: var(--bs-body-bg);
  .sqlite-objects { width: 200px; min-width: 120px; display: flex; flex-direction: column; border-right: 1px solid var(--bs-border-color); }
  .sqlite-object-list { overflow: auto; flex: 1; }
  .sqlite-object { display: flex; align-items: center; gap: .5rem; width: 100%; padding: .25rem .5rem; border: 0; background: transparent; color: var(--bs-body-color); text-align: left;
    span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    &:hover { background: var(--bs-tertiary-bg); }
    &.is-selected { background: var(--bs-primary); color: white; }
  }
  .sqlite-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .sqlite-toolbar { display: flex; align-items: center; gap: .5rem; padding: .25rem .5rem; border-bottom: 1px solid var(--bs-border-color); flex-shrink: 0; font-size: .8125rem; min-height: 32px;
    .compact-button.is-active { background: var(--bs-primary); color: white; }
  }
  .sqlite-error { padding: .5rem; color: var(--bs-danger); border-bottom: 1px solid var(--bs-border-color); }
  .sqlite-result-scroll { flex: 1; min-height: 0; overflow: auto; }
  .sqlite-table { font-size: .8125rem; width: max-content; min-width: 100%;
    th { position: sticky; top: 0; background: var(--bs-tertiary-bg); z-index: 1; }
    td { max-width: 420px; white-space: pre-wrap; overflow-wrap: anywhere; }
  }
  .sqlite-structure { overflow: auto; padding: .75rem; }
  .sqlite-sql { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .sqlite-query-editor { height: 200px; min-height: 100px; flex: 0 0 200px; }
}
</style>
