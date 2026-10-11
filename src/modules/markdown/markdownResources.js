// Relative images in a Markdown document point at files next to it on the same
// provider. The Markdown keeps the original reference; only the rendered <img>
// receives a prepared URL.
const schemePattern = /^[A-Za-z][A-Za-z\d+.-]*:/
const drivePattern = /^[A-Za-z]:[\\/]/
const sharePattern = /^\\\\[^\\]+\\[^\\]+/

const segments = (value) => value.split(/[\\/]+/).filter(Boolean)

export const resolveMarkdownResourcePath = (source, documentPath) => {
  const reference = String(source ?? '').trim()
  if (!reference || !documentPath || reference.startsWith('#') || reference.startsWith('//')) return null
  const driveReference = drivePattern.test(reference)
  if (!driveReference && schemePattern.test(reference)) return null
  let target = reference.split(/[?#]/, 1)[0]
  try { target = decodeURI(target) } catch { /* Keep a reference with stray % signs as written. */ }
  if (!target) return null

  const absolute = /^[\\/]/.test(target)
  let root
  let base
  if (driveReference) {
    root = `${target.slice(0, 2)}\\`
    base = []
    target = target.slice(3)
  } else if (drivePattern.test(documentPath)) {
    root = `${documentPath.slice(0, 2)}\\`
    base = absolute ? [] : segments(documentPath.slice(3)).slice(0, -1)
  } else if (sharePattern.test(documentPath)) {
    const [server, share, ...rest] = segments(documentPath)
    root = `\\\\${server}\\${share}\\`
    base = absolute ? [] : rest.slice(0, -1)
  } else {
    root = documentPath.startsWith('/') ? '/' : ''
    base = absolute ? [] : segments(documentPath).slice(0, -1)
  }

  const parts = [...base]
  for (const part of segments(target)) {
    if (part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  if (!parts.length) return null
  return root + parts.join(root.endsWith('\\') ? '\\' : '/')
}

// Rendered images are rewritten in place. ProseMirror ignores attribute changes
// on leaf nodes and serializes from its model, so Markdown never sees the URL.
export const createMarkdownImageResolver = ({ root, location, prepare }) => {
  const sources = new Map()
  let disposed = false

  const sourceFor = (path) => {
    const { providerId } = location()
    const key = JSON.stringify([providerId, path])
    if (!sources.has(key)) {
      sources.set(key, Promise.resolve()
        .then(() => prepare({ providerId, path }))
        .then((response) => response?.ok && response.source ? response.source : null, () => null))
    }
    return sources.get(key)
  }

  const resolveImage = async (image) => {
    const reference = image.getAttribute('src')
    if (reference === image.dataset.markdownResolved) return
    const path = resolveMarkdownResourcePath(reference, location().path)
    if (!path) return
    image.dataset.markdownReference = reference
    image.dataset.markdownResolved = reference
    image.classList.remove('markdown-image-missing')
    const source = await sourceFor(path)
    if (disposed || image.getAttribute('src') !== reference) return
    if (source) {
      image.dataset.markdownResolved = source
      image.src = source
    } else {
      markMissing(image)
    }
  }

  // The broken image keeps its alt text and the rest of the document readable.
  const markMissing = (image) => {
    image.classList.add('markdown-image-missing')
    image.title = `Image not found: ${image.dataset.markdownReference}`
  }
  const failed = (event) => {
    const image = event.target
    // Only the prepared URL counts; the relative reference itself never loads.
    const resolved = image?.dataset?.markdownResolved
    if (image?.tagName === 'IMG' && resolved && resolved !== image.dataset.markdownReference &&
      image.getAttribute('src') === resolved) markMissing(image)
  }

  const scan = (node = root) => {
    if (disposed || !node) return
    if (node.tagName === 'IMG') void resolveImage(node)
    node.querySelectorAll?.('img[src]').forEach((image) => { void resolveImage(image) })
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target)
      else record.addedNodes.forEach((node) => scan(node))
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  root.addEventListener('error', failed, true)
  scan()

  return {
    // A saved-as document resolves its relative images from the new folder.
    refresh: () => {
      sources.clear()
      root.querySelectorAll('img[data-markdown-reference]').forEach((image) => {
        delete image.dataset.markdownResolved
        image.setAttribute('src', image.dataset.markdownReference)
      })
    },
    dispose: () => {
      disposed = true
      observer.disconnect()
      root.removeEventListener('error', failed, true)
      sources.clear()
    },
  }
}

// Links in a document must never navigate the application window.
export const installMarkdownLinkGuard = (root) => {
  const block = (event) => {
    if (event.target?.closest?.('a[href]')) event.preventDefault()
  }
  root.addEventListener('click', block, true)
  root.addEventListener('auxclick', block, true)
  return () => {
    root.removeEventListener('click', block, true)
    root.removeEventListener('auxclick', block, true)
  }
}
