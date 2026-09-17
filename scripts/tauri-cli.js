import { createRequire } from 'node:module'

export const resolveTauriCli = (parentUrl = import.meta.url) =>
  createRequire(parentUrl).resolve('@tauri-apps/cli/tauri.js')
