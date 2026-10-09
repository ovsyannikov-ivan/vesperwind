import { EDITOR_THEMES as editorThemes } from './editorThemeCatalog.js'
import { DEFAULT_FORMATTING, normalizeFormatting } from './editorFormatting.js'

export const SETTINGS_VERSION = 9
const editorThemeIds = new Set(editorThemes.map(({ id }) => id))
export const normalizeEditorTheme = (id) => editorThemeIds.has(id) ? id : 'auto'

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
  '.htm',
  '.css',
  '.scss',
  '.less',
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

// Connection profiles. The Rust backend (src-tauri/src/settings/mod.rs)
// implements the same rules; test/fixtures/settings/connection-profiles.json
// is the shared parity contract. Profiles never contain secrets.
export const CONNECTION_PROTOCOLS = Object.freeze(['sftp', 'ftp', 'ftps'])
const SFTP_AUTH_TYPES = ['auto', 'agent', 'password', 'privateKey']
const FTP_AUTH_TYPES = ['password', 'anonymous']
const FTP_TLS_MODES = ['explicit', 'implicit']
const PROFILE_ID = /^[A-Za-z0-9._-]{1,80}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

// Ports are suggested only when a profile is created; normalization never
// replaces a port the profile already has.
export const defaultConnectionPort = (protocol, ftpTls = 'explicit') =>
  protocol === 'sftp' ? 22 : protocol === 'ftps' && ftpTls === 'implicit' ? 990 : 21
export const defaultConnectionAuthType = (protocol) => protocol === 'sftp' ? 'auto' : 'password'
export const isSftpProfile = (profile) => profile?.protocol === 'sftp'

// Trimmed string within a code point limit and without control characters.
const boundedText = (value, limit) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return [...text].length <= limit && !CONTROL_CHARACTER.test(text) ? text : null
}
const optionalText = (value, limit) => boundedText(value, limit) ?? ''
const normalizePort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null
// SHA-256 of the DER certificate as 64 lowercase hex digits; colons allowed on input.
export const normalizeCertificatePin = (value) => {
  if (typeof value !== 'string') return ''
  const pin = value.replaceAll(':', '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(pin) ? pin : ''
}

// Settings written by a newer Vesperwind are never normalized or rewritten.
export const SETTINGS_NEWER_VERSION_ERROR = Object.freeze({
  code: 'ESETTINGS_NEWER_VERSION',
  message: 'These settings were saved by a newer version of Vesperwind. Update Vesperwind to use them; the settings file was not changed.',
})
export const isNewerSettingsVersion = (value) =>
  Number.isInteger(value?.version) && value.version > SETTINGS_VERSION

// Key names that may hold a secret are never kept, even in a preserved profile.
const SECRET_KEY = /pass|secret|token|credential/i
const SECRET_KEYS = new Set(['key', 'privatekey', 'keycontents', 'apikey'])

// A profile of a protocol this build does not know (a manual edit, or a future
// protocol) is kept as it is instead of disappearing on the next save, when it
// is small and flat. It is never listed, connected or matched with credentials.
const preservedProfile = (value, id) => {
  const protocol = value.protocol
  if (typeof protocol !== 'string' || !protocol || [...protocol].length > 32 || CONTROL_CHARACTER.test(protocol)) return null
  const entries = Object.entries(value)
  if (entries.length > 64) return null
  const profile = {}
  for (const [key, item] of entries) {
    if (key.length > 64 || !(item === null || typeof item === 'boolean' || Number.isSafeInteger(item)
      || (typeof item === 'string' && [...item].length <= 4096))) return null
    // Booleans are flags (for example savePassword); other values under a
    // secret-like name are dropped.
    if (typeof item === 'boolean' || (!SECRET_KEY.test(key) && !SECRET_KEYS.has(key.toLowerCase()))) profile[key] = item
  }
  return { ...profile, id }
}

const normalizeConnectionProfile = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  // A missing protocol is a legacy SFTP profile; an unknown one is never SFTP.
  const protocol = value.protocol === undefined || value.protocol === null ? 'sftp' : value.protocol
  if (!PROFILE_ID.test(id)) return null
  if (!CONNECTION_PROTOCOLS.includes(protocol)) return preservedProfile(value, id)
  const name = typeof value.name === 'string' ? [...value.name.trim()].slice(0, 120).join('') : ''
  const host = boundedText(value.host, 255)
  const port = normalizePort(value.port)
  let username = boundedText(value.username, 128)
  if (!name || !host || port === null || username === null) return null
  if (protocol === 'sftp') {
    if (!username) return null
    const authType = SFTP_AUTH_TYPES.includes(value.authType) ? value.authType : 'privateKey'
    const trustedFingerprint = typeof value.trustedFingerprint === 'string'
      && value.trustedFingerprint.length <= 100 && /^SHA256:[A-Za-z0-9+/=]+$/.test(value.trustedFingerprint)
      ? value.trustedFingerprint : ''
    return {
      id,
      name,
      host,
      port,
      username,
      authType,
      protocol,
      savePassword: ['auto', 'password'].includes(authType) && value.savePassword === true,
      saveKeyPassphrase: ['auto', 'privateKey'].includes(authType) && value.saveKeyPassphrase === true,
      sshConfigHost: optionalText(value.sshConfigHost, 255),
      privateKeyPath: ['auto', 'privateKey'].includes(authType) ? optionalText(value.privateKeyPath, 4096) : '',
      initialPath: optionalText(value.initialPath, 4096),
      trustedFingerprint,
    }
  }
  const authType = FTP_AUTH_TYPES.includes(value.authType) ? value.authType : 'password'
  if (!username && authType === 'anonymous') username = 'anonymous'
  if (!username) return null
  const profile = {
    id,
    name,
    host,
    port,
    username,
    authType,
    protocol,
    savePassword: authType === 'password' && value.savePassword === true,
    initialPath: optionalText(value.initialPath, 4096),
    ftpDataMode: 'passive',
    ftpEncoding: 'utf-8',
  }
  if (protocol === 'ftps') {
    profile.ftpTls = FTP_TLS_MODES.includes(value.ftpTls) ? value.ftpTls : 'explicit'
    profile.tlsTrustedCertificate = normalizeCertificatePin(value.tlsTrustedCertificate)
  } else {
    profile.plaintextAcknowledged = value.plaintextAcknowledged === true
  }
  return profile
}

