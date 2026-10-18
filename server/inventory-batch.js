import crypto from 'node:crypto'

const invalid = message => Object.assign(new Error(message), { status: 400 })
export function cleanInventoryBatch(body, key) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key || '')) throw invalid('Falta la referencia del lote. Vuelve a abrir el formulario.')
  if (!['stock_in', 'adjustment'].includes(body.type) || !Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw invalid('Selecciona entre 1 y 200 productos.')
  const seen = new Set()
  const items = body.items.map(line => {
    const quantity = Number(line.quantity), expectedQuantity = Number(line.expectedQuantity)
    if (!/^[0-9a-f-]{36}$/i.test(line.itemId || '') || seen.has(line.itemId)) throw invalid('El lote contiene productos inválidos o repetidos.')
    if (typeof line.quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0 || quantity > 1000000 || Math.abs(quantity * 100 - Math.round(quantity * 100)) > .00001 || (body.type === 'stock_in' && quantity === 0)) throw invalid('Ingresa cantidades válidas, con hasta dos decimales.')
    if (body.type === 'adjustment' && (typeof line.expectedQuantity !== 'number' || !Number.isFinite(expectedQuantity) || expectedQuantity < 0)) throw invalid('Falta el saldo de referencia del conteo.')
    seen.add(line.itemId)
    return { itemId: line.itemId, quantity, ...(body.type === 'adjustment' ? { expectedQuantity } : {}) }
  }).sort((a, b) => a.itemId.localeCompare(b.itemId))
  const batch = { type: body.type, note: String(body.note || '').trim().slice(0, 300), items }
  return { ...batch, key: key.toLowerCase(), fingerprint: crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex') }
}

export function inventoryBatchChanges(items, batch) {
  const byId = new Map(items.map(item => [item.id, item]))
  return batch.items.map(line => {
    const item = byId.get(line.itemId)
    if (!item) throw Object.assign(new Error('Un producto ya no existe. Actualiza el inventario.'), { status: 409, code: 'STOCK_CHANGED' })
    if (batch.type === 'adjustment' && Number(item.quantity) !== line.expectedQuantity) throw Object.assign(new Error(`Cambió el stock de ${item.name}. Revisa el conteo antes de guardar.`), { status: 409, code: 'STOCK_CHANGED' })
    const next = Math.round((batch.type === 'stock_in' ? Number(item.quantity) + line.quantity : line.quantity) * 100) / 100
    return { item, next, delta: Math.round((next - Number(item.quantity)) * 100) / 100 }
  })
}
