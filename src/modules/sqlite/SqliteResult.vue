<script setup>
defineProps({ result: Object })
const display = cell => cell.type === 'null' ? 'NULL' : cell.type === 'blob' ? `x'${cell.value}${cell.truncated ? '…' : ''}' (${cell.bytes} bytes)` : `${cell.value}${cell.truncated ? '…' : ''}`
</script>
<template>
  <div class="sqlite-result-scroll">
    <table v-if="result?.columns.length" class="table table-sm sqlite-table mb-0">
      <thead><tr><th v-for="(column, index) in result.columns" :key="index" scope="col"><span class="selectable-text">{{ column }}</span></th></tr></thead>
      <tbody><tr v-for="(row, index) in result.rows" :key="index"><td v-for="(cell, column) in row" :key="column" :class="{ 'text-body-secondary': cell.type === 'null' }"><span class="selectable-text">{{ display(cell) }}</span></td></tr></tbody>
    </table>
    <p v-else class="m-3">Statement completed. {{ result?.changes || 0 }} row changes.</p>
    <p v-if="result?.columns.length && !result.rows.length" class="m-3">No rows.</p>
  </div>
</template>
