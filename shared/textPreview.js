export const TEXT_PREVIEW_MAX_BYTES = 3 * 1024 * 1024

// A strict decoder prevents binary payloads from masquerading as source files.
export const decodeTextPreview = (bytes) => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('Binary data')
    return text
  } catch {
    throw Object.assign(new Error('This file does not contain supported UTF-8 text.'), { code: 'ETEXT_BINARY' })
  }
}
