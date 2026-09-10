import { socket } from '../socket/socket.js'

const REQUEST_TIMEOUT = 15_000

const request = (eventName, payload = {}) =>
  new Promise((resolve) => {
    socket.timeout(REQUEST_TIMEOUT).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) {
        resolve({
          ok: false,
          error: {
            code: 'ETIMEDOUT',
            message: 'The backend did not respond',
          },
        })
        return
      }

      resolve(response)
    })
  })

export const useFilesystem = () => {
  const getRoot = () => request('filesystem:root')
  const listDirectory = (directoryPath) =>
    request('filesystem:list', { path: directoryPath })

  return {
    getRoot,
    listDirectory,
  }
}
