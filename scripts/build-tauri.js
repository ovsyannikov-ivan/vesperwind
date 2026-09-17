import { spawn } from 'node:child_process'

const cli = new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)
const child = spawn(process.execPath, [cli.pathname, 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Cargo reruns build.rs for every production bundle, so two binaries with
    // the same semantic version still have distinct runtime build identities.
    VESPERWIND_BUILD_NONCE: String(Date.now()),
  },
})

child.on('error', (error) => {
  console.error(`Unable to start the Tauri build: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Tauri build stopped by ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
