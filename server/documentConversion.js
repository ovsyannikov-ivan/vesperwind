import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 32 * 1024 * 1024
const errorWith = (code, message) => Object.assign(new Error(message), { code })
const validBase64 = (value) => typeof value === 'string' && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)

const executable = () => {
  if (process.env.VESPERWIND_LIBREOFFICE) return process.env.VESPERWIND_LIBREOFFICE
  if (process.platform === 'darwin' && existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice')) return '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (root && existsSync(path.join(root, 'LibreOffice', 'program', 'soffice.exe'))) return path.join(root, 'LibreOffice', 'program', 'soffice.exe')
    }
  }
  return 'soffice'
}

const convertProcess = (directory, source, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const args = [
    `-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
    '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', directory, source,
  ]
  const child = spawn(executable(), args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
  let stderr = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) })
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(errorWith(error.code === 'ENOENT' ? 'ECONVERTER_MISSING' : 'ECONVERTER',
      error.code === 'ENOENT' ? 'Document import requires a supported local LibreOffice converter.' : error.message))
  })
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    if (signal) reject(errorWith('ECONVERTER_TIMEOUT', 'Local document conversion timed out'))
    else if (code !== 0) reject(errorWith('ECONVERTER', `LibreOffice conversion failed: ${stderr || `exit ${code}`}`))
    else resolve()
  })
})

export const convertDocumentBytes = async (bytes, format, run = convertProcess) => {
  if (!['rtf', 'doc'].includes(format)) throw errorWith('EINVAL', 'Only RTF and DOC can be imported')
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw errorWith('EFILE_TOO_LARGE', 'Document import limit is 32 MB')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-document-'))
  try {
    const source = path.join(directory, `input.${format}`)
    await fs.writeFile(source, bytes)
    await run(directory, source)
    const result = await fs.readFile(path.join(directory, 'input.docx'))
    if (result.length > MAX_BYTES) throw errorWith('EFILE_TOO_LARGE', 'Converted DOCX exceeds 32 MB')
    return result
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export const registerDocumentConversionHandlers = (socket) => {
  socket.on('document:convert', async (payload, acknowledge) => {
    try {
      if (!validBase64(payload?.base64) || payload.base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw errorWith('EINVAL', 'Invalid document bytes')
      const result = await convertDocumentBytes(Buffer.from(payload.base64, 'base64'), payload.format)
      acknowledge?.({ ok: true, base64: result.toString('base64') })
    } catch (error) {
      acknowledge?.({ ok: false, error: { code: error.code || 'ECONVERTER', message: error.message } })
    }
  })
}
