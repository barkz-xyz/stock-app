const minimumContentLength = 100
const maximumContentLength = 4096
const lineWidth = 32

function printerText(value, maximumLength = 160) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength)
}
function splitLongWord(word, maximumLength) {
  const parts = []
  for (let index = 0; index < word.length; index += maximumLength) {
    parts.push(word.slice(index, index + maximumLength))
  }
  return parts
}

function wrapWords(value, maximumLength = lineWidth) {
  const words = printerText(value)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => word.length > maximumLength ? splitLongWord(word, maximumLength) : [word])
  if (!words.length) return ['']

  const lines = []
  let current = ''
  for (const word of words) {
    if (!current) current = word
    else if (`${current} ${word}`.length <= maximumLength) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function smallLines(value) {
  return wrapWords(value).map((line) => `{s}${line}{/s}{br}`).join('')
}

function money(value) {
  const amount = Math.round(Number(value || 0))
  return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString('es-CL')}`
}

function receiptTimestamp(value, timeZone = 'America/Santiago') {
  const date = new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date).replace(',', '')
}

function bestSellingProduct(operations) {
  const quantities = new Map()
  for (const operation of operations) {
    const sign = operation.type === 'refund' ? -1 : 1
    for (const item of operation.items) {
      quantities.set(item.name, (quantities.get(item.name) ?? 0) + sign * item.quantity)
    }
  }
  return [...quantities]
    .map(([name, quantity]) => ({ name, quantity: Math.round(quantity * 100) / 100 }))
    .filter(product => product.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es-CL'))[0]
}

export function renderPointCashClosure(closure) {
  const { difference, snapshot } = closure
  const topProduct = bestSellingProduct(snapshot.operations)
  const withdrawalCount = snapshot.cashLedger?.entries.filter(entry => entry.kind === 'withdrawal').length ?? 0
  const date = closure.businessDate.split('-').reverse().join('/')
  const divider = `${'-'.repeat(lineWidth)}{br}`
  const row = (label, amount) => {
    const space = lineWidth - label.length
    if (amount.length >= space) return `${smallLines(label)}{s}${amount.padStart(lineWidth)}{/s}{br}`
    return `{s}${label}${amount.padStart(space)}{/s}{br}`
  }
  return [
    '{center}{b}CIERRE DE CAJA{/b}{br}',
    smallLines(`Bakery POS | ${date}`),
    '{/center}{left}',
    divider,
    '{b}VENTAS NETAS{/b}{br}',
    row(`Efectivo (${snapshot.cash.transactions})`, money(closure.cashSales)),
    row(`Tarjeta POS (${snapshot.card.transactions})`, money(closure.cardSales)),
    row(`Total (${snapshot.transactions})`, money(closure.totalSales)),
    divider,
    '{b}EFECTIVO EN CAJA{/b}{br}',
    row('Fondo inicial', money(closure.openingCash)),
    closure.cashOut ? row(withdrawalCount ? `Retiros (${withdrawalCount})` : 'Retiros', money(closure.cashOut)) : '',
    closure.cashIn ? row('Vuelto de retiros', money(closure.cashIn)) : '',
    row('Esperado', money(closure.expectedCash)),
    row('Contado', money(closure.countedCash)),
    difference ? row('Diferencia', `${difference > 0 ? '+' : ''}${money(difference)}`) : '',
    divider,
    topProduct ? '{b}MAS VENDIDO{/b}{br}' : '',
    topProduct ? smallLines(`${topProduct.quantity.toLocaleString('es-CL')} x ${topProduct.name}`) : '',
    smallLines(`Cerrado por: ${closure.closedByName || closure.operator}`),
    smallLines(`Hora cierre: ${receiptTimestamp(closure.closedAt, snapshot.timeZone)}`),
    '{br}{/left}',
  ].join('')
}

export function renderPointWebOrder(sale) {
  const { web } = sale
  const divider = `${'-'.repeat(lineWidth)}{br}`
  const header = [
    '{center}{b}COMANDA WEB{/b}{br}',
    web.environment === 'test' ? '{b}PRUEBA{/b}{br}' : '',
    smallLines('Bakery POS | Uso interno'),
    '{/center}{left}',
    divider,
    smallLines(`Venta #${sale.shortId}`),
    smallLines(`Pedido: ${web.externalReference}`),
    smallLines(receiptTimestamp(sale.paidAt, process.env.BAKERY_TIME_ZONE)),
  ].join('')
  const ending = [
    divider,
    smallLines(`Subtotal: ${money(web.subtotal)}`),
    smallLines(`Despacho: ${web.shippingAmount == null ? 'Sin informar' : money(web.shippingAmount)}`),
    smallLines(`Total cobrado: ${web.chargedTotal == null ? 'Sin informar' : money(web.chargedTotal)}`),
  ].join('')
  const footer = '{br}{/left}'
  const maxItemsLength = maximumContentLength - header.length - ending.length - footer.length - divider.length - smallLines('Parte 100/100').length
  const sections = []
  let products = ''
  for (const item of sale.items) {
    const quantity = Number(item.quantity).toLocaleString('es-CL', { maximumFractionDigits: 2 })
    const lines = smallLines(`${quantity} x ${printerText(item.name, 140)}`) + smallLines(`Precio unit.: ${money(item.unitPrice)}`)
    if (products.length + lines.length > maxItemsLength) {
      sections.push(products)
      products = ''
    }
    products += lines
  }
  sections.push(products)
  return sections.map((lines, i) => header
    + (sections.length > 1 ? smallLines(`Parte ${i + 1}/${sections.length}`) : '')
    + divider + lines + (i === sections.length - 1 ? ending : '') + footer)
}

export function renderPointRefundCopy(sale, refund) {
  const saleReference = printerText(sale.shortId || sale.id, 40).toUpperCase()
  const operationId = printerText(sale.mpOperationId || sale.mpPaymentId || '', 80)
  const refundId = printerText(refund.mpRefundId || refund.id, 80)
  const card = [
    printerText(sale.mpCardBrand, 24).toUpperCase(),
    sale.mpCardLastFour ? `**** ${printerText(sale.mpCardLastFour, 4)}` : '',
  ].filter(Boolean).join(' ')

  const content = [
    '{center}',
    '{w}{b}COPIA DE DEVOLUCION{/b}{/w}{br}',
    '{b}BAKERY POS{/b}{br}',
    '{s}NO TRIBUTARIO{/s}{br}',
    '{/center}',
    '--------------------------------{br}',
    '{left}',
    smallLines(`Venta: #${saleReference}`),
    smallLines(`Fecha: ${receiptTimestamp(refund.processedAt || refund.updatedAt || refund.createdAt)}`),
    `{w}{b}DEVUELTO ${money(refund.amount)}{/b}{/w}{br}`,
    operationId ? smallLines(`Operacion MP: ${operationId}`) : '',
    refundId ? smallLines(`Devolucion MP: ${refundId}`) : '',
    card ? smallLines(`Medio original: ${card}`) : '',
    '--------------------------------{br}',
    smallLines('Mercado Pago proceso la devolucion al medio de pago original.'),
    '{br}',
    smallLines('Esta copia no reemplaza el voucher oficial de Mercado Pago ni una nota de credito o DTE.'),
    '{/left}',
  ].join('')

  if (content.length < minimumContentLength || content.length > maximumContentLength) {
    throw Object.assign(new Error(`Refund copy content must contain between ${minimumContentLength} and ${maximumContentLength} characters.`), { status: 500 })
  }
  return content
}
