import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getFileOpenType } from '../src/utils/fileTypes.js'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'
import { parseWorkbook, serializeWorkbook } from '../src/modules/spreadsheet/adapters/sheetjs.js'
import { modelToUniver, univerToModel } from '../src/modules/spreadsheet/adapters/univer.js'
import { validateLegacyWorkbook } from '../src/modules/spreadsheet/model/workbook.js'
import { attachSpreadsheetRuntime, getSpreadsheetRuntime, spreadsheetRuntimeCount } from '../src/modules/spreadsheet/runtime.js'

const fixture = async (name) => new Uint8Array(await fs.readFile(new URL(`./fixtures/spreadsheet/${name}`, import.meta.url)))
const cell = (model, sheet, row, column) => model.sheets[sheet].cells.find((item) => item.row === row && item.column === column)
const roundTrip = (model, format = 'xlsx') => parseWorkbook(serializeWorkbook(univerToModel(modelToUniver(model, 'Test')), format))

test('XLSX/XLS document detection uses the spreadsheet handler while Monaco and PDF stay registered', () => {
  assert.equal(getFileOpenType('report.xlsx'), 'spreadsheet')
  assert.equal(getFileOpenType('report.xls'), 'spreadsheet')
  assert.equal(getFileOpenType('note.txt', ['.txt']), 'text')
  assert.equal(getFileOpenType('manual.pdf'), 'pdf')
  assert.equal(getDocumentHandler('spreadsheet').icon, 'mdi-file-excel-outline')
})

test('parses the project XLSX and BIFF8 XLS fixtures with values and types', async () => {
  const modern = parseWorkbook(await fixture('simple.xlsx'))
  const legacy = parseWorkbook(await fixture('legacy.xls'))
  assert.equal(cell(modern, 0, 1, 1).value, 12)
  assert.equal(cell(modern, 0, 1, 1).type, 'n')
  assert.equal(cell(legacy, 0, 1, 1).value, 7)
  assert.equal(legacy.sheets[0].name, 'Old')
})

test('preserves multiple sheets, formulas and cached results across both adapters and XLSX serialization', async () => {
  const multi = roundTrip(parseWorkbook(await fixture('multisheet.xlsx')))
  assert.deepEqual(multi.sheets.map((sheet) => sheet.name), ['North', 'South'])
  const formulas = roundTrip(parseWorkbook(await fixture('formulas.xlsx')))
  assert.equal(cell(formulas, 0, 0, 2).formula, 'SUM(A1:B1)')
  assert.equal(cell(formulas, 0, 0, 2).value, 5)
})

test('preserves Russian sheet names, Unicode cells, merges, dimensions and number formats', async () => {
  const unicode = roundTrip(parseWorkbook(await fixture('unicode.xlsx')))
  assert.equal(unicode.sheets[0].name, 'Отчёт')
  assert.equal(cell(unicode, 0, 1, 0).value, 'Кофе ☕')
  assert.equal(cell(unicode, 0, 2, 0).value, '東京')
  const format = roundTrip(parseWorkbook(await fixture('formatting.xlsx')))
  assert.equal(format.sheets[0].merges.length, 1)
  assert.equal(format.sheets[0].rows[0].height, 34)
  assert.equal(format.sheets[0].columns[0].width, 140)
  assert.equal(cell(format, 0, 0, 0).style.numberFormat, '0.00%')
})

test('serializes simple BIFF8 without silently changing its format and rejects XLS size overflow', async () => {
  const bytes = serializeWorkbook(parseWorkbook(await fixture('legacy.xls')), 'xls')
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'ÐÏ\u0011à')
  assert.equal(parseWorkbook(bytes).sheets[0].name, 'Old')
  assert.throws(() => validateLegacyWorkbook({ sheets: [{ name: 'Too large', rowCount: 65537, columnCount: 2 }] }), /XLS limit/)
})

test('two workbook snapshots get distinct IDs without secure-context Web Crypto', async () => {
  const model = parseWorkbook(await fixture('simple.xlsx'))
  assert.notEqual(modelToUniver(model).id, modelToUniver(model).id)
})

test('two live spreadsheet editors keep independent runtime snapshots and release one at a time', () => {
  const disposeA = attachSpreadsheetRuntime('A', { snapshot: () => 'A' })
  const disposeB = attachSpreadsheetRuntime('B', { snapshot: () => 'B' })
  assert.equal(getSpreadsheetRuntime('A').snapshot(), 'A')
  assert.equal(getSpreadsheetRuntime('B').snapshot(), 'B')
  assert.equal(spreadsheetRuntimeCount(), 2)
  disposeA()
  assert.equal(getSpreadsheetRuntime('B').snapshot(), 'B')
  disposeB()
  assert.equal(spreadsheetRuntimeCount(), 0)
})

test('local and SFTP documents use the same binary file reference and successful save clears dirty', async () => {
  const { loadSpreadsheet, saveSpreadsheet } = await import('../src/modules/spreadsheet/services/spreadsheetFile.js')
  const bytes = await fixture('simple.xlsx')
  for (const filesystemId of ['local', 'sftp:fixture']) {
    const tab = { id: filesystemId, filesystemId, filePath: '/Отчёты/report.xlsx', fileName: 'report.xlsx', revision: 1, dirty: true }
    const calls = []
    const io = {
      readBinary: async (ref) => { calls.push(['read', ref]); return { ok: true, bytes, modifiedAt: 'initial' } },
      writeBinary: async (ref, output) => { calls.push(['write', ref]); assert.ok(output.length > 0); return { ok: true, modifiedAt: 'saved' } },
    }
    assert.equal((await loadSpreadsheet(tab, {}, io)).ok, true)
    const snapshot = modelToUniver(tab.model)
    snapshot.sheets[snapshot.sheetOrder[0]].cellData[1][1].v = 99
    const dispose = attachSpreadsheetRuntime(tab.id, { snapshot: () => snapshot, finishEditing: async () => true })
    assert.equal((await saveSpreadsheet(tab, io)).ok, true)
    assert.equal(tab.dirty, false)
    assert.equal(tab.modifiedAt, 'saved')
    assert.deepEqual(calls.map(([, ref]) => ref), [{ providerId: filesystemId, path: tab.filePath }, { providerId: filesystemId, path: tab.filePath }])
    dispose()
  }
})

test('failed spreadsheet save and edits during an in-flight save retain dirty state', async () => {
  const { saveSpreadsheet } = await import('../src/modules/spreadsheet/services/spreadsheetFile.js')
  const model = parseWorkbook(await fixture('simple.xlsx'))
  const tab = { id: 'failure', filesystemId: 'local', filePath: '/report.xlsx', fileName: 'report.xlsx', revision: 1, dirty: true }
  const dispose = attachSpreadsheetRuntime(tab.id, { snapshot: () => modelToUniver(model), finishEditing: async () => true })
  assert.equal((await saveSpreadsheet(tab, { writeBinary: async () => ({ ok: false, error: { message: 'disk full' } }) })).ok, false)
  assert.equal(tab.dirty, true)
  assert.equal((await saveSpreadsheet(tab, { writeBinary: async () => { tab.revision++; return { ok: true } } })).ok, true)
  assert.equal(tab.dirty, true)
  dispose()
})
