export const calculatePdfOutputScale = (
  viewport,
  maximumDpr,
  maximumPixels,
  devicePixelRatio = 1,
) => {
  const requestedDpr = Math.min(devicePixelRatio || 1, maximumDpr)
  const cssPixels = Math.max(1, viewport.width * viewport.height)

  return Math.min(requestedDpr, Math.sqrt(maximumPixels / cssPixels))
}

// PDF.js setLayerDimensions rounds its text layer down to CSS pixels.
export const getPdfCssPageSize = ({ width, height }) => ({
  width: Math.max(1, Math.floor(width)),
  height: Math.max(1, Math.floor(height)),
})

// PDF.js TextLayer and setLayerDimensions use these CSS variables to map PDF
// coordinates to CSS pixels. The canvas output scale is intentionally absent.
export const setPdfTextLayerViewport = (container, viewport) => {
  container.style.setProperty('--scale-factor', viewport.scale)
  container.style.setProperty('--user-unit', viewport.userUnit)
  container.style.setProperty(
    '--total-scale-factor',
    'calc(var(--scale-factor) * var(--user-unit))',
  )
  container.style.setProperty('--scale-round-x', '1px')
  container.style.setProperty('--scale-round-y', '1px')
}
