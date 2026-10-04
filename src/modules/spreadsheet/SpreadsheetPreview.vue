<script setup>
import { computed, ref, watch } from 'vue'
import { columnLabel, formatPreviewCell, previewSheetBounds } from './previewGrid.js'

const props = defineProps({ model: { type: Object, required: true } })
const sheetIndex = ref(0)
const firstRow = ref(0)
const firstColumn = ref(0)
const sheet = computed(() => props.model.sheets[sheetIndex.value])
const bounds = computed(() => previewSheetBounds(sheet.value))
const cells = computed(() => new Map(sheet.value.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])))
const rows = computed(() => Array.from({ length: Math.min(100, bounds.value.rows - firstRow.value) }, (_, index) => firstRow.value + index))
const columns = computed(() => Array.from({ length: Math.min(26, bounds.value.columns - firstColumn.value) }, (_, index) => firstColumn.value + index))
watch(sheetIndex, () => { firstRow.value = 0; firstColumn.value = 0 })
</script>

<template>
  <section class="spreadsheet-preview" aria-label="Read-only workbook">
    <div class="d-flex align-items-center gap-2 p-2 flex-wrap">
      <label class="form-label mb-0" for="quick-look-sheet">Sheet</label>
      <select id="quick-look-sheet" v-model.number="sheetIndex" class="form-select form-select-sm w-auto">
        <option v-for="(item, index) in model.sheets" :key="index" :value="index">{{ item.name }}</option>
      </select>
      <button class="compact-icon-button" :disabled="firstRow === 0" aria-label="Previous rows" @click="firstRow = Math.max(0, firstRow - 100)"><i class="mdi mdi-chevron-up" aria-hidden="true" /></button>
      <span>{{ firstRow + 1 }}–{{ firstRow + rows.length }} / {{ bounds.rows }} rows</span>
      <button class="compact-icon-button" :disabled="firstRow + rows.length >= bounds.rows" aria-label="Next rows" @click="firstRow += 100"><i class="mdi mdi-chevron-down" aria-hidden="true" /></button>
      <button class="compact-icon-button" :disabled="firstColumn === 0" aria-label="Previous columns" @click="firstColumn = Math.max(0, firstColumn - 26)"><i class="mdi mdi-chevron-left" aria-hidden="true" /></button>
      <span>{{ columnLabel(firstColumn) }}–{{ columnLabel(firstColumn + columns.length - 1) }}</span>
      <button class="compact-icon-button" :disabled="firstColumn + columns.length >= bounds.columns" aria-label="Next columns" @click="firstColumn += 26"><i class="mdi mdi-chevron-right" aria-hidden="true" /></button>
    </div>
    <div class="spreadsheet-preview-scroll">
      <table class="table table-sm table-bordered mb-0">
        <thead><tr><th aria-label="Row number" /><th v-for="column in columns" :key="column" scope="col">{{ columnLabel(column) }}</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row">
            <th scope="row">{{ row + 1 }}</th>
            <td v-for="column in columns" :key="column">{{ formatPreviewCell(cells.get(`${row}:${column}`), model.date1904) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.spreadsheet-preview { height: 100%; display: flex; flex-direction: column; min-height: 0; font-size: .8rem; }
.spreadsheet-preview-scroll { flex: 1; overflow: auto; user-select: text; }
td { min-width: 7rem; white-space: pre; }
th { background: var(--bs-tertiary-bg); }
</style>
