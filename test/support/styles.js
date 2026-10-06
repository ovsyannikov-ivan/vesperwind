import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile } from 'sass'

const root = new URL('../../', import.meta.url)
const stylesRoot = fileURLToPath(new URL('src/styles', root))

/**
 * The CSS a stylesheet ships to the browser. SCSS sources are compiled the way
 * Vite compiles them, so tests assert on real selectors (nesting resolved).
 */
export const compiledStyles = (relativePath) => {
  const file = fileURLToPath(new URL(relativePath, root))
  return relativePath.endsWith('.scss')
    ? compile(file, { style: 'expanded', loadPaths: [stylesRoot] }).css
    : fs.readFileSync(file, 'utf8')
}
