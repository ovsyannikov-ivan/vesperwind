const languageByExtension = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['vue', 'html'],
  ['json', 'json'],
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['md', 'markdown'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['ini', 'ini'],
  ['conf', 'ini'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['py', 'python'],
  ['php', 'php'],
  ['sql', 'sql'],
])

const languageByFileName = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'plaintext'],
])

export const getEditorLanguage = (fileName) => {
  const normalizedName = String(fileName || '').toLocaleLowerCase()
  const exactLanguage = languageByFileName.get(normalizedName)

  if (exactLanguage) {
    return exactLanguage
  }

  const extension = normalizedName.includes('.')
    ? normalizedName.slice(normalizedName.lastIndexOf('.') + 1)
    : ''

  return languageByExtension.get(extension) || 'plaintext'
}
