export const parseEditableFilesText = (value) =>
  typeof value === 'string'
    ? value.split(/[\s,;]+/).filter(Boolean)
    : []

export const isEditableFile = (fileName, editableFiles) => {
  if (typeof fileName !== 'string' || !Array.isArray(editableFiles)) {
    return false
  }

  const normalizedName = fileName.toLocaleLowerCase()

  return editableFiles.some((item) => {
    if (typeof item !== 'string') {
      return false
    }

    const rule = item.trim().toLocaleLowerCase()

    return Boolean(
      rule &&
        (normalizedName === rule ||
          (rule.startsWith('.') && normalizedName.endsWith(rule))),
    )
  })
}
