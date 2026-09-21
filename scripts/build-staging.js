import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import { APP_VERSION } from '../shared/appMetadata.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDirectory = path.join(projectRoot, 'dist')
const stagingDirectory = path.join(projectRoot, 'staging')
const stagingAssetsDirectory = path.join(stagingDirectory, 'assets')
const webAssetsDirectory = path.join(stagingAssetsDirectory, 'web')
const nativeAssetsDirectory = path.join(stagingAssetsDirectory, 'native')
const nodePtyDirectory = path.join(projectRoot, 'node_modules', 'node-pty')

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.eot': 'application/vnd.ms-fontobject',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const walkFiles = async (directory, baseDirectory = directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === '.DS_Store') {
      continue
    }

    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...await walkFiles(entryPath, baseDirectory))
    } else if (entry.isFile()) {
      files.push(path.relative(baseDirectory, entryPath))
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

const copyNativeAssets = async () => {
  if (process.platform !== 'darwin') {
    throw new Error('The current staging builder supports macOS targets only')
  }

  const prebuildDirectory = path.join(
    nodePtyDirectory,
    'prebuilds',
    `${process.platform}-${process.arch}`,
  )

  await fs.mkdir(nativeAssetsDirectory, { recursive: true })
  await Promise.all([
    fs.copyFile(
      path.join(prebuildDirectory, 'pty.node'),
      path.join(nativeAssetsDirectory, 'pty.node'),
    ),
    fs.copyFile(
      path.join(prebuildDirectory, 'spawn-helper'),
      path.join(nativeAssetsDirectory, 'spawn-helper'),
    ),
  ])
  await fs.chmod(path.join(nativeAssetsDirectory, 'spawn-helper'), 0o755)
}

const createWebManifest = async () => {
  const files = await walkFiles(webAssetsDirectory)
  const manifest = {
    files: Object.fromEntries(
      files.map((relativePath) => {
        const urlPath = `/${relativePath.split(path.sep).join('/')}`
        const extension = path.extname(relativePath).toLocaleLowerCase()

        return [
          urlPath,
          {
            key: `web/${relativePath.split(path.sep).join('/')}`,
            contentType: contentTypes[extension] || 'application/octet-stream',
            immutable: urlPath.startsWith('/assets/'),
          },
        ]
      }),
    ),
  }

  await fs.writeFile(
    path.join(webAssetsDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

const nodePtyUtilsPlugin = {
  name: 'vesperwind-node-pty-native-loader',
  setup(build) {
    build.onLoad({ filter: /node-pty\/lib\/utils\.js$/ }, () => ({
      loader: 'js',
      contents: `
        "use strict";
        const path = require("node:path");
        exports.assign = (target, ...sources) => {
          for (const source of sources) {
            for (const key of Object.keys(source)) target[key] = source[key];
          }
          return target;
        };
        exports.loadNativeModule = (name) => {
          const directory = process.env.VESPERWIND_PTY_PREBUILD_DIR;
          if (!directory) throw new Error("Vesperwind PTY assets are not prepared");
          const nativeModule = { exports: {} };
          process.dlopen(nativeModule, path.join(directory, name + ".node"));
          return {
            dir: directory,
            module: nativeModule.exports,
          };
        };
      `,
    }))
  },
}

// ssh2 uses cpu-features only as an optional cipher-ordering accelerator.
// SEA must stay free of an additional platform-specific native addon.
const sshCpuFeaturesFallbackPlugin = {
  name: 'vesperwind-ssh-cpu-features-fallback',
  setup(build) {
    build.onResolve({ filter: /^cpu-features$/ }, () => ({
      path: 'cpu-features-fallback',
      namespace: 'vesperwind',
    }))
    build.onLoad({ filter: /.*/, namespace: 'vesperwind' }, () => ({
      loader: 'js',
      contents: 'module.exports = () => undefined;',
    }))
  },
}

const createSeaConfig = async () => {
  const assetFiles = await walkFiles(stagingAssetsDirectory)
  const assets = Object.fromEntries(
    assetFiles.map((relativePath) => [
      relativePath.split(path.sep).join('/'),
      `assets/${relativePath.split(path.sep).join('/')}`,
    ]),
  )
  const config = {
    main: 'app.cjs',
    output: 'vesperwind',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets,
  }

  await fs.writeFile(
    path.join(stagingDirectory, 'sea-config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  )
}

const buildStaging = async () => {
  await fs.rm(stagingDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
  await viteBuild({
    build: {
      outDir: distDirectory,
      emptyOutDir: true,
    },
  })
  await fs.mkdir(stagingDirectory, { recursive: true })
  await fs.cp(distDirectory, webAssetsDirectory, { recursive: true })
  await copyNativeAssets()
  await createWebManifest()
  await esbuild({
    entryPoints: [path.join(projectRoot, 'server', 'production.js')],
    outfile: path.join(stagingDirectory, 'app.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22.13',
    sourcemap: false,
    minify: false,
    plugins: [nodePtyUtilsPlugin, sshCpuFeaturesFallbackPlugin],
  })
  await createSeaConfig()
  await fs.writeFile(
    path.join(stagingDirectory, 'staging-manifest.json'),
    `${JSON.stringify({
      name: 'vesperwind',
      version: APP_VERSION,
      platform: process.platform,
      architecture: process.arch,
      entry: 'app.cjs',
      seaConfig: 'sea-config.json',
    }, null, 2)}\n`,
  )
  await Promise.all([
    fs.rm(path.join(stagingDirectory, '.DS_Store'), { force: true }),
    fs.rm(path.join(stagingAssetsDirectory, '.DS_Store'), { force: true }),
    fs.rm(path.join(webAssetsDirectory, '.DS_Store'), { force: true }),
  ])

  console.log(`Vesperwind staging created at ${stagingDirectory}`)
}

await buildStaging()
