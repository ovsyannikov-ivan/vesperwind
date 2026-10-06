// The single entry point for building the bundled libmpv runtime:
//
//   npm run build:libmpv               build, record evidence and verify
//   npm run build:libmpv -- --clean    discard the build cache first
//   npm run build:libmpv -- --dry-run  show platform, cache and mode only
//
// Platform builders and the pure decisions live in scripts/libmpv-build/.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BuildError, log, projectRoot, run, rustEnvironment } from './libmpv-build/common.js'
import { bootstrapPolicy, cacheDirectory, parseArguments, selectPlatform, usage } from './libmpv-build/options.js'

const summary = (platform) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src-tauri/vendor/libmpv/manifest.json'), 'utf8'))
  const entry = manifest[platform]
  const options = entry.requiredLibplaceboOptions || []
  return [
    '',
    'Vesperwind libmpv build completed successfully.',
    '',
    `Platform: ${platform === 'windows' ? 'Windows x64' : 'macOS arm64'}`,
    `mpv: ${manifest.mpvVersion}`,
    `libplacebo: ${manifest.dependencies.libplacebo.split(' ')[0]}`,
    `Dolby Vision processing: ${options.includes('-Ddovi=enabled') ? 'enabled' : 'disabled'}`,
    `libdovi: ${options.includes('-Dlibdovi=disabled') ? 'disabled' : 'enabled'}`,
    `Hardware decode: ${platform === 'windows' ? 'D3D11VA' : 'VideoToolbox'}`,
    'Bundle verification: passed',
  ].join('\n')
}

try {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage)
  } else {
    const platform = selectPlatform(process.env.VESPERWIND_LIBMPV_PLATFORM || process.platform)
    const policy = bootstrapPolicy(process.env, options)
    const cache = cacheDirectory(platform, process.env, os.homedir(), projectRoot)
    const { build } = await import(`./libmpv-build/${platform}.js`)
    if (options.dryRun) {
      console.log(JSON.stringify({ ...(await build({ cache, options, policy })), policy }, null, 2))
    } else {
      // The verifier compiles a small Rust probe; check it before hours of building.
      const verifierEnvironment = rustEnvironment()
      await build({ cache, options, policy })
      log('Verifying the bundle')
      await run(process.execPath, [path.join(projectRoot, 'scripts/verify-libmpv-bundle.js'), platform], {
        cwd: projectRoot, env: verifierEnvironment, failure: `The rebuilt ${platform} bundle did not pass verification; see the message above.`,
      })
      console.log(summary(platform))
    }
  }
} catch (error) {
  if (!(error instanceof BuildError)) throw error
  console.error(`\n${error.message}`)
  process.exitCode = 1
}
