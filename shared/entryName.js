export const entryNameError = (name) => {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..') {
    return 'Enter a file or folder name'
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) {
    return 'The name cannot contain slashes or control characters'
  }
  return ''
}

// A name listed by a remote server must be one safe path component before it
// is joined to a path (the native `validate_entry_name`): not empty, `.` or
// `..`, at most 1024 bytes, without separators or control characters.
export const unsafeEntryName = (name) => typeof name !== 'string' || !name || name === '.' || name === '..'
  || new TextEncoder().encode(name).length > 1024 || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(name)
