export const DEFAULT_FORMATTING = Object.freeze({
  formatOnSave: false, printWidth: 100, tabWidth: 2, useTabs: false,
  semi: true, singleQuote: false, bracketSpacing: true,
  trailingComma: 'all', arrowParens: 'always', endOfLine: 'auto',
})

export const normalizeFormatting = (value) => Object.fromEntries(
  Object.entries(DEFAULT_FORMATTING).map(([key, fallback]) => {
    const candidate = value?.[key]
    const valid = typeof fallback === 'boolean' ? typeof candidate === 'boolean'
      : key === 'printWidth' ? Number.isInteger(candidate) && candidate >= 40 && candidate <= 300
        : key === 'tabWidth' ? Number.isInteger(candidate) && candidate >= 1 && candidate <= 8
          : ({ trailingComma: ['all', 'es5', 'none'], arrowParens: ['always', 'avoid'],
            endOfLine: ['lf', 'crlf', 'cr', 'auto'] })[key]?.includes(candidate)
    return [key, valid ? candidate : fallback]
  }),
)
