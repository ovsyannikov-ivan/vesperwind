import { getFormattingParser } from './parsers.js'

// Monaco owns its existing model map; the save pipeline only holds an adapter.
let adapter
export const registerSaveFormatter = (format) => {
  adapter = format
  return () => { if (adapter === format) adapter = null }
}
export const prepareTextSave = async (tab, destination, settings) => {
  const fileName = destination?.name || tab.fileName
  if (tab.type !== 'text' || settings.enabled === false || !settings.formatOnSave || !getFormattingParser(fileName)) return null
  if (!adapter) throw Object.assign(new Error('Formatting failed: text editor is not ready'), { code: 'EFORMAT' })
  return adapter(tab, fileName, settings)
}
