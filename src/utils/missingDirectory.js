import { buildFilesystemPathLevels } from './filesystemPath.js'

// Codes a provider reports when the folder itself is gone: local and FTP use
// ENOENT/ENOTDIR, the Node SFTP client passes SSH_FX_NO_SUCH_FILE (2) through.
const missingCodes = new Set(['ENOENT', 'ENOTDIR', 2])

export const isMissingDirectoryError = (error) => missingCodes.has(error?.code)

// The nearest ancestor of `path` that still opens, walking up one level at a
// time. The filesystem root is the last stop and is returned without a check.
export const findExistingAncestor = async ({ rootPath, path, exists }) => {
  const levels = buildFilesystemPathLevels(rootPath, path)
  for (const candidate of levels.slice(1, -1).reverse()) {
    if (await exists(candidate)) return candidate
  }
  return levels[0] ?? null
}
