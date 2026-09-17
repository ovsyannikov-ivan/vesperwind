import { isSea } from 'node:sea'
import { APP_VERSION } from '../shared/appMetadata.js'

export const createRuntimeInfo = ({ sea = isSea() } = {}) => ({
  ok: true,
  runtime: 'node',
  mode: sea ? 'sea' : 'browser',
  isStandalone: sea,
  version: APP_VERSION,
  buildTimestamp: process.env.VESPERWIND_BUILD_TIMESTAMP || null,
  gitCommit: process.env.VESPERWIND_GIT_SHA || null,
})

export const registerRuntimeHandlers = (socket) => {
  socket.on('runtime:info', (_payload, acknowledge) => {
    acknowledge(createRuntimeInfo())
  })
}
