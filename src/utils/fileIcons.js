const iconMap = {
  js: ['mdi-language-javascript', 'icon-javascript'],
  mjs: ['mdi-language-javascript', 'icon-javascript'],
  cjs: ['mdi-language-javascript', 'icon-javascript'],
  ts: ['mdi-language-typescript', 'icon-typescript'],
  tsx: ['mdi-language-typescript', 'icon-typescript'],
  vue: ['mdi-vuejs', 'icon-vue'],
  json: ['mdi-code-json', 'icon-json'],
  html: ['mdi-language-html5', 'icon-html'],
  htm: ['mdi-language-html5', 'icon-html'],
  css: ['mdi-language-css3', 'icon-css'],
  scss: ['mdi-sass', 'icon-sass'],
  sass: ['mdi-sass', 'icon-sass'],
  md: ['mdi-language-markdown-outline', 'icon-markdown'],
  markdown: ['mdi-language-markdown-outline', 'icon-markdown'],
  env: ['mdi-tune-variant', 'icon-config'],
  yaml: ['mdi-code-braces', 'icon-config'],
  yml: ['mdi-code-braces', 'icon-config'],
  zip: ['mdi-folder-zip-outline', 'icon-archive'],
  gz: ['mdi-folder-zip-outline', 'icon-archive'],
  tar: ['mdi-folder-zip-outline', 'icon-archive'],
  png: ['mdi-file-image-outline', 'icon-image'],
  jpg: ['mdi-file-image-outline', 'icon-image'],
  jpeg: ['mdi-file-image-outline', 'icon-image'],
  gif: ['mdi-file-image-outline', 'icon-image'],
  webp: ['mdi-file-image-outline', 'icon-image'],
  svg: ['mdi-svg', 'icon-image'],
  pdf: ['mdi-file-pdf-box', 'icon-pdf'],
}

const getExtension = (filename) => {
  if (filename.startsWith('.env')) {
    return 'env'
  }

  const segments = filename.toLowerCase().split('.')
  return segments.length > 1 ? segments.at(-1) : ''
}

export const getFileIcon = (node, expanded = false) => {
  if (node.isDirectory) {
    return {
      icon: expanded ? 'mdi-folder-open' : 'mdi-folder',
      className: 'icon-folder',
    }
  }

  if (node.isSymbolicLink) {
    return { icon: 'mdi-file-link-outline', className: 'icon-link' }
  }

  const [icon, className] = iconMap[getExtension(node.name)] || [
    'mdi-file-outline',
    'icon-file',
  ]

  return { icon, className }
}
