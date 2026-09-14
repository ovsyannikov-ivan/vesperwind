export const isVisibleFilesystemEntry = (entry, hiddenNameSuffixes = []) => {
  const normalizedName = entry?.name?.toLocaleLowerCase()

  if (!normalizedName) {
    return true
  }

  return !hiddenNameSuffixes.some((suffix) =>
    normalizedName.endsWith(suffix.toLocaleLowerCase()),
  )
}

export const filterVisibleFilesystemEntries = (entries, hiddenNameSuffixes = []) =>
  Array.isArray(entries)
    ? entries.filter((entry) => isVisibleFilesystemEntry(entry, hiddenNameSuffixes))
    : []
