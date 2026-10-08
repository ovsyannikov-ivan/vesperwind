import { EDITOR_THEMES as catalog } from '../../../shared/editorThemeCatalog.js'
import { withTokenCompatibility } from './compatibility.js'
const loaders = {
  'vesperwind-dark-2026': async () => {
    const [{ dark2026Theme }, { htmlTokenRules }, { monarchTokenRules }] = await Promise.all([
      import('./dark2026.js'), import('./htmlTokens.js'), import('./monarchTokens.js'),
    ])
    return { ...dark2026Theme, rules: [...dark2026Theme.rules, ...htmlTokenRules, ...monarchTokenRules] }
  },
  'one-dark-pro': () => import('./bundled/one-dark-pro.js').then((m) => m.default),
  dracula: () => import('./bundled/dracula.js').then((m) => m.default),
  nord: () => import('./bundled/nord.js').then((m) => m.default),
  'night-owl': () => import('./bundled/night-owl.js').then((m) => m.default),
  monokai: () => import('./bundled/monokai.js').then((m) => m.default),
  'monokai-bright': () => import('./bundled/monokai-bright.js').then((m) => m.default),
  'github-dark': () => import('./bundled/github-dark.js').then((m) => m.default),
  'github-light': () => import('./bundled/github-light.js').then((m) => m.default),
  'solarized-dark': () => import('./bundled/solarized-dark.js').then((m) => m.default),
  'solarized-light': () => import('./bundled/solarized-light.js').then((m) => m.default),
  'oceanic-next': () => import('./bundled/oceanic-next.js').then((m) => m.default),
  cobalt2: () => import('./bundled/cobalt2.js').then((m) => m.default),
  'tomorrow-night': () => import('./bundled/tomorrow-night.js').then((m) => m.default),
  'tomorrow-night-eighties': () => import('./bundled/tomorrow-night-eighties.js').then((m) => m.default),
  zenburn: () => import('./bundled/zenburn.js').then((m) => m.default),
  'xcode-default': () => import('./bundled/xcode-default.js').then((m) => m.default),
}
export const editorThemes = Object.freeze(catalog.map((item) => Object.freeze({ ...item, loader: loaders[item.id] })))
export const resolveThemeId = (id, applicationTheme) => !loaders[id] || id === 'auto'
  ? applicationTheme === 'light' ? 'vs' : 'vesperwind-dark-2026' : id
const loaded = new Map()
const registered = new WeakMap()
export const loadEditorTheme = async (id) => {
  if (!loaders[id]) return null
  if (!loaded.has(id)) loaded.set(id, loaders[id]().then((theme) => id === 'vesperwind-dark-2026' ? theme : withTokenCompatibility(theme))
    .catch((error) => { loaded.delete(id); throw error }))
  return loaded.get(id)
}
export const applyEditorTheme = async (monaco, preference, applicationTheme, current = () => true) => {
  let id = resolveThemeId(preference, applicationTheme)
  if (id !== 'vs') {
    let theme
    try { theme = await loadEditorTheme(id) }
    catch { id = applicationTheme === 'light' ? 'vs' : 'vs-dark' }
    if (!current()) return
    if (theme) {
      try {
        if (!registered.has(monaco)) registered.set(monaco, new Set())
        const ids = registered.get(monaco)
        if (!ids.has(id)) { monaco.editor.defineTheme(id, theme); ids.add(id) }
      } catch { id = applicationTheme === 'light' ? 'vs' : 'vs-dark' }
    }
  }
  if (current()) {
    try { monaco.editor.setTheme(id) }
    catch { id = applicationTheme === 'light' ? 'vs' : 'vs-dark'; monaco.editor.setTheme(id) }
  }
  return id
}
