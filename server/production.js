import { prepareRuntimeAssets } from './runtimeAssets.js'

const start = async () => {
  if (process.env.VESPERWIND_SQLITE_WORKER !== '1') await prepareRuntimeAssets()
  await import('./index.js')
}

start().catch((error) => {
  console.error(`Vesperwind failed to start: ${error.message}`)
  process.exitCode = 1
})
