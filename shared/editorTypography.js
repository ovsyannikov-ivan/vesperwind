import catalog from './editorTypography.json' with { type: 'json' }

export const EDITOR_FONTS = Object.freeze(catalog.fonts.map(font => Object.freeze({ ...font })))
export const DEFAULT_EDITOR_FONT_FAMILY = catalog.defaultFontFamily
export const DEFAULT_EDITOR_FONT_SIZE = catalog.defaultFontSize
export const MIN_EDITOR_FONT_SIZE = catalog.minFontSize
export const MAX_EDITOR_FONT_SIZE = catalog.maxFontSize
const fonts = new Map(EDITOR_FONTS.map(font => [font.id, font.family]))

export const normalizeEditorFontFamily = value => fonts.has(value) ? value : DEFAULT_EDITOR_FONT_FAMILY
export const isValidEditorFontSize = value => Number.isInteger(value)
  && value >= MIN_EDITOR_FONT_SIZE && value <= MAX_EDITOR_FONT_SIZE
export const normalizeEditorFontSize = value => isValidEditorFontSize(value) ? value : DEFAULT_EDITOR_FONT_SIZE

export const monacoTypographyOptions = editorSettings => {
  const id = normalizeEditorFontFamily(editorSettings?.fontFamily)
  const fallback = fonts.get(DEFAULT_EDITOR_FONT_FAMILY)
  return {
    fontFamily: id === DEFAULT_EDITOR_FONT_FAMILY ? fallback : `${fonts.get(id)}, ${fallback}`,
    // Match native editor sizes: one macOS point is one logical screen pixel.
    // The WebView handles Retina backing pixels; CSS's 96/72 conversion would
    // make the user's reference sizes a third too large.
    fontSize: normalizeEditorFontSize(editorSettings?.fontSize),
    lineHeight: 0, // Monaco derives line spacing from the selected font size.
  }
}
