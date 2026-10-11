// The WYSIWYG editor rebuilds Markdown from its own document model. Both texts
// are rendered with TOAST UI's Markdown renderer: a different result means the
// visual editor cannot represent part of the file. Formatting-only rewrites
// (list markers, emphasis characters, escapes) render the same and are allowed.
export const normalizeRenderedMarkdown = (html) => String(html)
  .replace(/\sdata-nodeid="\d+"/g, '')
  .replace(/>\s+</g, '><')
  .replace(/\s+/g, ' ')
  .trim()

export const visualEditingChangesMarkdown = (source, roundTrip, render) => {
  if (source.replace(/\n+$/, '') === roundTrip.replace(/\n+$/, '')) return false
  return normalizeRenderedMarkdown(render(source)) !== normalizeRenderedMarkdown(render(roundTrip))
}
