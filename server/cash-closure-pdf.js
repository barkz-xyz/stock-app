import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const ink = rgb(.18, .17, .16), muted = rgb(.43, .40, .37), accent = rgb(.65, .37, .27), line = rgb(.86, .83, .80)
const money = value => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(value || 0)
const clean = value => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?')

export async function createCashClosurePdf(closure) {
  const doc = await PDFDocument.create()
  doc.setTitle(`Cierre de caja ${closure.businessDate} - Bakery POS`)
  doc.setAuthor('Bakery POS')
  doc.setSubject(`Cierre guardado, versión ${closure.revision}. Montos en pesos chilenos.`)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const time = value => new Intl.DateTimeFormat('es-CL', { timeZone: closure.snapshot.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  let page, y
  const text = (value, x, size = 10, weight = font, color = ink, yy = y) => page.drawText(clean(value), { x, y: yy, size, font: weight, color })
  const newPage = () => {
    page = doc.addPage([595.28, 841.89]); y = 790
    text('BAKERY POS', 40, 12, bold, accent)
    text(`CIERRE DE CAJA / ${closure.businessDate} / V${closure.revision}`, 285, 8, font, muted)
    page.drawLine({ start: { x: 40, y: 775 }, end: { x: 555, y: 775 }, thickness: .7, color: line })
    y = 750
  }
  const ensure = height => { if (y - height < 55) newPage() }
  const wrap = (value, width, size, weight = font) => {
    const words = clean(value).split(/\s+/), lines = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (weight.widthOfTextAtSize(candidate, size) <= width) { current = candidate; continue }
      if (current) { lines.push(current); current = '' }
      let part = ''
      for (const char of word) {
        if (weight.widthOfTextAtSize(part + char, size) > width) { lines.push(part); part = '' }
        part += char
      }
      current = part
    }
    if (current) lines.push(current)
    return lines.length ? lines : ['-']
  }
  const paragraph = (value, size = 9, color = muted) => {
    for (const row of wrap(value, 515, size)) { ensure(15); text(row, 40, size, font, color); y -= 14 }
    y -= 5
  }
  const heading = value => { ensure(55); y -= 10; text(value, 40, 12, bold, accent); y -= 24 }
  const row = (label, value, strong = false) => {
    ensure(20)
    text(label, 48, 9, strong ? bold : font)
    const rendered = clean(value)
    text(rendered, 547 - (strong ? bold : font).widthOfTextAtSize(rendered, 10), 10, strong ? bold : font)
    y -= 20
  }
  newPage()
  text('Cierre del día', 40, 24, bold); y -= 30
  paragraph(`${closure.businessDate} | ${closure.snapshot.timeZone} | Montos en CLP`)
  paragraph(`Responsable declarado: ${closure.operator || '-'} | Guardado: ${time(closure.closedAt)}`)
  paragraph(`Identificador: ${closure.id} | Versión ${closure.revision}`)
  paragraph('Fotografía de las operaciones al guardar el cierre. Los cambios posteriores requieren una nueva versión. El responsable se registra de forma declarativa.')
  const s = closure.snapshot
  heading('Resumen de ventas y devoluciones')
  row(`Ventas cobradas (${s.transactions} operaciones)`, money(s.gross))
  row(`Devoluciones procesadas (${s.cash.refundCount + s.card.refundCount})`, money(-s.refunds))
  row('Total neto del día', money(s.net), true)
  heading('01 / Efectivo')
  row('Fondo inicial', money(closure.openingCash))
  row(`Ventas en efectivo (${s.cash.transactions})`, money(s.cash.gross))
  row(`Devoluciones en efectivo (${s.cash.refundCount})`, money(-s.cash.refunds))
  row('Entradas adicionales', money(closure.cashIn))
  row('Retiros / salidas', money(-closure.cashOut))
  row('Efectivo esperado', money(closure.expectedCash), true)
  row('Efectivo contado', money(closure.countedCash), true)
  row('Diferencia de efectivo (contado - esperado)', money(closure.difference), true)
  if (closure.denominations) {
    paragraph('Desglose: ' + Object.entries(closure.denominations).filter(([, count]) => count > 0).sort((a, b) => b[0] - a[0]).map(([value, count]) => `${money(Number(value))} x ${count}`).join(' / '))
  }
  heading('02 / Tarjetas y terminal')
  row(`Ventas aprobadas (${s.card.transactions})`, money(s.card.gross))
  row(`Devoluciones por tarjeta (${s.card.refundCount})`, money(-s.card.refunds))
  row('Total esperado del terminal, antes de comisiones', money(s.card.net), true)
  row('Total declarado del terminal', money(closure.countedCard), true)
  row('Diferencia de tarjeta (declarado - esperado)', money(closure.cardDifference), true)
  paragraph(`Referencia del terminal: ${closure.terminalReference || 'No informada'}`)
  paragraph(`Comisiones registradas: ${money(s.card.recordedFees)}. Neto informado por proveedor: ${money(s.card.recordedSettlement)}. Cobros con liquidación informada: ${s.card.reconciledTransactions}; sin información: ${s.card.unreconciledTransactions}. Estos datos pueden ser parciales y no acreditan un abono bancario. No se descuentan del arqueo del terminal.`)
  heading('Observaciones y control')
  paragraph(closure.note || 'Sin observaciones.', 10, ink)
  paragraph(`Operaciones pendientes excluidas: ${s.pendingCount}. Operaciones no cobradas o devoluciones no procesadas: ${s.excluded.length}. Las devoluciones se asignan al día de procesamiento, aunque la venta sea de un día anterior.`)
  // Start the ledger on a clean page; all line items remain searchable/selectable.
  newPage()
  heading(`Detalle de operaciones (${s.operations.length})`)
  if (!s.operations.length) paragraph('No hay ventas cobradas ni devoluciones procesadas en este día.')
  for (const op of s.operations) {
    ensure(78)
    const title = `${op.type === 'refund' ? 'DEVOLUCIÓN' : 'VENTA'} ${op.shortId} / ${op.method === 'cash' ? 'EFECTIVO' : 'TARJETA'}`
    text(title, 40, 10, bold)
    text(money(op.amount), 555 - bold.widthOfTextAtSize(clean(money(op.amount)), 10), 10, bold)
    y -= 17
    paragraph(`${time(op.at)} | ID: ${op.id}`, 8)
    if (op.reference || op.terminal || op.cardBrand) paragraph(`Referencia: ${op.reference || '-'} | Terminal: ${op.terminal || '-'}${op.cardBrand ? ` | ${op.cardBrand} ****${op.cardLastFour}` : ''}`, 8)
    if (op.type === 'refund') paragraph(`Venta original: ${time(op.originalSaleAt)} | Motivo: ${op.reason || '-'}`, 8)
    for (const item of op.items) {
      const rows = wrap(`${item.quantity} x ${item.name} / Unitario ${money(item.unitPrice)} / Total ${money(item.lineTotal)}`, 495, 9)
      for (const lineText of rows) { ensure(16); text(lineText, 50, 9); y -= 14 }
    }
    if (!op.items.length) paragraph('Sin desglose de productos registrado.', 8)
    if (op.type === 'sale' && op.method === 'card') paragraph(op.settlement == null ? 'Liquidación del proveedor sin informar.' : `Comisión registrada: ${money(op.fee)} | Neto informado: ${money(op.settlement)}`, 8)
    y -= 10
  }
  if (s.excluded.length) {
    heading('Operaciones excluidas del total cobrado')
    for (const op of s.excluded) paragraph(`${time(op.at)} | ${op.type === 'refund' ? 'Devolución' : 'Venta'} ${op.shortId} | ${op.method === 'cash' ? 'Efectivo' : 'Tarjeta'} | ${op.status} | ${money(op.amount)} | ${op.id}`, 8)
  }
  const pages = doc.getPages()
  pages.forEach((p, index) => {
    page = p
    text(`Bakery POS | Cierre ${closure.businessDate} | V${closure.revision}`, 40, 8, font, muted, 30)
    text(`${index + 1} / ${pages.length}`, 520, 8, font, muted, 30)
  })
  // pdf-lib Flate-compresses content streams; object streams also compress the document structure.
  // Standard PDF fonts and vector elements avoid image/font payloads and retain editable source data.
  const bytes = await doc.save({ useObjectStreams: true, objectsPerTick: 50, addDefaultPage: false })
  return Buffer.from(bytes)
}
