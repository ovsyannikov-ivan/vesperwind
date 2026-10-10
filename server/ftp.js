// FTP and FTPS (explicit and implicit TLS) for the Node/SEA runtime, built on
// basic-ftp. The native backend (src-tauri/src/ftp) is the reference: the same
// provider ids, error codes, certificate details and safety rules apply.
//
// TLS: without a pin, Node verifies the chain against the bundled and system
// roots plus the host name (`rejectUnauthorized` stays true). With a pin (the
// profile's `tlsTrustedCertificate`), exactly that certificate is accepted and
// chain, name and validity are not checked, like the native verifier; then
// every TLS socket (control and data) is checked against the pin before it is
// used. Credentials are sent only after the control connection is verified and
// the data channel is protected (PBSZ 0, PROT P). Nothing falls back to FTP.
//
// Passwords live only in memory for the life of a connection (there is no
// secure credential store in this runtime) and never reach logs or events.
import crypto, { X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import posix from 'node:path/posix'
import { PassThrough, Writable } from 'node:stream'
import tls from 'node:tls'
import { Client, FTPError } from 'basic-ftp'
import unixListing from 'basic-ftp/dist/parseListUnix.js'
import dosListing from 'basic-ftp/dist/parseListDOS.js'
import { decodeTextPreview } from '../shared/textPreview.js'
import { normalizeCertificatePin } from '../shared/defaultSettings.js'
import { unsafeEntryName } from '../shared/entryName.js'

const PROFILE_ID = /^[A-Za-z0-9._-]{1,80}$/
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const MAX_BINARY_BYTES = 32 * 1024 * 1024
const MAX_LISTING_BYTES = 64 * 1024 * 1024

export const FTP_DEFAULTS = Object.freeze({
  // One session for browsing plus three for independent transfers.
  maxSessions: 4,
  connectTimeout: 30_000,
  // A transfer or reply that makes no progress for this long fails.
  idleTimeout: 120_000,
  // Upper bound for one transfer, like the native transfer deadline.
  transferDeadline: 24 * 60 * 60 * 1000,
  // How long an operation waits for a free session before EFTP_BUSY.
  leaseWait: 120_000,
  keepaliveInterval: 30_000,
})

export const ftpError = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })

/** `ftp:<id>` / `ftps:<id>` → `{ scheme, id }`, otherwise null. */
export const parseFtpProvider = (providerId) => {
  if (typeof providerId !== 'string') return null
  const separator = providerId.indexOf(':')
  const scheme = providerId.slice(0, separator)
  const id = providerId.slice(separator + 1)
  return separator > 0 && (scheme === 'ftp' || scheme === 'ftps') && PROFILE_ID.test(id) ? { scheme, id } : null
}

/** Absolute POSIX path without `.`/`..`, backslashes, NUL or line breaks. */
export const normalizeFtpPath = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\0\r\n]/.test(value)) throw ftpError('EINVAL', 'Invalid remote path')
  const parts = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}


const unsafeNameError = (directory) => ftpError('EUNSAFE_NAME', 'The server listed an unsafe file name; the operation was stopped', { path: directory })

// ---------------------------------------------------------------------------
// Listings

const pad = (value) => String(value).padStart(2, '0')
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** RFC 3659 time-val `YYYYMMDDHHMMSS[.sss]` (UTC) → ISO string. */
export const parseTimeVal = (value) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/.exec(String(value || ''))
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match.map(Number)
  const time = Date.UTC(year, month - 1, day, hour, minute, second)
  const date = new Date(time)
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString() : null
}

const unixTime = (raw, now = new Date()) => {
  const match = /^(\S{3})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/.exec(raw.trim())
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1
  if (month < 0) return null
  const day = Number(match[2])
  if (match[5]) return new Date(Date.UTC(Number(match[5]), month, day)).toISOString()
  // A recent entry without a year: this year, or last year if that would be in the future.
  let year = now.getUTCFullYear()
  if (Date.UTC(year, month, day) > now.getTime() + 86_400_000) year -= 1
  return new Date(Date.UTC(year, month, day, Number(match[3]), Number(match[4]))).toISOString()
}

const dosTime = (raw) => {
  const match = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(AM|PM)?$/i.exec(raw.trim())
  if (!match) return null
  let year = Number(match[3])
  if (match[3].length === 2) year += year < 70 ? 2000 : 1900
  let hour = Number(match[4])
  if (match[6]) hour = (hour % 12) + (match[6].toUpperCase() === 'PM' ? 12 : 0)
  return new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]))).toISOString()
}

/** One `MLSD`/`MLST` fact line → entry, name exactly as sent (no trimming). */
export const parseMlsxLine = (line) => {
  const text = line.replace(/^ +/, '').replace(/[\r\n]+$/, '')
  const separator = text.indexOf(' ')
  if (separator < 0) return null
  const name = text.slice(separator + 1)
  if (!name) return null
  let kind = 'unknown', size = null, modifiedAt = null
  for (const fact of text.slice(0, separator).split(';')) {
    if (!fact) continue
    const equals = fact.indexOf('=')
    if (equals < 0) return null
    const key = fact.slice(0, equals).toLowerCase(), value = fact.slice(equals + 1)
    if (key === 'type') {
      const type = value.toLowerCase()
      if (type === 'cdir' || type === 'pdir') return null
      kind = type === 'file' ? 'file' : type === 'dir' ? 'directory'
        : type.startsWith('os.unix=slink') || type.startsWith('os.unix=symlink') ? 'symlink' : 'unknown'
    } else if (key === 'size' && /^\d+$/.test(value)) size = Number(value)
    else if (key === 'modify') modifiedAt = parseTimeVal(value)
  }
  if (name === '.' || name === '..') return null
  return { name, kind, size: kind === 'directory' ? null : size, modifiedAt }
}

