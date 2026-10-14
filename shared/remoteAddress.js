// A public endpoint label, independent of credentials and profile nicknames.
export const remoteAddress = ({ host, port, protocol = 'sftp', ftpTls }) => {
  const value = String(host || '')
  const address = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
  const defaultPort = protocol === 'sftp' ? 22 : protocol === 'ftps' && ftpTls === 'implicit' ? 990 : 21
  return port && Number(port) !== defaultPort ? `${address}:${port}` : address
}
