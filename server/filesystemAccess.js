import fs from 'node:fs/promises'
import path from 'node:path'
import { isComputerPath } from '../shared/localFilesystem.js'

const isInside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const outsideRoot = () => Object.assign(new Error('The requested path is outside FILE_MANAGER_ROOT'), { code: 'EOUTSIDE_ROOT' })

// Only the browser server confines access. Desktop paths still obey OS permissions.
export const createFilesystemAccess = ({ root, desktop }) => ({
  resolve(requested) {
    if (typeof requested !== 'string' || !requested || isComputerPath(requested)) {
      throw Object.assign(new TypeError('A filesystem path is required'), { code: 'EINVAL' })
    }
    const resolved = path.resolve(requested)
    if (!desktop && !isInside(root, resolved)) throw outsideRoot()
    return resolved
  },
  async verify(resolved) {
    const target = await fs.realpath(resolved)
    if (!desktop && !isInside(await fs.realpath(root), target)) throw outsideRoot()
    return target
  },
})

export const listWindowsDrives = async ({ stat = fs.stat } = {}) => {
  const entries = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const drive = `${String.fromCharCode(65 + index)}:\\`
    try {
      const metadata = await stat(drive)
      if (!metadata.isDirectory()) return null
    } catch (error) {
      // Missing letters are not disks; present but inaccessible volumes can still
      // be displayed and report their OS error when opened.
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return null
    }
    return { name: drive, path: drive, type: 'drive', isDirectory: true,
      isSymbolicLink: false, size: null, modifiedAt: null, metadataError: null }
  }))
  return entries.filter(Boolean)
}
