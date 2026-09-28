import fs from 'node:fs/promises'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'

export const MAX_BINARY_BYTES = 32 * 1024 * 1024

const validBase64 = (value) => typeof value === 'string' && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
const invalid = (code, message) => Object.assign(new Error(message), { code })
const localFile = async (requestedPath) => {
  const real = await verifyRealPathInsideRoot(resolveInsideRoot(requestedPath))
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw invalid('EISDIR', 'The requested path is not a file')
  if (stat.size > MAX_BINARY_BYTES) throw invalid('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be opened in the spreadsheet editor')
  return { real, stat }
}

export const readBinaryFile = async (requestedPath) => {
  const { real, stat } = await localFile(requestedPath)
  return { base64: (await fs.readFile(real)).toString('base64'), modifiedAt: stat.mtime.toISOString() }
}

export const writeBinaryFile = async (requestedPath, base64) => {
  if (!validBase64(base64)) throw invalid('EINVAL', 'Invalid binary contents')
  if (base64.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4) throw invalid('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be saved')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > MAX_BINARY_BYTES) throw invalid('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be saved')
  const { real } = await localFile(requestedPath)
  await fs.writeFile(real, bytes)
  return { modifiedAt: (await fs.stat(real)).mtime.toISOString() }
}

const serialize = (error, path) => ({
  code: error?.code || 'EBINARY_FILE',
  message: error?.message || 'Unable to read or save this file',
  path: typeof path === 'string' ? path : null,
})

export const registerBinaryFileHandlers = (socket, { ssh }) => {
  socket.on('filesystem:read-binary', async (payload, acknowledge) => {
    try {
      const result = payload?.filesystemId && payload.filesystemId !== 'local'
        ? await (await ssh.ensure(payload.filesystemId)).readBinary(payload?.path)
        : await readBinaryFile(payload?.path)
      acknowledge?.({ ok: true, ...result })
    } catch (error) {
      acknowledge?.({ ok: false, error: serialize(error, payload?.path) })
    }
  })
  socket.on('filesystem:write-binary', async (payload, acknowledge) => {
    try {
      const result = payload?.filesystemId && payload.filesystemId !== 'local'
        ? await ssh.get(payload.filesystemId).writeBinary(payload?.path, payload?.base64)
        : await writeBinaryFile(payload?.path, payload?.base64)
      acknowledge?.({ ok: true, ...result })
    } catch (error) {
      acknowledge?.({ ok: false, error: serialize(error, payload?.path) })
    }
  })
}