/** One `LIST` line in Unix (`ls -l`) or DOS/IIS format. */
export const parseListLine = (line, now = new Date()) => {
  const text = line.replace(/[\r\n]+$/, '')
  if (!text.trim() || /^total\s+\d+/i.test(text)) return null
  let info = null, modifiedAt = null
  if (unixListing.testLine(text)) {
    info = unixListing.parseLine(text)
    modifiedAt = info && unixTime(info.rawModifiedAt, now)
  } else if (dosListing.testLine(text)) {
    info = dosListing.parseLine(text)
    modifiedAt = info && dosTime(info.rawModifiedAt)
  }
  if (!info || !info.name || info.name === '.' || info.name === '..') return null
  const kind = info.type === 1 ? 'file' : info.type === 2 ? 'directory' : info.type === 3 ? 'symlink' : 'unknown'
  return { name: info.name, kind, size: kind === 'file' ? info.size : null, modifiedAt }
}

/**
 * A directory listing. Entries whose names are not a single safe path
 * component are left out and counted; recursive operations refuse an
 * incomplete listing.
 */
export const parseListing = (text, mlsd, now = new Date()) => {
  const listing = { entries: [], rejected: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const entry = mlsd ? parseMlsxLine(line) : parseListLine(line, now)
    if (!entry) continue
    if (unsafeEntryName(entry.name)) listing.rejected++
    else listing.entries.push(entry)
  }
  return listing
}

const fileEntry = (directory, entry) => {
  const isDirectory = entry.kind === 'directory'
  return {
    name: entry.name,
    path: posix.join(directory, entry.name),
    type: isDirectory ? 'directory' : 'file',
    isDirectory,
    isSymbolicLink: entry.kind === 'symlink',
    size: isDirectory ? null : entry.size ?? null,
    modifiedAt: entry.modifiedAt ?? null,
    metadataError: null,
  }
}

const directoryEntry = (directory) => ({
  name: posix.basename(directory) || '/', path: directory, type: 'directory',
  isDirectory: true, isSymbolicLink: false, size: null, modifiedAt: null, metadataError: null,
})

const sortEntries = (entries) => entries.sort((a, b) => a.isDirectory === b.isDirectory
  ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDirectory ? -1 : 1)

// ---------------------------------------------------------------------------
// TLS

/** SHA-256 of the DER certificate as 64 lowercase hex digits (the pin format). */
export const certificateFingerprint = (raw) => crypto.createHash('sha256').update(raw).digest('hex')

const distinguishedName = (value) => String(value || '').split('\n')
  .map((part) => part.trim()).filter((part) => /^(CN|O|OU|C)=/.test(part)).join(', ')

/** What a rejected certificate looked like, without any secret (native `CertificateDetails`). */
export const describeCertificate = (raw, endpoint, reason, pin = '') => {
  const details = {
    endpoint, sha256: certificateFingerprint(raw), subject: '', issuer: '',
    notBefore: null, notAfter: null, dnsNames: [], ipAddresses: [], reason,
    ...(pin ? { pinnedSha256: pin } : {}),
  }
  try {
    const certificate = new X509Certificate(raw)
    details.subject = distinguishedName(certificate.subject)
    details.issuer = distinguishedName(certificate.issuer)
    const iso = (value) => { const time = new Date(value); return Number.isNaN(time.getTime()) ? null : time.toISOString().replace('.000Z', '+00:00') }
    details.notBefore = iso(certificate.validFrom)
    details.notAfter = iso(certificate.validTo)
    for (const name of String(certificate.subjectAltName || '').split(/,\s*/)) {
      if (name.startsWith('DNS:')) details.dnsNames.push(name.slice(4))
      else if (name.startsWith('IP Address:')) details.ipAddresses.push(name.slice(11))
    }
  } catch { /* Best effort: verification never depends on these fields. */ }
  return details
}

const CERTIFICATE_REASONS = new Map([
  ['CERT_HAS_EXPIRED', 'expired'], ['CERT_NOT_YET_VALID', 'notYetValid'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'hostname'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'untrusted'], ['SELF_SIGNED_CERT_IN_CHAIN', 'untrusted'],
  ['UNABLE_TO_GET_ISSUER_CERT', 'untrusted'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'untrusted'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'untrusted'], ['CERT_UNTRUSTED', 'untrusted'],
  ['CERT_SIGNATURE_FAILURE', 'invalid'], ['CERT_REJECTED', 'untrusted'], ['INVALID_CA', 'untrusted'],
  ['ERR_TLS_CERT_ALTNAME_FORMAT', 'hostname'],
])

const certificateFailure = (details) => ftpError(
  details.reason === 'changed' ? 'ETLS_CERTIFICATE_CHANGED'
    : details.reason === 'expired' || details.reason === 'notYetValid' ? 'ETLS_CERTIFICATE_EXPIRED'
      : details.reason === 'hostname' ? 'ETLS_CERTIFICATE_HOSTNAME' : 'ETLS_CERTIFICATE_UNTRUSTED',
  details.reason === 'changed' ? 'The FTPS server presented a different certificate than the trusted one' : 'The FTPS server certificate is not trusted',
  { certificate: details },
)

/** Trust anchors: Node's bundled roots, the operating system store and extra (test) CAs. */
let baseAnchors = null
const trustAnchors = (extra = []) => {
  if (!baseAnchors) {
    const roots = new Set()
    for (const type of ['default', 'system']) {
      try { for (const root of tls.getCACertificates?.(type) || []) roots.add(root) } catch { /* not available */ }
    }
    if (!roots.size) for (const root of tls.rootCertificates) roots.add(root)
    baseAnchors = [...roots]
  }
  return extra.length ? [...new Set([...baseAnchors, ...extra])] : baseAnchors
}

// ---------------------------------------------------------------------------
// Errors

const isConnectionLost = (error) => !(error instanceof FTPError) || error.code === 421

