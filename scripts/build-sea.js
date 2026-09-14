import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const [major, minor] = process.versions.node.split('.').map(Number)

if (major < 25 || (major === 25 && minor < 5)) {
  console.error('Vesperwind SEA build requires Node.js 25.5 or newer')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagingDirectory = path.join(projectRoot, 'staging')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

run(process.execPath, [path.join(projectRoot, 'scripts', 'build-staging.js')])
run(process.execPath, ['--build-sea', 'sea-config.json'], {
  cwd: stagingDirectory,
})

if (process.platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', path.join(stagingDirectory, 'vesperwind')])
}

console.log(`Vesperwind executable created at ${path.join(stagingDirectory, 'vesperwind')}`)
