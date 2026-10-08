export const PERMISSION_ROWS = ['Owner', 'Group', 'Others']
export const PERMISSION_COLUMNS = ['Read', 'Write', 'Execute']
export const permissionMatrix = (mode) => [6, 3, 0].map((shift) => [4, 2, 1].map((bit) => Boolean((mode || 0) & (bit << shift))))
export const matrixMode = (matrix, original = 0) => matrix.reduce((mode, row, index) =>
  mode | row.reduce((bits, checked, column) => bits | (checked ? [4, 2, 1][column] << [6, 3, 0][index] : 0), 0), original & ~0o777)
export const modeOctal = (mode) => (mode & 0o7777).toString(8).padStart(3, '0')
// Four-digit input may display preserved special bits, but cannot change them.
export const parseOctal = (text, original = 0) => /^[0-7]{3,4}$/.test(text)
  && ((parseInt(text, 8) & 0o7000) === (text.length === 4 ? original & 0o7000 : 0))
  ? (original & ~0o777) | (parseInt(text, 8) & 0o777) : null
export const symbolicMode = (mode) => {
  const chars = permissionMatrix(mode).flatMap((row) => row.map((value, i) => value ? 'rwx'[i] : '-'))
  for (const [index, bit, lower, upper] of [[2, 0o4000, 's', 'S'], [5, 0o2000, 's', 'S'], [8, 0o1000, 't', 'T']]) {
    if (mode & bit) chars[index] = chars[index] === 'x' ? lower : upper
  }
  return chars.join('')
}
export const numericIdentity = (text) => /^\d+$/.test(String(text)) && Number(text) < 0xffffffff && Number.isSafeInteger(Number(text)) ? Number(text) : null
export const permissionChanges = (properties, draft) => {
  const old = properties?.permissions || {}, caps = properties?.capabilities || {}, result = {}
  for (const [field, capability] of [['mode', 'changeMode'], ['uid', 'changeOwner'], ['gid', 'changeGroup']]) {
    if (caps[capability] && draft[field] !== null && draft[field] !== old[field]) result[field] = field === 'mode' ? draft[field] & 0o7777 : draft[field]
  }
  return result
}