/** A failed FTP command → our error; server reply text is a diagnostic only. */
export const mapFtpError = (error, path) => {
  if (error?.vesperwind) return error
  let code = 'EFTP', message = 'The FTP operation failed'
  if (error instanceof FTPError) {
    const reply = error.code
    ;[code, message] = reply === 421 ? ['EFTP_DISCONNECTED', 'The FTP server closed the connection']
      : reply === 425 || reply === 426 ? ['EFTP_TRANSFER', 'The FTP data connection failed']
        : reply === 450 || reply === 550 ? ['EFTP_UNAVAILABLE', 'The FTP server could not access this item']
          : [451, 452, 552].includes(reply) ? ['EFTP_TRANSFER', 'The FTP server reported that the transfer failed']
            : reply === 530 || reply === 532 ? ['EACCES', 'The FTP server denied access']
              : reply === 553 ? ['EINVALID_NAME', 'The FTP server refused this name']
                : [500, 501, 502, 504].includes(reply) ? ['ENOTSUPPORTED', 'The FTP server does not support this operation']
                  : [521, 522, 533, 534, 536].includes(reply) ? ['EFTPS_PROTECTION', 'The FTP server refused the protected data connection']
                    : ['EFTP', 'The FTP operation failed']
    return ftpError(code, message, { vesperwind: true, reply, nativeError: String(error.message || '').slice(0, 300), ...(path ? { path } : {}) })
  }
  if (/^Timeout/.test(error?.message || '') || error?.code === 'ETIMEDOUT') {
    [code, message] = ['ETIMEDOUT', 'The FTP server did not respond in time']
  } else if (error?.code === 'ECANCELLED') return error
  else if (error?.code === 'ETLS_DATA') [code, message] = ['ETLS', 'The secure data connection could not be verified']
  else if (/^ERR_SSL|^ERR_TLS/.test(error?.code || '') || error?.library === 'SSL routines') [code, message] = ['ETLS', 'The secure connection to the FTP server failed']
  else [code, message] = ['EFTP_DISCONNECTED', 'The FTP connection was lost']
  return ftpError(code, message, { vesperwind: true, nativeError: String(error?.code || '').slice(0, 64), ...(path ? { path } : {}) })
}

const cancelled = () => ftpError('ECANCELLED', 'The operation was cancelled', { vesperwind: true })

// ---------------------------------------------------------------------------
// Sessions

const credentialFree = (spec) => ({ host: spec.host, port: spec.port, security: spec.security, pin: spec.pin })

/**
 * Reads the server certificate for the trust dialog without credentials: a
 * TLS handshake that accepts any certificate, after `AUTH TLS` for explicit
 * FTPS, then the connection is closed. Nothing is trusted by this.
 */
export const probeCertificate = (spec, { timeout = 15_000 } = {}) => new Promise((resolve) => {
  const raw = net.connect({ host: spec.host, port: spec.port })
  let done = false, buffer = '', secure = null
  const finish = (value) => { if (done) return; done = true; clearTimeout(timer); secure?.destroy(); raw.destroy(); resolve(value) }
  const timer = setTimeout(() => finish(null), timeout)
  const handshake = () => {
    raw.removeAllListeners('data')
    secure = tls.connect({ socket: raw, rejectUnauthorized: false, ...(net.isIP(spec.host) ? {} : { servername: spec.host }) }, () => {
      const certificate = secure.getPeerCertificate(true)
      finish(certificate?.raw ? Buffer.from(certificate.raw) : null)
    })
    secure.on('error', () => finish(null))
  }
  raw.on('error', () => finish(null))
  if (spec.security === 'implicit') { raw.once('connect', handshake); return }
  raw.on('data', (chunk) => {
    buffer += chunk.toString('latin1')
    const lines = buffer.split('\r\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (/^220 /.test(line)) raw.write('AUTH TLS\r\n')
      else if (/^234 /.test(line)) return handshake()
      else if (/^\d{3} /.test(line) && !/^220/.test(line)) return finish(null)
    }
  })
})

/** Wraps basic-ftp's data socket setter so every TLS data connection is verified before use. */
const verifyDataSockets = (client, verify, onFailure) => {
  const context = client.ftp
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), 'dataSocket')
  Object.defineProperty(context, 'dataSocket', {
    configurable: true,
    get() { return descriptor.get.call(context) },
    set(socket) {
      if (socket instanceof tls.TLSSocket) {
        // Verified when the handshake completes, before any `secureConnect`
        // listener of basic-ftp runs: a refused socket never emits it, so no
        // transfer starts on it. basic-ftp also starts an upload as soon as
        // `getCipher()` reports a cipher, which can be before the handshake
        // completed; until verified it reports none, so nothing (not even the
        // end of an empty upload) is written to an unverified peer.
        let verified = false
        const getCipher = socket.getCipher
        socket.getCipher = function () { return verified ? getCipher.call(this) : undefined }
        const emit = socket.emit
        socket.emit = function (event, ...values) {
          if (event === 'secureConnect' && !verified) {
            try { verify(socket, true); verified = true } catch (error) {
              onFailure(error)
              socket.destroy(Object.assign(new Error('The secure data connection could not be verified'), { code: 'ETLS_DATA' }))
              return false
            }
          }
          return emit.call(this, event, ...values)
        }
      }
      descriptor.set.call(context, socket)
    },
  })
}

export class FtpSession {
  constructor(client, capabilities) {
    this.client = client
    this.capabilities = capabilities
    this.broken = false
  }

