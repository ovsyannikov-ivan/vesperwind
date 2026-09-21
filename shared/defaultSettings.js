export const SETTINGS_VERSION = 6

const EDITOR_FORMATS_V6 = [
  '.jsx', '.tsx', '.markdown', '.toml', '.properties', '.rs', '.go', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.swift', '.kt', '.kts',
  '.scala', '.lua', '.pl', '.pm', '.r', '.dart', '.gradle', 'Dockerfile',
  'Makefile', '.gitignore', '.dockerignore', 'nginx.conf', 'httpd.conf',
]

export const DEFAULT_EDITABLE_FILES = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.json',
  '.html',
  '.css',
  '.scss',
  '.md',
  '.markdown',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.conf',
  '.toml',
  '.properties',
  '.sh',
  '.py',
  '.php',
  '.sql',
  '.env',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.swift',
  '.kt',
  '.kts',
  '.scala',
  '.lua',
  '.pl',
  '.pm',
  '.r',
  '.dart',
  '.gradle',
  'Dockerfile',
  'Makefile',
  '.gitignore',
  '.dockerignore',
  'nginx.conf',
  'httpd.conf',
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

const normalizeConnectionProfile = (value) => {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '').trim().slice(0, 80)
  const name = String(value.name || '').trim().slice(0, 120)
  const host = String(value.host || '').trim().slice(0, 255)
  const username = String(value.username || '').trim().slice(0, 128)
  const port = Number.parseInt(value.port, 10)
  const authType = value.authType === 'password' ? 'password' : 'privateKey'
  if (!/^[A-Za-z0-9._-]+$/.test(id) || !name || !host || !username || port < 1 || port > 65535) {
    return null
  }
  return {
    id,
    name,
    host,
    port,
    username,
    authType,
    privateKeyPath: authType === 'privateKey'
      ? String(value.privateKeyPath || '').trim().slice(0, 4096)
      : '',
    initialPath: String(value.initialPath || '').trim().slice(0, 4096),
    trustedFingerprint: /^SHA256:[A-Za-z0-9+/=]+$/.test(value.trustedFingerprint || '')
      ? value.trustedFingerprint
      : '',
  }
}

export const normalizeConnectionProfiles = (value) => {
  if (!Array.isArray(value)) return []
  const profiles = new Map()
  for (const item of value.slice(0, 100)) {
    const profile = normalizeConnectionProfile(item)
    if (profile) profiles.set(profile.id, profile)
  }
  return [...profiles.values()]
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
  connections: [],
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
    editableFiles: normalizeEditableFiles(
      Number.isFinite(value?.version) && value.version < 6
        ? Array.isArray(value?.editor?.editableFiles)
          ? [...value.editor.editableFiles, ...EDITOR_FORMATS_V6]
          : undefined
        : value?.editor?.editableFiles,
    ),
  },
  connections: normalizeConnectionProfiles(value?.connections),
})
