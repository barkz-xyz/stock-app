export const cashDenominations = [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 10]

// Keep zero as an empty input with a placeholder. The first digit typed is the
// count itself, regardless of where a previous caret was positioned.
export function cashCountText(value) {
  const text = String(value ?? '')
  if (!/^\d*$/.test(text)) return null
  const normalized = text.replace(/^0+/, '')
  return Number(normalized) <= 1000000 ? normalized : null
}
export const cashCountTotal = values => cashDenominations.reduce((sum, value) => sum + value * Number(values?.[value] || 0), 0)
export const cashCountNumbers = values => Object.fromEntries(cashDenominations.map(value => [value, Number(values?.[value] || 0)]))
export function cleanCashCount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !cashDenominations.map(String).includes(key))) throw new Error('Desglose de billetes y monedas inválido.')
  return Object.fromEntries(cashDenominations.map(denomination => {
    const count = value[denomination] ?? 0
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new Error('La cantidad de billetes y monedas debe ser un entero positivo o cero.')
    return [denomination, count]
  }))
}
