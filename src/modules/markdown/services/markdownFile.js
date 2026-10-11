import { markRaw } from 'vue'
import { filesystem } from '../../../api/filesystem.js'
import { describeMarkdownText } from '../markdownText.js'
import { getMarkdownRuntime } from '../runtime.js'

// The same limit as the text editor.
export const MARKDOWN_MAX_BYTES = 10 * 1024 * 1024

const failure = (code, message) => ({ ok: false, error: { code, message } })

// Bytes are decoded here rather than by the text API: a file that is not valid
// UTF-8 is refused instead of being rewritten with replacement characters on
// save, and a byte order mark stays in the text so Save writes it back.
export const decodeMarkdown = (bytes) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

export const loadMarkdown = async (tab, { signal, onStatus } = {}, io = filesystem) => {
  const response = await io.readBinary({ providerId: tab.filesystemId, path: tab.filePath }, { signal, onStatus })
  if (!response.ok) return response
  if (signal?.aborted) return failure('ECANCELLED', 'Opening was cancelled')
  if (response.bytes.byteLength > MARKDOWN_MAX_BYTES) {
    return failure('EFILE_TOO_LARGE', 'Files larger than 10 MB cannot be opened in the editor')
  }
  let content
  try {
    content = decodeMarkdown(response.bytes)
  } catch {
    return failure('ETEXT_ENCODING', 'This Markdown file is not UTF-8 text. It was not opened, so saving cannot damage it.')
  }
  tab.content = content
  tab.savedContent = content
  tab.textFormat = markRaw(describeMarkdownText(content))
  tab.modifiedAt = response.modifiedAt
  return { ok: true }
}

// The editor serializes only when there are edits; an untouched document keeps
// the exact text that was read, so Save As copies it unchanged.
export const flushMarkdown = (tab, runtimeOf = getMarkdownRuntime) => {
  runtimeOf(tab.id)?.flush()
  tab.savingRevision = tab.revision
}

export const saveMarkdown = (tab, { writeTextFile, destination }) =>
  writeTextFile(destination?.path || tab.filePath, tab.content, destination?.providerId || tab.filesystemId)

export const markdownSaved = (tab, content, runtimeOf = getMarkdownRuntime) => {
  tab.savedContent = content
  tab.dirty = tab.revision !== tab.savingRevision || tab.content !== content
  if (!tab.dirty) runtimeOf(tab.id)?.markSaved()
}
