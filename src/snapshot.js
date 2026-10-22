// JSON responses are immutable. Reuse equal branches, including rows moved by sorting.
export function shareSnapshot(previous, next) {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next
  const array = Array.isArray(next)
  const keys = Object.keys(next)
  const byId = array && previous.every(row => row && typeof row.id === 'string')
    ? new Map(previous.map(row => [row.id, row])) : null
  let equal = Object.keys(previous).length === keys.length
  const result = array ? [] : {}
  for (const key of keys) {
    const old = byId && next[key]?.id ? byId.get(next[key].id) : previous[key]
    result[key] = shareSnapshot(old, next[key])
    if (!Object.hasOwn(previous, key) || result[key] !== previous[key]) equal = false
  }
  return equal ? previous : result
}
