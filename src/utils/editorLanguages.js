const languageByExtension = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['vue', 'vue'],
  ['json', 'json'],
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['conf', 'ini'],
  ['properties', 'ini'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['py', 'python'],
  ['php', 'php'],
  ['sql', 'sql'],
  ['rs', 'rust'],
  ['go', 'go'],
  ['java', 'java'],
  ['c', 'cpp'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['h', 'cpp'],
  ['hh', 'cpp'],
  ['hpp', 'cpp'],
  ['hxx', 'cpp'],
  ['cs', 'csharp'],
  ['rb', 'ruby'],
  ['swift', 'swift'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['scala', 'scala'],
  ['lua', 'lua'],
  ['pl', 'perl'],
  ['pm', 'perl'],
  ['r', 'r'],
  ['dart', 'dart'],
  ['gradle', 'groovy'],
])

const languageByFileName = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
  ['.env', 'ini'],
  ['.gitignore', 'ignore'],
  ['.dockerignore', 'ignore'],
  ['.npmignore', 'ignore'],
  ['nginx.conf', 'nginx'],
  ['httpd.conf', 'apache'],
  ['apache2.conf', 'apache'],
])

const languageByPattern = [
  [/^dockerfile(?:\..+)?$/u, 'dockerfile'],
  [/^\.env(?:\..+)?$/u, 'ini'],
  [/(?:^|\.)nginx\.conf$/u, 'nginx'],
]

export const getEditorLanguage = (fileName) => {
  const normalizedName = String(fileName || '').toLocaleLowerCase()
  const exactLanguage = languageByFileName.get(normalizedName)

  if (exactLanguage) {
    return exactLanguage
  }

  for (const [pattern, language] of languageByPattern) {
    if (pattern.test(normalizedName)) {
      return language
    }
  }

  const extension = normalizedName.includes('.')
    ? normalizedName.slice(normalizedName.lastIndexOf('.') + 1)
    : ''

  return languageByExtension.get(extension) || 'plaintext'
}
