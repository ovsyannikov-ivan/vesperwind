import { normalizeFormatting } from '../../../shared/editorFormatting.js'
import { getFormattingParser } from './parsers.js'

// Explicit imports let Vite bundle every parser offline, without arbitrary paths.
const loaders = {
  babel: () => import('prettier/plugins/babel'), estree: () => import('prettier/plugins/estree'),
  typescript: () => import('prettier/plugins/typescript'), html: () => import('prettier/plugins/html'),
  postcss: () => import('prettier/plugins/postcss'), markdown: () => import('prettier/plugins/markdown'),
  yaml: () => import('prettier/plugins/yaml'),
}
const required = {
  babel: ['babel', 'estree', 'html', 'postcss'], typescript: ['typescript', 'estree', 'html', 'postcss'],
  vue: ['html', 'babel', 'typescript', 'estree', 'postcss'], json: ['babel', 'estree'],
  html: ['html', 'babel', 'typescript', 'estree', 'postcss'], css: ['postcss'], scss: ['postcss'],
  markdown: ['markdown', 'babel', 'typescript', 'estree', 'html', 'postcss', 'yaml'], yaml: ['yaml'],
}
const plugins = new Map()
const loadPlugin = (id) => {
  if (!plugins.has(id)) plugins.set(id, loaders[id]().catch((error) => { plugins.delete(id); throw error }))
  return plugins.get(id)
}

export const formatText = async ({ text, fileName, settings, cursorOffset = -1 }) => {
  const parser = getFormattingParser(fileName)
  if (!parser) return { text, cursorOffset, supported: false }
  const prettier = await import('prettier/standalone')
  const { formatOnSave: _unused, ...options } = normalizeFormatting(settings)
  const loaded = await Promise.all(required[parser].map(loadPlugin))
  const result = await prettier.formatWithCursor(text, { ...options, parser, plugins: loaded, cursorOffset })
  return { text: result.formatted, cursorOffset: result.cursorOffset, supported: true }
}