  /** Connects, verifies TLS, protects the data channel and only then logs in. */
  static async connect(spec, options = {}) {
    const settings = { ...FTP_DEFAULTS, ...options }
    const client = new Client(settings.idleTimeout)
    client.ftp.verbose = false
    client.ftp.log = () => {}
    // Listings are parsed here, line by line, so every name is checked.
    client.parseList = (text) => text
    client.options.maxListingBytes = MAX_LISTING_BYTES
    const endpoint = `${spec.host}:${spec.port}`
    const tlsOptions = spec.security === 'plain' ? null : {
      host: spec.host,
      ...(net.isIP(spec.host) ? {} : { servername: spec.host }),
      ca: trustAnchors(settings.extraCa),
      minVersion: 'TLSv1.2',
      // Unpinned: Node verifies chain and name and refuses the handshake.
      // Pinned: the pin replaces those checks and is enforced on every
      // socket by `verify` below, before any credential or data is sent.
      rejectUnauthorized: !spec.pin,
    }
    let dataFailure = null
    const verify = (socket, data = false) => {
      if (data && socket.isSessionReused()) {
        // Resumption proves the peer holds a session from a verified socket of
        // this FTP session; Node does not report its certificate again. A
        // refused data socket ends the whole FTP session, so a session it may
        // have offered is never resumed.
        return
      }
      const peer = socket.getPeerCertificate(true)
      const raw = peer?.raw ? Buffer.from(peer.raw) : null
      if (spec.pin) {
        if (!raw || certificateFingerprint(raw) !== spec.pin) {
          throw certificateFailure(describeCertificate(raw || Buffer.alloc(0), endpoint, 'changed', spec.pin))
        }
        return
      }
      if (!socket.authorized) {
        const reason = CERTIFICATE_REASONS.get(String(socket.authorizationError?.code || socket.authorizationError || '')) || 'untrusted'
        throw certificateFailure(describeCertificate(raw || Buffer.alloc(0), endpoint, reason))
      }
    }
    if (tlsOptions) verifyDataSockets(client, verify, (error) => { dataFailure = error })
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; client.close() }, settings.connectTimeout)
    const tlsFailure = async (error) => {
      if (error?.certificate) return error
      const reason = CERTIFICATE_REASONS.get(error?.code)
      if (!reason) return null
      const raw = await probeCertificate(credentialFree(spec))
      return certificateFailure(describeCertificate(raw || Buffer.alloc(0), endpoint, reason))
    }
    try {
      if (spec.security === 'implicit') {
        try { await client.connectImplicitTLS(spec.host, spec.port, tlsOptions) } catch (error) { throw (await tlsFailure(error)) || error }
      } else {
        await client.connect(spec.host, spec.port)
      }
      if (spec.security === 'explicit') {
        try { await client.useTLS(tlsOptions) } catch (error) {
          if (error instanceof FTPError) {
            throw ftpError('EFTPS_AUTH_TLS_REJECTED', 'The FTP server does not offer explicit TLS (AUTH TLS)', { vesperwind: true, nativeError: String(error.code) })
          }
          throw (await tlsFailure(error)) || error
        }
      }
      if (tlsOptions) {
        // Mandatory: the control connection is verified before anything else.
        verify(client.ftp.socket)
        for (const command of ['PBSZ 0', 'PROT P']) {
          try { await client.send(command) } catch (error) {
            if (!(error instanceof FTPError)) throw error
            throw ftpError('EFTPS_PROT_P_REJECTED', 'The FTP server refused to protect the data connection (PROT P)', { vesperwind: true, nativeError: String(error.code) })
          }
        }
      }
      try { await client.login(spec.username, spec.password) } catch (error) {
        if (error instanceof FTPError && [530, 331, 332, 430].includes(error.code)) {
          throw ftpError('EAUTHENTICATION_REQUIRED', 'The FTP server rejected the user name or password', { vesperwind: true, auth: { needs: 'password' } })
        }
        // The reply text of a failed login is never kept.
        throw ftpError(isConnectionLost(error) ? 'EFTP_DISCONNECTED' : 'EFTP', 'The FTP login failed', { vesperwind: true })
      }
      const features = await client.features()
      const capabilities = { mlsd: features.has('MLST'), mlst: features.has('MLST'), utf8: features.has('UTF8'), rest: features.has('REST') }
      await client.send('TYPE I')
      if (capabilities.utf8) await client.sendIgnoringError('OPTS UTF8 ON')
      const session = new FtpSession(client, capabilities)
      session.dataFailure = () => dataFailure
      return session
    } catch (error) {
      client.close()
      if (error?.vesperwind || error?.certificate) throw error
      if (timedOut) throw ftpError('ETIMEDOUT', 'The FTP server did not respond in time', { vesperwind: true })
      throw mapFtpError(error)
    } finally {
      clearTimeout(deadline)
    }
  }

  get closed() { return this.client.closed }

  close() { this.broken = true; this.client.close() }

  async quit() {
    try { await Promise.race([this.client.send('QUIT'), new Promise((resolve) => setTimeout(resolve, 1000))]) } catch { /* closing anyway */ }
    this.client.close()
  }

  wrap(error, path) {
    const failure = this.dataFailure?.()
    if (failure) return failure
    return mapFtpError(error, path)
  }

  async pwd() { return this.client.pwd() }

  async list(directory) {
    const text = await this.listText(directory)
    return parseListing(text, this.capabilities.mlsd)
  }

  /** Raw listing text; parsing (and name checks) happen in `parseListing`. */
  async listText(directory) {
    const command = this.capabilities.mlsd ? 'MLSD' : 'LIST'
    this.client.availableListCommands = [command]
    try {
      return await this.client.list(directory)
    } catch (error) {
      if (command === 'MLSD' && error instanceof FTPError && error.code >= 500 && error.code <= 502) {
        this.capabilities.mlsd = false
        return this.listText(directory)
      }
      throw error
    }
  }

  /** The entry at `path`, or null if the server says it does not exist. */
  async stat(path) {
    if (path === '/') return { name: '/', kind: 'directory', size: null, modifiedAt: null }
    if (this.capabilities.mlst) {
      try {
        const response = await this.client.send(`MLST ${path}`)
        const line = response.message.split(/\r?\n/).find((item) => item.startsWith(' '))
        const entry = line && parseMlsxLine(line)
        if (entry) return { ...entry, name: posix.basename(path) }
      } catch (error) {
        if (error instanceof FTPError && (error.code === 450 || error.code === 550)) return null
        if (error instanceof FTPError && error.code >= 500 && error.code <= 502) this.capabilities.mlst = false
        else throw error
      }
    }
    const name = posix.basename(path)
    try {
      return (await this.list(posix.dirname(path))).entries.find((entry) => entry.name === name) || null
    } catch (error) {
      if (error instanceof FTPError && (error.code === 450 || error.code === 550)) return null
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Connections and the session pool

const securityOf = (profile) => profile.protocol === 'ftps' ? (profile.ftpTls === 'implicit' ? 'implicit' : 'explicit') : 'plain'

/** Validates a saved FTP/FTPS profile for connecting. */
export const validateFtpProfile = (profile) => {
  if (!profile || typeof profile !== 'object') throw ftpError('EINVAL', 'A connection profile is required')
  if (!PROFILE_ID.test(profile.id || '')) throw ftpError('EINVAL', 'Invalid connection ID')
  if (!['ftp', 'ftps'].includes(profile.protocol)) throw ftpError('EINVAL', 'This connection profile is not an FTP or FTPS profile')
  if (!String(profile.host || '').trim() || /[\0\r\n\s]/.test(profile.host)) throw ftpError('EINVAL', 'Invalid FTP host')
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw ftpError('EINVAL', 'FTP port must be between 1 and 65535')
  if (!['password', 'anonymous'].includes(profile.authType)) throw ftpError('EINVAL', 'Unsupported authentication type')
  if (!String(profile.username || '').trim() || /[\0\r\n]/.test(profile.username)) throw ftpError('EINVAL', 'Invalid FTP user name')
  if (profile.initialPath) normalizeFtpPath(profile.initialPath)
  return profile
}

/** Fields whose change ends a connected session (endpoint, protocol, TLS, identity, trust). */
const SESSION_FIELDS = ['protocol', 'host', 'port', 'username', 'authType', 'ftpTls', 'tlsTrustedCertificate', 'plaintextAcknowledged']

export class FtpConnection {
  constructor(profile, password, first, paths, options) {
    this.profile = profile
    this.password = password
    this.options = options
    this.root = paths.root
    this.initialPath = paths.initial
    this.homePath = paths.home
    this.capabilities = first.capabilities
    this.status = 'connected'
    this.idle = [first]
    this.open = 1
    this.waiters = []
    this.leased = new Set()
    this.events = new EventEmitter()
    this.keepalive = setInterval(() => this.keepIdleAlive(), options.keepaliveInterval)
    this.keepalive.unref?.()
  }

  get providerId() { return `${this.profile.protocol}:${this.profile.id}` }

  spec() {
    return {
      host: this.profile.host, port: this.profile.port, security: securityOf(this.profile),
      username: this.profile.username, password: this.password,
      pin: this.profile.protocol === 'ftps' ? normalizeCertificatePin(this.profile.tlsTrustedCertificate) : '',
    }
  }

  async lease(signal) {
    if (this.status !== 'connected') throw ftpError('EFTP_DISCONNECTED', 'The FTP connection is disconnected', { vesperwind: true })
    if (signal?.aborted) throw cancelled()
    const session = this.idle.pop()
    if (session) { this.leased.add(session); return session }
    if (this.open < this.options.maxSessions) {
      this.open++
      try {
        const created = await FtpSession.connect(this.spec(), this.options)
        if (this.status !== 'connected') { created.close(); throw ftpError('EFTP_DISCONNECTED', 'The FTP connection is disconnected', { vesperwind: true }) }
        this.leased.add(created)
        return created
      } catch (error) {
        this.open--
        this.wake()
        throw error
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      const stop = (error) => { this.waiters = this.waiters.filter((item) => item !== waiter); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error) }
      const onAbort = () => stop(cancelled())
      const timer = setTimeout(() => stop(ftpError('EFTP_BUSY', 'The FTP connection is busy with other transfers', { vesperwind: true })), this.options.leaseWait)
      waiter.resolve = (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value) }
      waiter.reject = (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Lets one waiter retry: an idle session or room for a new one appeared. */
  wake() {
    const waiter = this.waiters.shift()
    if (!waiter) return
    this.lease().then(waiter.resolve, waiter.reject)
  }

  /** A session goes back only after its operation finished cleanly. */
  release(session, reusable) {
    this.leased.delete(session)
    if (reusable && !session.broken && !session.closed && this.status === 'connected') {
      const waiter = this.waiters.shift()
      if (waiter) { this.leased.add(session); waiter.resolve(session); return }
      this.idle.push(session)
      return
    }
    session.close()
    this.open--
    this.wake()
  }

  /** NOOP on idle sessions only; a session is taken out of the pool meanwhile. */
  keepIdleAlive() {
    for (const session of this.idle.splice(0)) {
      this.leased.add(session)
      session.client.send('NOOP').then(() => this.release(session, true), () => this.release(session, false))
    }
  }

  /** Breaks the control connection of idle sessions, as a server timeout would (tests). */
  severIdle() { for (const session of this.idle) session.client.ftp.socket.destroy() }

  /**
   * Runs an operation whose repetition is harmless (listing, metadata). A
   * session that lost its connection is replaced and the operation repeated
   * once. Changing operations use `once` and are never repeated.
   */
  async repeatable(operation, signal) {
    for (let attempt = 0; ; attempt++) {
      const session = await this.lease(signal)
      try {
        const result = await operation(session)
        this.release(session, true)
        return result
      } catch (error) {
        const failure = session.wrap(error)
        const lost = ['EFTP_DISCONNECTED', 'ETIMEDOUT'].includes(failure.code) && !error?.vesperwind
        this.release(session, error instanceof FTPError && error.code !== 421)
        if (lost && attempt === 0 && this.status === 'connected' && !signal?.aborted) {
          // Idle sessions are probably stale as well (server restart, idle timeout).
          for (const stale of this.idle.splice(0)) { stale.close(); this.open-- }
          continue
        }
        throw failure
      }
    }
  }

  async once(operation, signal) {
    const session = await this.lease(signal)
    try {
      const result = await operation(session)
      this.release(session, true)
      return result
    } catch (error) {
      this.release(session, error instanceof FTPError && error.code !== 421)
      throw session.wrap(error)
    }
  }

  close() {
    if (this.status === 'disconnected') return
    this.status = 'disconnected'
    clearInterval(this.keepalive)
    for (const session of this.idle.splice(0)) session.quit()
    for (const session of this.leased) session.close()
    this.leased.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(ftpError('EFTP_DISCONNECTED', 'The FTP connection is disconnected', { vesperwind: true }))
    this.password = ''
    this.events.emit('closed')
  }

  // ----- provider operations -----

  resolve(requested) {
    const path = normalizeFtpPath(requested)
    const root = this.root.replace(/\/$/, '')
    if (path !== this.root && !path.startsWith(`${root}/`)) throw ftpError('EOUTSIDE_ROOT', 'Path is outside this remote connection root')
    return path
  }

  rootEntry() { return directoryEntry(this.root) }
  initialEntry() { return directoryEntry(this.initialPath) }

  async list(requested, { signal } = {}) {
    const directory = this.resolve(requested)
    // Entries with unsafe names are not shown, so nothing can address them.
    const { entries } = await this.repeatable((session) => session.list(directory), signal)
    return sortEntries(entries.map((entry) => fileEntry(directory, entry)))
  }

  /** Entries for recursive operations: a listing with an unsafe name is refused as a whole. */
  async completeListing(directory, signal) {
    const listing = await this.repeatable((session) => session.list(directory), signal)
    if (listing.rejected) throw unsafeNameError(directory)
    return listing.entries
  }

  async statEntry(requested, signal) {
    const path = this.resolve(requested)
    return this.repeatable((session) => session.stat(path), signal)
  }

  async require(path, signal) {
    const entry = await this.statEntry(path, signal)
    if (!entry) throw ftpError('ENOENT', 'The remote item was not found', { path })
    return entry
  }

  /** Common endpoint: `{ isDirectory, isSymbolicLink, size, modifiedAt }` or null. */
  async stat(requested, { signal } = {}) {
    const entry = await this.statEntry(requested, signal)
    return entry && { name: entry.name, isDirectory: entry.kind === 'directory', isSymbolicLink: entry.kind === 'symlink', size: entry.size, modifiedAt: entry.modifiedAt }
  }

  async childNames(path, { signal } = {}) {
    return (await this.completeListing(this.resolve(path), signal)).map((entry) => entry.name)
  }

  /**
   * A download as a stream plus `finish()`, which settles only after the data
   * reached its end and the server confirmed the transfer (final reply).
   * Destroying the stream or aborting `signal` cancels the transfer.
   */
  openRead(requested, { signal, start = 0, end } = {}) {
    const path = this.resolve(requested)
    const stream = new PassThrough({ highWaterMark: 256 * 1024 })
    let session = null, settled = false, enough = false
    let remaining = Number.isSafeInteger(end) ? end - start + 1 : Infinity
    // basic-ftp ends its destination even after a failed transfer, so it
    // writes into this forwarder; `stream` ends only after the final reply.
    const target = new Writable({
      highWaterMark: 256 * 1024,
      write(chunk, _encoding, callback) {
        if (remaining <= 0 || stream.destroyed) return callback()
        const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
        remaining -= part.length
        if (remaining <= 0) {
          // A ranged read stops the transfer once enough bytes arrived.
          enough = true
          stream.end(part)
          setImmediate(() => session?.close())
          return callback()
        }
        if (stream.write(part)) callback()
        else stream.once('drain', callback)
      },
    })
    const finish = (async () => {
      session = await this.lease(signal)
      const deadline = setTimeout(() => session.close(), this.options.transferDeadline)
      const abort = () => session.close()
      signal?.addEventListener('abort', abort, { once: true })
      // A consumer that stops reading early ends the transfer.
      const abandoned = () => { if (!settled && !stream.readableEnded) session.close() }
      stream.once('close', abandoned)
      try {
        await session.client.downloadTo(target, path, start > 0 ? start : 0)
        settled = true
        this.release(session, true)
        if (!stream.writableEnded) stream.end()
      } catch (error) {
        settled = true
        this.release(session, false)
        if (enough) return
        if (signal?.aborted) throw cancelled()
        throw session.wrap(error, path)
      } finally {
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        stream.off('close', abandoned)
      }
    })()
    finish.catch((error) => { if (!stream.destroyed) stream.destroy(error) })
    return { stream, finish: () => finish }
  }

  /**
   * An upload of a new file. `finish()` ends the input and settles after the
   * server confirmed the stored file; `abort()` breaks the transfer. FTP has
   * no exclusive create: the caller checks for an existing item first.
   */
  async createNew(requested, { signal, checkExisting = true } = {}) {
    const path = this.resolve(requested)
    if (checkExisting && await this.statEntry(path, signal)) throw ftpError('EEXIST', 'An item with this name already exists', { path })
    const session = await this.lease(signal)
    const stream = new PassThrough({ highWaterMark: 256 * 1024 })
    const deadline = setTimeout(() => session.close(), this.options.transferDeadline)
    const abort = () => session.close()
    signal?.addEventListener('abort', abort, { once: true })
    let aborted = false
    const done = session.client.uploadFrom(stream, path).then(
      () => { this.release(session, true) },
      (error) => { this.release(session, false); throw aborted || signal?.aborted ? cancelled() : session.wrap(error, path) },
    ).finally(() => { clearTimeout(deadline); signal?.removeEventListener('abort', abort) })
    done.catch(() => {})
    return {
      stream,
      finish: async () => { if (!stream.writableEnded) stream.end(); await done },
      abort: () => { aborted = true; session.close(); stream.destroy() },
    }
  }

  async createFolder(requested, { signal } = {}) {
    const path = this.resolve(requested)
    if (await this.statEntry(path, signal)) throw ftpError('EEXIST', 'An item with this name already exists', { path })
    await this.once((session) => session.client.send(`MKD ${path}`), signal)
  }

  async createEmptyFile(requested, options = {}) {
    const upload = await this.createNew(requested, options)
    await upload.finish()
  }

  async rename(fromRequested, toRequested, { signal } = {}) {
    const from = this.resolve(fromRequested), to = this.resolve(toRequested)
    // Servers differ on renaming over an existing item; never rely on it.
    if (await this.statEntry(to, signal)) throw ftpError('EEXIST', 'An item with this name already exists', { path: to })
    await this.once((session) => session.client.rename(from, to), signal)
  }

  async remove(requested, { signal } = {}) {
    if (signal?.aborted) throw cancelled()
    const path = this.resolve(requested)
    if (path === this.root) throw ftpError('EROOT_OPERATION', 'The remote root cannot be removed')
    const entry = await this.require(path, signal)
    if (entry.kind === 'directory') {
      // The whole listing is checked before anything is deleted; links and
      // unknown entries are deleted, never followed.
      for (const child of await this.completeListing(path, signal)) await this.remove(posix.join(path, child.name), { signal })
      await this.once((session) => session.client.send(`RMD ${path}`), signal)
    } else {
      await this.once((session) => session.client.send(`DELE ${path}`), signal)
    }
  }

  async readBytes(path, limit, signal) {
    const { stream, finish } = this.openRead(path, { signal })
    const chunks = []
    let length = 0
    try {
      for await (const chunk of stream) {
        length += chunk.length
        if (length > limit) { stream.destroy(); throw ftpError('EFILE_TOO_LARGE', 'The file exceeds the read limit') }
        chunks.push(chunk)
      }
      await finish()
    } catch (error) {
      await finish().catch(() => {})
      throw error
    }
    return Buffer.concat(chunks)
  }

  async writeBytes(requested, bytes) {
    const path = this.resolve(requested)
    // Editor save: FTP has no atomic replace.
    const upload = await this.createNew(path, { checkExisting: false })
    upload.stream.end(bytes)
    await upload.finish()
    return { modifiedAt: (await this.statEntry(path).catch(() => null))?.modifiedAt ?? null }
  }

  async readText(requested, options = {}) {
    const path = this.resolve(requested)
    const entry = await this.require(path)
    if (entry.kind === 'directory') throw ftpError('EISDIR', 'This item is not a text file')
    const limit = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0 ? Math.min(options.maxBytes, MAX_TEXT_BYTES) : MAX_TEXT_BYTES
    if (entry.size != null && entry.size > limit) throw ftpError('EFILE_TOO_LARGE', 'Text file exceeds the read limit')
    const bytes = await this.readBytes(path, limit)
    return { content: options.strictText ? decodeTextPreview(bytes) : bytes.toString('utf8'), modifiedAt: entry.modifiedAt }
  }

  async writeText(requested, content) {
    if (typeof content !== 'string') throw ftpError('EINVAL', 'Invalid text contents')
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw ftpError('EFILE_TOO_LARGE', 'Files larger than 10 MB cannot be opened in the editor')
    return this.writeBytes(requested, Buffer.from(content, 'utf8'))
  }

  async readBinary(requested) {
    const path = this.resolve(requested)
    const entry = await this.require(path)
    if (entry.kind === 'directory') throw ftpError('EISDIR', 'This item is not a file')
    if (entry.size != null && entry.size > MAX_BINARY_BYTES) throw ftpError('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be opened')
    const bytes = await this.readBytes(path, MAX_BINARY_BYTES)
    return { base64: bytes.toString('base64'), modifiedAt: entry.modifiedAt }
  }

  async writeBinary(requested, base64) {
    if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw ftpError('EINVAL', 'Invalid binary contents')
    if (base64.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4) throw ftpError('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be saved')
    const path = this.resolve(requested)
    const entry = await this.require(path)
    if (entry.kind === 'directory') throw ftpError('EISDIR', 'The requested path is not a file')
    return this.writeBytes(path, Buffer.from(base64, 'base64'))
  }

  /** Media/content source: ranged reads use REST when the server supports it. */
  async contentSource(requested) {
    const path = this.resolve(requested)
    const entry = await this.require(path)
    if (entry.kind === 'directory') throw ftpError('ENOTFILE', 'The requested path is not a file')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw ftpError('EOVERFLOW', 'The FTP server does not report a size for this file')
    return {
      path,
      size: entry.size,
      createReadStream: ({ start, end } = {}) => {
        if (start > 0 && !this.capabilities.rest) {
          const stream = new PassThrough()
          setImmediate(() => stream.destroy(ftpError('ENOTSUPPORTED', 'The FTP server does not support resuming reads')))
          return stream
        }
        const read = this.openRead(path, { start: start || 0, ...(end !== undefined ? { end } : {}) })
        read.finish().catch(() => {})
        return read.stream
      },
    }
  }

  async properties(requested) {
    const path = this.resolve(requested)
    const entry = await this.require(path)
    const type = entry.kind
    return {
      name: posix.basename(path) || '/', path, type,
      size: type !== 'directory' ? entry.size ?? null : null,
      createdAt: null, modifiedAt: entry.modifiedAt ?? null, accessedAt: null, target: null,
      permissions: null, permissionsMessage: 'Permissions are not available over FTP',
      capabilities: { calculateSize: type === 'directory', changeMode: false, changeOwner: false, changeGroup: false, preview: type === 'file' },
      metadataWarnings: [],
    }
  }

  /** Children for size calculation; links are counted, never followed. */
  async sizeChildren(requested, { signal } = {}) {
    const directory = this.resolve(requested)
    const entry = await this.require(directory, signal)
    if (entry.kind !== 'directory') throw ftpError('ENOTDIR', 'This entry is no longer a directory')
    return (await this.completeListing(directory, signal)).map((child) => ({
      path: posix.join(directory, child.name),
      type: child.kind === 'directory' ? 'directory' : child.kind === 'unknown' ? 'other' : 'file',
      size: child.size ?? undefined,
    }))
  }
}

export class FtpConnectionManager {
  /**
   * @param {object} options
   * @param {Map} [options.connections] shared by all sockets of one server
   * @param {(id: string) => Promise<object|undefined>} options.loadProfile saved profile by id
   * @param {(event: object) => void} [options.emitStatus]
   */
  constructor({ connections = new Map(), loadProfile, emitStatus = () => {}, ...options } = {}) {
    this.connections = connections
    this.loadProfile = loadProfile
    this.emitStatus = emitStatus
    this.options = { ...FTP_DEFAULTS, ...options }
  }

  /**
   * Connects a **saved** profile. Its settings, not the request, decide the
   * endpoint, TLS mode, pin and plaintext acknowledgement. `password` is a
   * typed secret kept only in memory for this connection.
   */
  async connect(profileId, password = '') {
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) throw ftpError('EINVAL', 'Invalid connection ID')
    if (typeof password !== 'string' || /[\r\n\0]/.test(password)) throw ftpError('EINVAL', 'Invalid password')
    const profile = validateFtpProfile(await this.loadProfile(profileId).then((value) => {
      if (!value) throw ftpError('ENOENT', 'The connection profile was not found')
      return value
    }))
    if (profile.protocol === 'ftp' && profile.plaintextAcknowledged !== true) {
      throw ftpError('EFTP_PLAINTEXT_NOT_ACKNOWLEDGED', 'Confirm that this FTP connection sends the password and files unencrypted')
    }
    const secret = profile.authType === 'anonymous' ? 'anonymous@' : password
    if (!secret) {
      // No secure credential store in this runtime: a password is always typed.
      throw ftpError('EAUTHENTICATION_REQUIRED', 'Enter the password for this FTP connection', { auth: { needs: 'password' } })
    }
    const spec = {
      host: profile.host, port: profile.port, security: securityOf(profile), username: profile.username, password: secret,
      pin: profile.protocol === 'ftps' ? normalizeCertificatePin(profile.tlsTrustedCertificate) : '',
    }
    const session = await FtpSession.connect(spec, this.options)
    let paths
    try {
      const home = await session.pwd().then(normalizeFtpPath).catch(() => '/')
      const initial = normalizeFtpPath(profile.initialPath || home)
      const entry = await session.stat(initial).catch((error) => { throw mapFtpError(error, initial) })
      if (!entry) throw ftpError('ENOENT', 'Initial remote directory was not found', { path: initial })
      if (entry.kind !== 'directory') throw ftpError('ENOTDIR', 'Initial remote path is not a folder')
      paths = { root: '/', initial, home }
    } catch (error) {
      session.close()
      throw error
    }
    const connection = new FtpConnection(profile, secret, session, paths, this.options)
    this.connections.get(profile.id)?.close()
    this.connections.set(profile.id, connection)
    const providerId = connection.providerId
    connection.events.once('closed', () => {
      if (this.connections.get(profile.id) === connection) this.connections.delete(profile.id)
      this.emitStatus({ connectionId: profile.id, providerId, status: 'disconnected' })
    })
    this.emitStatus({ connectionId: profile.id, providerId, status: 'connected' })
    return {
      connectionId: profile.id, providerId, status: 'connected',
      root: connection.rootEntry(), initial: connection.initialEntry(), homePath: connection.homePath,
      capabilities: { mlsd: session.capabilities.mlsd, utf8: session.capabilities.utf8, rest: session.capabilities.rest, changePermissions: false, terminal: false, symlinkCreate: false, atomicCreate: false },
    }
  }

  disconnect(id) {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    connection.close()
  }

  status(id) { return this.connections.get(id)?.status === 'connected' ? 'connected' : 'disconnected' }

  /** The connection for `ftp:<id>` / `ftps:<id>`; the scheme must match the profile. */
  get(providerId) {
    const parsed = parseFtpProvider(providerId)
    if (!parsed) throw ftpError('EFILESYSTEM_ID', 'This filesystem is not available')
    const connection = this.connections.get(parsed.id)
    if (!connection || connection.status !== 'connected') throw ftpError('EFTP_DISCONNECTED', 'The FTP connection is disconnected')
    if (connection.profile.protocol !== parsed.scheme) throw ftpError('EFILESYSTEM_ID', 'This filesystem is not available')
    return connection
  }

  /**
   * After settings were saved: a connection whose profile was removed or
   * changed endpoint, protocol, TLS mode, identity or trust is closed, so the
   * new settings (and their confirmations) apply to the next connect.
   */
  invalidate(nextProfiles) {
    const next = new Map((Array.isArray(nextProfiles) ? nextProfiles : []).map((profile) => [profile.id, profile]))
    for (const [id, connection] of [...this.connections]) {
      const profile = next.get(id)
      if (!profile || SESSION_FIELDS.some((field) => (profile[field] ?? null) !== (connection.profile[field] ?? null))) this.disconnect(id)
    }
  }

  shutdown() { for (const id of [...this.connections.keys()]) this.disconnect(id) }
}
