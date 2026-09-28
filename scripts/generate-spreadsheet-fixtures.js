import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const directory = new URL('../test/fixtures/spreadsheet/', import.meta.url)
fs.mkdirSync(directory, { recursive: true })
const save = (name, workbook, format = 'xlsx') => {
  fs.writeFileSync(new URL(name, directory), XLSX.write(workbook, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' }))
}
const make = (sheets) => {
  const book = XLSX.utils.book_new()
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name)
  return book
}
save('simple.xlsx', make([['Data', [['Item', 'Count'], ['Pens', 12], ['Books', 4]]]]))
save('multisheet.xlsx', make([['North', [['Region', 'Sales'], ['North', 10]]], ['South', [['Region', 'Sales'], ['South', 20]]]]))
const formulas = make([['Calc', [[2, 3, null]]]])
formulas.Sheets.Calc.C1 = { t: 'n', f: 'SUM(A1:B1)', v: 5 }
formulas.Sheets.Calc['!ref'] = 'A1:C1'
save('formulas.xlsx', formulas)
const formatting = make([['Style', [[0.25, 'Merged'], ['Second', null]]]])
formatting.Sheets.Style.A1.z = '0.00%'
formatting.Sheets.Style['!merges'] = [XLSX.utils.decode_range('B1:C1')]
formatting.Sheets.Style['!cols'] = [{ wpx: 140 }, { wpx: 110 }]
formatting.Sheets.Style['!rows'] = [{ hpx: 34 }]
formatting.Sheets.Style['!ref'] = 'A1:C2'
save('formatting.xlsx', formatting)
save('unicode.xlsx', make([['Отчёт', [['Название', 'Сумма'], ['Кофе ☕', 42], ['東京', true]]]]))
save('legacy.xls', make([['Old', [['Legacy', 'XLS'], ['Число', 7]]]]), 'xls')
