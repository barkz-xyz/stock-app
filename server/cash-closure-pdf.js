import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const ink = rgb(.15, .16, .17), muted = rgb(.43, .44, .45), accent = rgb(.65, .37, .27)
const rule = rgb(.82, .83, .84), wash = rgb(.95, .95, .94)
const balanced = rgb(.92, .96, .93), unbalanced = rgb(.99, .93, .92)
const clean = value => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?')
const money = value => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Number(value) || 0)
const shortId = value => String(value || '').replaceAll('-', '').slice(0, 8).toUpperCase()
const sum = (rows, getValue) => rows.reduce((total, row) => total + getValue(row), 0)

export async function createCashClosurePdf(closure) {
  const s = closure.snapshot
  const doc = await PDFDocument.create()
  doc.setTitle(`Cierre de caja ${closure.businessDate} - Bakery POS`)
  doc.setAuthor('Bakery POS')
  doc.setSubject(`Ventas y cierre de caja. Versión ${closure.revision}. CLP.`)
  doc.setCreationDate(new Date(closure.closedAt))
  doc.setModificationDate(new Date(closure.closedAt))
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const dateTime = new Intl.DateTimeFormat('es-CL', { timeZone: s.timeZone, dateStyle: 'short', timeStyle: 'short' })
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: s.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const left = 36, right = 559.28, width = right - left, bottom = 48
  let page, y
  const draw = (value, x, atY, { size = 9, strong = false, color = ink, align = 'left' } = {}) => {
    const text = clean(value), font = strong ? bold : regular
    page.drawText(text, { x: align === 'right' ? x - font.widthOfTextAtSize(text, size) : x, y: atY, size, font, color })
  }
  const horizontal = (atY, x = left, end = right) => page.drawLine({ start: { x, y: atY }, end: { x: end, y: atY }, thickness: .5, color: rule })
  const wrap = (value, maxWidth, size = 8.5, strong = false) => {
    const font = strong ? bold : regular, lines = []
    let line = ''
    for (const word of clean(value).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
      if (line) { lines.push(line); line = '' }
      let part = ''
      for (const char of word) {
        if (font.widthOfTextAtSize(part + char, size) > maxWidth) { lines.push(part); part = '' }
        part += char
      }
      line = part
    }
    if (line) lines.push(line)
    return lines.length ? lines : ['']
  }
  const newPage = () => {
    page = doc.addPage([595.28, 841.89])
    draw('BAKERY POS', left, 804, { size: 10, strong: true, color: accent })
    draw(`${closure.businessDate.split('-').reverse().join('/')}  |  CLP  |  V${closure.revision}`, right, 804, { size: 9, align: 'right', color: muted })
    horizontal(793)
    y = 775
  }
  const ensure = height => { if (y - height < bottom) newPage() }
  const section = label => { ensure(40); draw(label, left, y, { size: 9, strong: true, color: accent }); y -= 15 }
  const note = (label, value) => {
    for (const [index, line] of wrap(`${label}  ${value}`, width, 8).entries()) {
      ensure(12); draw(line, left, y, { size: 8, color: muted, strong: index === 0 && !value }); y -= 11
    }
    y -= 4
  }
  const table = (columns, rows, { continuation = '', headerSize = 8, fontSize = 8.5 } = {}) => {
    const positions = columns.map((column, index) => left + sum(columns.slice(0, index), c => c.width))
    const headerHeight = 19
    const header = () => {
      page.drawRectangle({ x: left, y: y - headerHeight, width, height: headerHeight, color: wash })
      columns.forEach((column, i) => draw(column.label, column.align === 'right' ? positions[i] + column.width - 7 : positions[i] + 7, y - 12,
        { size: headerSize, strong: true, align: column.align || 'left', color: muted }))
      y -= headerHeight
    }
    const layout = row => {
      const lines = row.cells.map((value, i) => wrap(value, columns[i].width - 14, fontSize, row.strong))
      return { lines, height: Math.max(17, Math.max(...lines.map(value => value.length)) * 10 + 7) }
    }
    ensure(headerHeight + (rows.length ? layout(rows[0]).height : 17)); header()
    rows.forEach((row, index) => {
      const { lines, height } = layout(row)
      const reserve = index === rows.length - 2 && rows.at(-1).strong ? height + layout(rows.at(-1)).height : height
      if (y - reserve < bottom) {
        newPage()
        if (continuation) section(`${continuation} / CONT.`)
        header()
      }
      if (row.strong) page.drawRectangle({ x: left, y: y - height, width, height, color: wash })
      columns.forEach((column, i) => lines[i].forEach((line, lineIndex) => draw(line,
        column.align === 'right' ? positions[i] + column.width - 7 : positions[i] + 7, y - 11 - lineIndex * 10,
        { size: fontSize, strong: row.strong, align: column.align || 'left' })))
      y -= height; horizontal(y)
    })
    y -= 14
  }

  newPage()
  draw(closure.scope==='session'?'CIERRE DE CAJA':'VENTAS Y CIERRE DE CAJA', left, y, { size: 16, strong: true }); y -= 19
  note('Responsable:', closure.operator || '-')
  note('Cierre:', `${dateTime.format(new Date(closure.closedAt))}  |  Hora Chile  |  Ref. ${shortId(closure.id)}`)
  if(closure.scope==='session')note('Turno:', `${shortId(closure.registerSessionId)}  |  Apertura ${dateTime.format(new Date(closure.openedAt))}`)

  section('01 / VENTAS')
  table([
    { label: 'Concepto', width: 172 },
    { label: `Efectivo (${s.cash.transactions})`, width: 113, align: 'right' },
    { label: `Tarjeta (${s.card.transactions})`, width: 113, align: 'right' },
    { label: `Total (${s.transactions})`, width: width - 398, align: 'right' },
  ], [
    { cells: ['Ventas brutas', money(s.cash.gross), money(s.card.gross), money(s.gross)] },
    { cells: [`Devoluciones (${s.cash.refundCount + s.card.refundCount})`, money(-s.cash.refunds), money(-s.card.refunds), money(-s.refunds)] },
    { cells: ['VENTAS NETAS', money(s.cash.net), money(s.card.net), money(s.net)], strong: true },
  ])

  const cashRows = [
    ['Fondo inicial', money(closure.openingCash)], ['Ventas netas', money(s.cash.net)],
    ['Entradas', money(closure.cashIn)], ['Retiros', money(-closure.cashOut)],
    ['Efectivo esperado', money(closure.expectedCash), true], ['Efectivo contado', money(closure.countedCash), true],
    ['Diferencia', money(closure.difference), true, closure.difference],
  ]
  const cardRows = [
    ['Comisiones informadas', money(s.card.recordedFees)], ['Neto proveedor informado', money(s.card.recordedSettlement)],
    ['Cobros con datos prov.', `${s.card.reconciledTransactions}/${s.card.transactions}`], ['Lote / referencia', closure.terminalReference || '-'],
    ['Esperado sin comisiones', money(s.card.net), true], ['Total terminal', money(closure.countedCard), true],
    ['Diferencia', money(closure.cardDifference), true, closure.cardDifference],
  ]
  const gap = 14, panelWidth = (width - gap) / 2, valueWidth = 95, labelWidth = panelWidth - valueWidth - 19
  const panelRows = cashRows.map((cash, index) => {
    const card = cardRows[index]
    const cells = [cash, card].map(row => ({ row, labels: wrap(row[0], labelWidth, 8), values: wrap(row[1], valueWidth, 8.5, row[2]) }))
    return { cells, height: Math.max(18, Math.max(...cells.map(cell => Math.max(cell.labels.length, cell.values.length))) * 10 + 7) }
  })
  const panelsHeight = 24 + sum(panelRows, row => row.height)
  ensure(panelsHeight + 14)
  const panelTop = y
  for (const [i, title] of ['02 / ARQUEO EFECTIVO', '03 / CONCILIACIÓN TARJETAS'].entries()) {
    const x = left + i * (panelWidth + gap)
    page.drawRectangle({ x, y: panelTop - panelsHeight, width: panelWidth, height: panelsHeight, borderColor: rule, borderWidth: .5 })
    page.drawRectangle({ x, y: panelTop - 23, width: panelWidth, height: 23, color: wash })
    draw(title, x + 8, panelTop - 15, { size: 8.5, strong: true, color: accent })
  }
  y -= 24
  for (const { cells, height } of panelRows) {
    cells.forEach(({ row, labels, values }, i) => {
      const x = left + i * (panelWidth + gap)
      if (row[3] != null) page.drawRectangle({ x: x + .5, y: y - height, width: panelWidth - 1, height, color: row[3] === 0 ? balanced : unbalanced })
      if (row[2] && row[3] == null) horizontal(y, x + 8, x + panelWidth - 8)
      labels.forEach((value, j) => draw(value, x + 8, y - 12 - j * 10, { size: 8, strong: row[2] }))
      values.forEach((value, j) => draw(value, x + panelWidth - 8, y - 12 - j * 10, { size: 8.5, strong: row[2], align: 'right' }))
    })
    y -= height
  }
  y -= 14
  if (closure.denominations) note('Efectivo:', Object.entries(closure.denominations).filter(([, count]) => count > 0).sort((a, b) => b[0] - a[0]).map(([value, count]) => `${money(value)} x ${count}`).join(' | ') || '0')

  section(`04 / MOVIMIENTOS (${s.operations.length})`)
  const ledgerRows = s.operations.map(op => ({ cells: [clock.format(new Date(op.at)), op.shortId || shortId(op.saleId),
    op.type === 'refund' ? 'DEV.' : 'VTA.', op.method === 'cash' ? 'Efectivo' : 'Tarjeta',
    op.type === 'sale' ? money(op.amount) : '-', op.type === 'refund' ? money(-op.amount) : '-'] }))
  ledgerRows.push({ cells: ['TOTAL', '', '', '', money(s.gross), money(s.refunds)], strong: true })
  table([
    { label: 'Hora', width: 46 }, { label: 'Venta / ref.', width: 120 }, { label: 'Tipo', width: 53 },
    { label: 'Medio', width: 91 }, { label: 'Ingresos', width: 106.5, align: 'right' }, { label: 'Egresos', width: width - 416.5, align: 'right' },
  ], ledgerRows, { continuation: 'MOVIMIENTOS' })

  if (s.excluded.length) {
    const groups = new Map()
    const labels = { pending: 'Pendiente', processing: 'En proceso', failed: 'Fallida', cancelled: 'Cancelada', canceled: 'Cancelada', expired: 'Expirada' }
    for (const op of s.excluded) {
      const label = `${op.type === 'refund' ? 'Devolución' : 'Pago'} ${labels[op.status] || op.status}`
      const group = groups.get(label) || { count: 0, amount: 0 }
      group.count++; group.amount += op.amount; groups.set(label, group)
    }
    note('EXCLUIDAS:', [...groups].map(([label, group]) => `${label}: ${group.count} / ${money(group.amount)}`).join(' | '))
  }
  if (closure.note) note('OBS.:', closure.note)
  const pages = doc.getPages()
  pages.forEach((p, i) => {
    page = p
    horizontal(35)
    draw(`Bakery POS | Cierre ${shortId(closure.id)} | V${closure.revision}`, left, 23, { size: 7.5, color: muted })
    draw(`${i + 1} / ${pages.length}`, right, 23, { size: 7.5, align: 'right', color: muted })
  })
  // Flate content streams + compressed object streams; standard fonts keep the PDF small.
  return Buffer.from(await doc.save({ useObjectStreams: true, objectsPerTick: 50, addDefaultPage: false }))
}
