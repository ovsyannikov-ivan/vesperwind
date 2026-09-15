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
