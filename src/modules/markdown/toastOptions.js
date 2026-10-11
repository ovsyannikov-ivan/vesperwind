// Options shared by the editor and the Quick Look viewer. Usage statistics are
// off: TOAST UI would otherwise report the host name to Google Analytics.
export const markdownRenderingOptions = Object.freeze({
  usageStatistics: false,
  frontMatter: true,
  referenceDefinition: true,
  extendedAutolinks: false,
})

// The parser options TOAST UI itself passes to ToastMark for these settings.
export const markdownParserOptions = Object.freeze({
  disallowedHtmlBlockTags: ['br', 'img'],
  disallowDeepHeading: true,
  frontMatter: markdownRenderingOptions.frontMatter,
  referenceDefinition: markdownRenderingOptions.referenceDefinition,
  extendedAutolinks: markdownRenderingOptions.extendedAutolinks,
})
