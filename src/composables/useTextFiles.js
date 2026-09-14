import { request } from '../socket/request.js'

export const useTextFiles = () => {
  const readTextFile = (filePath, filesystemId = 'local') =>
    request('filesystem:read-text', {
      filesystemId,
      path: filePath,
    })

  const writeTextFile = (filePath, content, filesystemId = 'local') =>
    request(
      'filesystem:write-text',
      {
        filesystemId,
        path: filePath,
        content,
      },
      { timeout: 30_000 },
    )

  return { readTextFile, writeTextFile }
}
