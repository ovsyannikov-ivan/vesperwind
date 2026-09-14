import { socket } from './socket.js'

const REQUEST_TIMEOUT = 15_000

export const request = (eventName, payload = {}, options = {}) =>
  new Promise((resolve) => {
    const timeout = options.timeout || REQUEST_TIMEOUT

    socket.timeout(timeout).emit(eventName, payload, (timeoutError, response) => {
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
