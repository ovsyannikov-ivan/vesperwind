import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getRawAsset, isSea } from 'node:sea'
import { APP_VERSION } from '../shared/appMetadata.js'

const writeEmbeddedAsset = async (assetKey, destinationPath, mode) => {
  const content = Buffer.from(getRawAsset(assetKey))

  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await fs.writeFile(destinationPath, content, { mode })
  await fs.chmod(destinationPath, mode)
}

const prepareSeaNativeAssets = async () => {
  const runtimeDirectory = path.join(
    os.tmpdir(),
    `vesperwind-${APP_VERSION}-${process.platform}-${process.arch}`,
  )

  await Promise.all([
    writeEmbeddedAsset(
      'native/pty.node',
      path.join(runtimeDirectory, 'pty.node'),
      0o600,
    ),
    writeEmbeddedAsset(
      'native/spawn-helper',
      path.join(runtimeDirectory, 'spawn-helper'),
      0o700,
    ),
  ])

  process.env.VESPERWIND_PTY_PREBUILD_DIR = runtimeDirectory
}

export const prepareRuntimeAssets = async () => {
  process.env.NODE_ENV = 'production'

  if (isSea()) {
    await prepareSeaNativeAssets()
    return
  }

  const stagingAssets = path.join(__dirname, 'assets')
  process.env.VESPERWIND_WEB_ASSETS_DIR = path.join(stagingAssets, 'web')
  process.env.VESPERWIND_PTY_PREBUILD_DIR = path.join(stagingAssets, 'native')
}