export const normalizeConnectionProfiles = (value) => {
  if (!Array.isArray(value)) return []
  const profiles = new Map()
  for (const item of value.slice(0, 100)) {
    const profile = normalizeConnectionProfile(item)
    // The first profile with an id wins, so credential identities stay unique.
    if (profile && !profiles.has(profile.id)) profiles.set(profile.id, profile)
  }
  return [...profiles.values()]
}

// Trust belongs to an endpoint. When a saved FTP/FTPS profile moves to another
// protocol, host, port or TLS mode, its plaintext acknowledgement and
// certificate pin are cleared; they must be confirmed again for the new one.
export const resetChangedConnectionTrust = (previous, next) => {
  const before = new Map((Array.isArray(previous) ? previous : []).map(profile => [profile.id, profile]))
  return next.map((profile) => {
    const old = before.get(profile.id)
    if (!old || !['ftp', 'ftps'].includes(profile.protocol)) return profile
    const endpointChanged = old.protocol !== profile.protocol || old.host !== profile.host || old.port !== profile.port
    if (profile.protocol === 'ftp' && endpointChanged && profile.plaintextAcknowledged) {
      return { ...profile, plaintextAcknowledged: false }
    }
    if (profile.protocol === 'ftps' && (endpointChanged || old.ftpTls !== profile.ftpTls) && profile.tlsTrustedCertificate) {
      return { ...profile, tlsTrustedCertificate: '' }
    }
    return profile
  })
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
    theme: 'auto',
    formatting: { ...DEFAULT_FORMATTING },
    editableFiles: [...DEFAULT_EDITABLE_FILES],
  },
  connections: [],
  permissions: { setupCompleted: false },
})

const normalizeConfiguredEditableFiles = (value) => {
  const files = normalizeEditableFiles(
    Number.isFinite(value?.version) && value.version < 6
      ? Array.isArray(value?.editor?.editableFiles)
        ? [...value.editor.editableFiles, ...EDITOR_FORMATS_V6] : undefined
      : value?.editor?.editableFiles,
  )
  const previousDefaults = DEFAULT_EDITABLE_FILES.filter(item => !['.htm', '.less'].includes(item))
  if (files.length === previousDefaults.length && previousDefaults.every(item =>
    files.some(file => file.toLowerCase() === item.toLowerCase()))) return [...DEFAULT_EDITABLE_FILES]
  return files
}

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
    theme: normalizeEditorTheme(value?.editor?.theme),
    formatting: normalizeFormatting(value?.editor?.formatting),
    editableFiles: normalizeConfiguredEditableFiles(value),
  },
  connections: normalizeConnectionProfiles(value?.connections),
  permissions: { setupCompleted: value?.permissions?.setupCompleted === true },
})
