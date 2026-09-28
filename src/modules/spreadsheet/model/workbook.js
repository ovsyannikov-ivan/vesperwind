// Small transport-independent workbook model. Neither the host workspace nor
// the provider APIs need to understand SheetJS or Univer snapshots.
export const createWorkbookModel = ({ sheets, date1904 = false, warnings = [] }) => ({
  sheets,
  date1904,
  warnings,
})

export const XLS_LIMITS = Object.freeze({ rows: 65536, columns: 256 })

export const validateLegacyWorkbook = (model) => {
  for (const sheet of model.sheets) {
    if (sheet.rowCount > XLS_LIMITS.rows || sheet.columnCount > XLS_LIMITS.columns) {
      throw Object.assign(new Error(`“${sheet.name}” exceeds the XLS limit of 65,536 rows and 256 columns. Save as XLSX instead.`), { code: 'EXLS_LIMIT' })
    }
  }
}
