// '*' consumes zero or more Unicode code points; '?' consumes exactly one.
// Greedy matching avoids treating a user pattern as executable regular expression.
export const wildcardMatch = (value, query) => {
  const text = Array.from(String(value).toLocaleLowerCase())
  const pattern = Array.from(String(query).toLocaleLowerCase())
  let cursor = 0
  let token = 0
  let star = -1
  let resumedAt = -1
  while (cursor < text.length) {
    if (token < pattern.length && (pattern[token] === '?' || pattern[token] === text[cursor])) {
      cursor++; token++
    } else if (token < pattern.length && pattern[token] === '*') {
      star = token++
      resumedAt = cursor
    } else if (star >= 0) {
      token = star + 1
      cursor = ++resumedAt
    } else return false
  }
  while (pattern[token] === '*') token++
  return token === pattern.length
}
