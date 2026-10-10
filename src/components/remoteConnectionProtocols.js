// The connection types of the Remote Connections dialog, in tab order. Each
// entry declares its profile fields, authentication methods, default port
// and which form sections it uses; the dialog itself has no per-protocol
// branches beyond these feature flags. A new protocol (for example WebDAV)
// is a new entry here plus its backend; settings, connections API and the
// backend must support it before it is listed.
import { defaultConnectionPort } from '../../shared/defaultSettings.js'

const COMMON = Object.freeze(['id', 'name', 'host', 'port', 'username', 'authType', 'protocol', 'savePassword', 'initialPath'])

export const CONNECTION_PROTOCOLS = Object.freeze([
  Object.freeze({
    id: 'sftp',
    label: 'SFTP',
    icon: 'mdi-console-network-outline',
    description: 'Connect over SSH using SSH Agent, your SSH configuration, a private key or a password.',
    authTypes: Object.freeze([
      { value: 'auto', label: 'Auto (recommended)' },
      { value: 'password', label: 'Password' },
      { value: 'privateKey', label: 'Private key' },
      { value: 'agent', label: 'SSH Agent' },
    ]),
    // Profile fields beyond COMMON, with their values for a new profile.
    fields: Object.freeze({ privateKeyPath: '', trustedFingerprint: '', saveKeyPassphrase: false, sshConfigHost: '' }),
    features: Object.freeze({ sshConfig: true, privateKey: true, keyPassphrase: true, hostKey: true }),
    passwordAuth: Object.freeze(['auto', 'password']),
    pathPlaceholder: '/home/user',
  }),
  Object.freeze({
    id: 'ftp',
    label: 'FTP',
    icon: 'mdi-folder-network-outline',
    description: 'Plain FTP is not encrypted. Use FTPS when the server supports it.',
    authTypes: Object.freeze([
      { value: 'password', label: 'Password' },
      { value: 'anonymous', label: 'Anonymous' },
    ]),
    fields: Object.freeze({ plaintextAcknowledged: false, ftpDataMode: 'passive', ftpEncoding: 'utf-8' }),
    features: Object.freeze({ plaintext: true, ftpOptions: true }),
    passwordAuth: Object.freeze(['password']),
    pathPlaceholder: '/',
  }),
  Object.freeze({
    id: 'ftps',
    label: 'FTPS',
    icon: 'mdi-folder-lock-outline',
    description: 'FTP over TLS. The server certificate is verified with your system’s trusted certificates.',
    authTypes: Object.freeze([
      { value: 'password', label: 'Password' },
      { value: 'anonymous', label: 'Anonymous' },
    ]),
    fields: Object.freeze({ ftpTls: 'explicit', tlsTrustedCertificate: '', ftpDataMode: 'passive', ftpEncoding: 'utf-8' }),
    features: Object.freeze({ tls: true, ftpOptions: true }),
    passwordAuth: Object.freeze(['password']),
    pathPlaceholder: '/',
  }),
])

export const protocolDefinition = (protocol) => CONNECTION_PROTOCOLS.find((item) => item.id === protocol) || null

/** The fields a profile of `protocol` has, in a stable order. */
export const profileFields = (protocol) => [...COMMON, ...Object.keys(protocolDefinition(protocol)?.fields || {})]

/** A new, empty profile of the tab's protocol with its default port and authentication. */
export const emptyConnectionProfile = (protocol) => {
  const definition = protocolDefinition(protocol)
  const profile = {
    id: '', name: '', host: '', username: '', initialPath: '', savePassword: false,
    protocol, authType: definition.authTypes[0].value, ...definition.fields,
  }
  profile.port = defaultConnectionPort(protocol, profile.ftpTls)
  return profile
}

export { defaultConnectionPort }

/** Human text for a certificate rejection reason from the backend. */
export const CERTIFICATE_REASONS = Object.freeze({
  untrusted: 'The certificate is not issued by an authority your system trusts (for example, it is self-signed).',
  hostname: 'The certificate was not issued for this host name.',
  expired: 'The certificate has expired.',
  notYetValid: 'The certificate is not valid yet.',
  invalid: 'The certificate could not be validated.',
  changed: 'The server presented a different certificate than the one you trusted.',
})
