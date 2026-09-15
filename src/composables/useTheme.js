import { readonly, ref } from 'vue'

const THEME_STORAGE_KEY = 'vesperwind:theme'
const VALID_THEMES = new Set(['system', 'dark', 'light'])
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const themePreference = ref('system')
const resolvedTheme = ref('dark')

const normalizeTheme = (value) =>
  VALID_THEMES.has(value) ? value : 'system'

const resolveTheme = (preference) =>
  preference === 'system'
    ? systemTheme.matches ? 'dark' : 'light'
    : preference

const applyResolvedTheme = () => {
  const nextTheme = resolveTheme(themePreference.value)
  resolvedTheme.value = nextTheme
  document.documentElement.setAttribute('data-bs-theme', nextTheme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    nextTheme === 'dark' ? '#202022' : '#f2f2f2',
  )
  window.dispatchEvent(new CustomEvent('vesperwind:theme-changed', {
    detail: { theme: nextTheme },
  }))
}

export const setThemePreference = (value) => {
  themePreference.value = normalizeTheme(value)
  localStorage.setItem(THEME_STORAGE_KEY, themePreference.value)
  applyResolvedTheme()
}

const cachedTheme = normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY))
themePreference.value = cachedTheme
applyResolvedTheme()

systemTheme.addEventListener('change', () => {
  if (themePreference.value === 'system') {
    applyResolvedTheme()
  }
})

export const useTheme = () => ({
  themePreference: readonly(themePreference),
  resolvedTheme: readonly(resolvedTheme),
  setThemePreference,
})
