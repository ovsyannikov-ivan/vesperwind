// Monaco's HTML Monarch grammar emits these token names. The imported VS Code
// theme mainly uses TextMate scopes, which do not color Monarch HTML tokens.
export const htmlTokenRules = [
  { token: 'delimiter.html', foreground: '808080' },
  { token: 'tag.html', foreground: '569CD6' },
  { token: 'attribute.name.html', foreground: '9CDCFE' },
  { token: 'string.html', foreground: 'CE9178' },
  { token: 'metatag.html', foreground: '569CD6' },
  { token: 'metatag.content.html', foreground: '9CDCFE' },
]
