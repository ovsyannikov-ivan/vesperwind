const extensions = {
  js: 'babel', mjs: 'babel', cjs: 'babel', jsx: 'babel', ts: 'typescript', tsx: 'typescript',
  vue: 'vue', json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml',
}
export const FORMATTING_LANGUAGES = ['javascript', 'typescript', 'vue', 'json', 'html', 'css', 'scss', 'markdown', 'yaml']
export const getFormattingParser = (fileName) => extensions[String(fileName).split('.').at(-1).toLowerCase()] || null
