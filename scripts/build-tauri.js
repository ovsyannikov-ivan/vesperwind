import { spawn } from 'node:child_process'
import { resolveTauriCli } from './tauri-cli.js'
import { cleanupTauriDmg } from './cleanup-tauri-dmg.js'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  await cleanupTauriDmg({
    macosDirectory: fileURLToPath(new URL('../src-tauri/target/release/bundle/macos/', import.meta.url)),
  })
}

const cli = resolveTauriCli()
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const cliArgs = separator < 0 ? args : args.slice(0, separator)
const explicitBundles = cliArgs.some((arg) =>
  arg === '--bundles' || arg.startsWith('--bundles=') || /^-b(?:=|[^-]|$)/u.test(arg) || arg === '--no-bundle',
)
// Local macOS builds need the app, not Finder/AppleScript DMG layout. Packaging
// remains available through an explicit --bundles dmg (or app,dmg).
if (process.platform === 'darwin' && !explicitBundles) {
  args.splice(separator < 0 ? args.length : separator, 0, '--bundles', 'app')
}
const child = spawn(process.execPath, [cli, 'build', ...args], {
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
