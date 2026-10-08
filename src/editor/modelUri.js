// Provider IDs are opaque identifiers, never connection URLs or credentials.
// Keep the path unescaped here: Monaco's URI serializer owns percent encoding.
export const editorModelLocation = ({ filesystemId = 'local', filePath }) => {
  let path = String(filePath)
  let authority = ''
  if (filesystemId !== 'local') {
    authority = `p-${Array.from(new TextEncoder().encode(filesystemId), byte => byte.toString(16).padStart(2, '0')).join('')}`
  } else if (/^[a-z]:[\\/]/i.test(path)) {
    path = `/${path[0].toUpperCase()}${path.slice(1).replaceAll('\\', '/')}`
  } else if (path.startsWith('\\\\')) {
    const [host, ...segments] = path.slice(2).split('\\')
    authority = host.toLowerCase()
    path = `/${segments.join('/')}`
  }
  if (!path.startsWith('/')) path = `/${path}`
  return { scheme: filesystemId === 'local' ? 'file' : 'vesperwind', authority, path }
}

export const editorModelUri = (monaco, tab) => monaco.Uri.from(editorModelLocation(tab))
