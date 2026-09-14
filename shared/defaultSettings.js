export const SETTINGS_VERSION = 4

export const DEFAULT_EDITABLE_FILES = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.vue',
  '.json',
  '.html',
  '.css',
  '.scss',
  '.md',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.conf',
  '.sh',
  '.py',
  '.php',
  '.sql',
  '.env',
]

const THEMES = new Set(['system', 'dark', 'light'])
const LOCALES = new Map([
  ['', ''],
  ['ru-ru', 'ru-RU'],
  ['en-gb', 'en-GB'],
])

const normalizeTheme = (value) =>
  THEMES.has(value) ? value : 'system'

const normalizeLocale = (value) =>
  typeof value === 'string'
    ? LOCALES.get(value.trim().toLocaleLowerCase()) || ''
    : ''

const normalizeHiddenSuffixes = (value) => {
  if (!Array.isArray(value)) {
    return ['.localized']
  }

  const uniqueSuffixes = new Map()

  for (const item of value.slice(0, 100)) {
    if (typeof item !== 'string') {
      continue
    }

    const suffix = item.trim().slice(0, 128)

    if (suffix) {
      uniqueSuffixes.set(suffix.toLocaleLowerCase(), suffix)
    }
  }

  return [...uniqueSuffixes.values()]
}

export const normalizeEditableFiles = (value) => {
  const source = Array.isArray(value) ? value : DEFAULT_EDITABLE_FILES
  const uniqueEntries = new Map()

  for (const item of source.slice(0, 300)) {
    if (typeof item !== 'string') {
      continue
    }

    let entry = item.trim().slice(0, 128)

    if (!entry || entry.includes('/') || entry.includes('\\')) {
      continue
    }

    if (!entry.startsWith('.') && /^[a-z0-9_-]+$/i.test(entry) && entry === entry.toLowerCase()) {
      entry = `.${entry}`
    }

    uniqueEntries.set(entry.toLocaleLowerCase(), entry)
  }

  return [...uniqueEntries.values()]
}

export const createDefaultSettings = () => ({
  version: SETTINGS_VERSION,
  appearance: {
    theme: 'system',
    locale: '',
  },
  filesystem: {
    hiddenNameSuffixes: ['.localized'],
  },
  editor: {
    editableFiles: [...DEFAULT_EDITABLE_FILES],
  },
})

export const normalizeSettings = (value) => ({
  version: SETTINGS_VERSION,
  appearance: {
    theme: normalizeTheme(value?.appearance?.theme),
    locale: normalizeLocale(value?.appearance?.locale),
  },
  filesystem: {
    hiddenNameSuffixes: normalizeHiddenSuffixes(
      value?.filesystem?.hiddenNameSuffixes,
    ),
  },
  editor: {
    editableFiles: normalizeEditableFiles(value?.editor?.editableFiles),
  },
})
