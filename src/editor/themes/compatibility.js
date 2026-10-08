const luminance = (hex) => {
  const color = hex.replace('#', '')
  const rgb = color.length === 3 ? [...color].map((c) => c + c).join('') : color
  return [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
}
export const contrastRatio = (a, b) => {
  const left = luminance(a), right = luminance(b)
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}
const tokenColor = (value) => {
  const color = value.replace('#', '')
  return [3, 4].includes(color.length) ? [...color].map((c) => c + c).join('') : color
}
const scopes = {
  keyword: ['keyword', 'keyword.control', 'storage.type', 'storage'],
  string: ['string', 'string.quoted', 'string.quoted.single'],
  number: ['number', 'constant.numeric'], comment: ['comment', 'comment.line', 'comment.block'],
  identifier: ['identifier', 'variable.other'],
  'keyword.import': ['keyword.import', 'keyword', 'keyword.control', 'storage'],
  'keyword.declaration': ['keyword.declaration', 'storage.type', 'keyword', 'storage'],
  constant: ['constant', 'constant.language', 'number'], function: ['function', 'entity.name.function', 'support.function'],
  variable: ['variable', 'variable.other', 'identifier'],
  tag: ['tag', 'entity.name.tag'], 'attribute.name': ['attribute.name', 'entity.other.attribute-name', 'key'],
  'attribute.value': ['attribute.value', 'string'], 'delimiter.html': ['delimiter', 'punctuation'],
  'string.vue': ['string', 'string.quoted'], 'type.python': ['type', 'type.identifier', 'entity.name.type'],
}
export const withTokenCompatibility = (theme) => {
  const dark = theme.base !== 'vs'
  const background = theme.colors['editor.background'] || (dark ? '#1e1e1e' : '#ffffff')
  const foreground = theme.colors['editor.foreground'] || (dark ? '#d4d4d4' : '#000000')
  const safe = (color) => color && contrastRatio(color, background) >= 4.5 ? color.replace('#', '')
    : contrastRatio(foreground, background) >= 4.5 ? foreground.replace('#', '') : dark ? 'FFFFFF' : '000000'
  const rules = Object.entries(scopes).map(([token, candidates]) => {
    const rule = candidates.map((candidate) => [...theme.rules].reverse().find((item) => item.token === candidate && item.foreground)).find(Boolean)
    return { token, foreground: safe(rule?.foreground), ...(rule?.fontStyle ? { fontStyle: rule.fontStyle } : {}) }
  })
  return { ...theme, colors: Object.fromEntries(Object.entries(theme.colors)
    .filter(([, color]) => typeof color === 'string')
    .map(([key, color]) => [key, color.startsWith('#') ? `#${tokenColor(color)}` : color])), rules: [...theme.rules, ...rules].map((rule) => ({ ...rule,
    ...(rule.foreground ? { foreground: tokenColor(rule.foreground) } : {}),
    ...(rule.background ? { background: tokenColor(rule.background) } : {}),
  })) }
}
