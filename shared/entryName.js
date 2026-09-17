export const entryNameError = (name) => {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..') {
    return 'Enter a file or folder name'
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) {
    return 'The name cannot contain slashes or control characters'
  }
  return ''
}
