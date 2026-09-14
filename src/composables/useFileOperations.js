import { request } from '../socket/request.js'

const OPERATION_TIMEOUT = 10 * 60 * 1000

export const useFileOperations = () => {
  const operate = (action, sourcePath, targetDirectory) =>
    request(
      'filesystem:operate',
      { action, sourcePath, targetDirectory },
      { timeout: OPERATION_TIMEOUT },
    )

  const copyEntry = (sourcePath, targetDirectory) =>
    operate('copy', sourcePath, targetDirectory)

  const moveEntry = (sourcePath, targetDirectory) =>
    operate('move', sourcePath, targetDirectory)

  const createSymbolicLink = (sourcePath, targetDirectory) =>
    operate('link', sourcePath, targetDirectory)

  const deleteEntry = (sourcePath) => operate('delete', sourcePath)

  return {
    copyEntry,
    moveEntry,
    createSymbolicLink,
    deleteEntry,
  }
}
