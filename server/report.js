function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function reportText(language) {
  return language === 'en' ? {
    title: 'Daily bakery report', subtitle: 'Sales, payments, demand, and inventory in one lightweight file.',
    generated: 'Generated', collected: 'Collected sales', transactions: 'Transactions', ticket: 'Average ticket', units: 'Units sold',
    payments: 'Payment reconciliation', cash: 'Cash', point: 'Mercado Pago Point', sales: 'sales',
    products: 'Top-selling products', product: 'Product', quantity: 'Quantity', revenue: 'Revenue', share: 'Share',
    hours: 'Sales by hour', hour: 'Hour', inventory: 'Current inventory snapshot', available: 'Available', category: 'Category', status: 'Status',
    healthy: 'Healthy', low: 'Low stock', out: 'Out of stock', attention: 'need attention',
    close: 'Daily cash close', opening: 'Opening cash', adjustments: 'Adjustments', expected: 'Expected cash', counted: 'Counted cash', difference: 'Difference',
    noClose: 'The cash close has not been registered yet.', operations: 'Operational checks', pending: 'Pending Point payments', failed: 'Failed payments', refunds: 'Refunded amount',
    empty: 'No collected sales for this date.', footer: 'Exported from Bakery POS. This report is read-only and works offline.',
  } : {
    title: 'Reporte diario de la panadería', subtitle: 'Ventas, pagos, demanda e inventario en un solo archivo liviano.',
    generated: 'Generado', collected: 'Ventas cobradas', transactions: 'Transacciones', ticket: 'Ticket promedio', units: 'Unidades vendidas',
    payments: 'Conciliación de pagos', cash: 'Efectivo', point: 'Mercado Pago Point', sales: 'ventas',
    products: 'Productos más vendidos', product: 'Producto', quantity: 'Cantidad', revenue: 'Ingresos', share: 'Participación',
    hours: 'Ventas por hora', hour: 'Hora', inventory: 'Inventario actual', available: 'Disponible', category: 'Categoría', status: 'Estado',
    healthy: 'Saludable', low: 'Stock bajo', out: 'Agotado', attention: 'requieren atención',
    close: 'Cierre de caja del día', opening: 'Efectivo inicial', adjustments: 'Ajustes', expected: 'Efectivo esperado', counted: 'Efectivo contado', difference: 'Diferencia',
    noClose: 'El cierre de caja todavía no ha sido registrado.', operations: 'Control operacional', pending: 'Cobros Point pendientes', failed: 'Cobros fallidos', refunds: 'Monto reembolsado',
    empty: 'No hay ventas cobradas para esta fecha.', footer: 'Exportado desde Bakery POS. Este reporte es de solo lectura y funciona sin conexión.',
  }
}

function formatCurrency(value, language) {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CL', {
    style: 'currency', currency: 'CLP', maximumFractionDigits: 0,
  }).format(Number(value) || 0)
}

function formatNumber(value, language) {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CL', { maximumFractionDigits: 2 }).format(Number(value) || 0)
}

function metric(label, value, note = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`
}

export function createDailyReport({ metrics, items, businessDate, language = 'es', generatedAt = new Date() }) {
  const text = reportText(language)
  const locale = language === 'en' ? 'en-US' : 'es-CL'
  const reportDate = new Intl.DateTimeFormat(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Santiago' })
    .format(new Date(`${businessDate}T12:00:00-04:00`))
  const generated = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Santiago' }).format(generatedAt)
  const summary = metrics.summary
  const cash = metrics.paymentMethods.cash
  const card = metrics.paymentMethods.card
  const web = metrics.paymentMethods.web
  const closure = metrics.cashClosure
  const attentionItems = items.filter((item) => item.quantity <= item.lowStockThreshold)
  const maxHour = Math.max(...metrics.hourly.map((entry) => entry.revenue), 1)
  const activeHours = metrics.hourly.filter((entry) => entry.transactions > 0)
  const sortedItems = [...items].sort((a, b) => {
    const aAttention = a.quantity <= a.lowStockThreshold ? 0 : 1
    const bAttention = b.quantity <= b.lowStockThreshold ? 0 : 1
    return aAttention - bAttention || a.name.localeCompare(b.name)
  })
  const inventoryRows = sortedItems.map((item) => {
    const status = item.quantity === 0 ? text.out : item.quantity <= item.lowStockThreshold ? text.low : text.healthy
    const tone = item.quantity === 0 ? 'danger' : item.quantity <= item.lowStockThreshold ? 'warning' : 'success'
    return `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sku || '—')}</small></td><td>${escapeHtml(item.category)}</td><td>${formatNumber(item.quantity, language)} ${escapeHtml(item.unit)}</td><td><span class="status ${tone}">${escapeHtml(status)}</span></td></tr>`
  }).join('')
  const productRows = metrics.topProducts.map((product, index) => `<tr><td class="rank">${String(index + 1).padStart(2, '0')}</td><td><strong>${escapeHtml(product.name)}</strong></td><td>${formatNumber(product.quantity, language)}</td><td>${formatCurrency(product.revenue, language)}</td><td>${formatNumber(product.revenueShare, language)}%</td></tr>`).join('')
  const hourRows = activeHours.map((entry) => `<div class="hour-row"><span>${String(entry.hour).padStart(2, '0')}:00</span><div><i style="width:${Math.max((entry.revenue / maxHour) * 100, 3)}%"></i></div><strong>${formatCurrency(entry.revenue, language)}</strong><small>${entry.transactions} ${escapeHtml(text.sales)}</small></div>`).join('')
  const differenceClass = !closure || closure.difference === 0 ? 'success-text' : closure.difference > 0 ? 'warning-text' : 'danger-text'

  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(text.title)} · ${escapeHtml(businessDate)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#28231f;background:#f5f1eb;--line:#ded6cc;--muted:#756e67;--cocoa:#6d4535;--soft:#f0e4dc;--sage:#607765;--amber:#a56c25;--danger:#a0443d}*{box-sizing:border-box}body{margin:0;padding:34px;background:#f5f1eb}.report{width:min(1040px,100%);margin:auto}.hero{display:flex;justify-content:space-between;gap:24px;padding:30px;border-radius:22px;color:#fff;background:linear-gradient(135deg,#5a372a,#7c5140);box-shadow:0 18px 45px #49302426}.brand{display:flex;gap:14px;align-items:center}.mark{display:grid;width:50px;height:50px;place-items:center;border-radius:15px;background:#fff2;font-size:19px;font-weight:900}.hero h1{margin:0 0 7px;font-size:28px;letter-spacing:-.035em}.hero p{margin:0;max-width:570px;color:#f3e9e3;font-size:12px;line-height:1.55}.hero-meta{text-align:right}.hero-meta strong,.hero-meta span{display:block}.hero-meta strong{font-size:14px;text-transform:capitalize}.hero-meta span{margin-top:8px;color:#ebdbd2;font-size:9px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:16px 0}.metric{min-height:108px;padding:18px;border:1px solid var(--line);border-radius:16px;background:#fff}.metric span,.metric strong,.metric small{display:block}.metric span{color:var(--muted);font-size:9px;font-weight:700}.metric strong{margin:10px 0 5px;font-size:22px}.metric small{color:#9a938c;font-size:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}.card{overflow:hidden;border:1px solid var(--line);border-radius:18px;background:#fff}.card.full{grid-column:1/-1}.card header{padding:17px 19px;border-bottom:1px solid var(--line)}.eyebrow{display:block;margin-bottom:5px;color:var(--cocoa);font-size:8px;font-weight:850;letter-spacing:.11em;text-transform:uppercase}.card h2{margin:0;font-size:15px}.payment-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:16px}.payment{padding:16px;border-radius:13px;background:#faf6f2}.payment span,.payment strong,.payment small{display:block}.payment span{color:var(--muted);font-size:9px}.payment strong{margin:8px 0 4px;font-size:19px}.payment small{font-size:8px;color:#918981}.operations{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;padding:16px}.operations .metric{min-height:90px;border-radius:12px;background:#faf8f5}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:11px 14px;border-bottom:1px solid #eee8e1;text-align:left;font-size:9px}th{color:var(--muted);background:#faf8f5;font-size:8px;text-transform:uppercase}td strong,td small{display:block}td small{margin-top:3px;color:#98918a;font-size:7px}.rank{color:#a39b94;font-weight:800}.status{display:inline-block;padding:4px 7px;border-radius:99px;font-size:7px;font-weight:800}.status.success{color:var(--sage);background:#e7eee7}.status.warning{color:var(--amber);background:#f7ecd9}.status.danger{color:var(--danger);background:#f4e6e4}.hours{padding:14px 18px}.hour-row{display:grid;grid-template-columns:40px 1fr 82px 50px;align-items:center;gap:10px;min-height:28px}.hour-row span,.hour-row small{color:var(--muted);font-size:7px}.hour-row div{height:5px;overflow:hidden;border-radius:99px;background:#eee8e1}.hour-row i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#9d6e59,var(--cocoa))}.hour-row strong{text-align:right;font-size:8px}.hour-row small{text-align:right}.empty{padding:35px;text-align:center;color:var(--muted);font-size:10px}.close-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:16px}.close-grid .metric{min-height:82px;padding:12px;background:#faf8f5}.close-grid .metric strong{font-size:14px}.close-note{margin:0 16px 16px;padding:11px;border-radius:10px;background:#faf6f2;color:var(--muted);font-size:8px}.success-text strong{color:var(--sage)}.warning-text strong{color:var(--amber)}.danger-text strong{color:var(--danger)}footer{padding:9px 2px;color:#8e8780;font-size:8px;text-align:center}@media print{body{padding:0;background:#fff}.hero{box-shadow:none}.report{width:100%}}@media(max-width:700px){body{padding:14px}.hero{display:block;padding:22px}.hero-meta{margin-top:18px;text-align:left}.metrics{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.card.full{grid-column:auto}.payment-grid,.operations{grid-template-columns:1fr}.close-grid{grid-template-columns:1fr 1fr}.hour-row{grid-template-columns:37px 1fr 75px}.hour-row small{display:none}.hero h1{font-size:23px}}
</style></head><body><main class="report">
<section class="hero"><div class="brand"><div class="mark">BP</div><div><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.subtitle)}</p></div></div><div class="hero-meta"><strong>${escapeHtml(reportDate)}</strong><span>${escapeHtml(text.generated)} · ${escapeHtml(generated)}</span></div></section>
<section class="metrics">${metric(text.collected, formatCurrency(summary.revenue, language))}${metric(text.transactions, formatNumber(summary.transactions, language))}${metric(text.ticket, formatCurrency(summary.averageTicket, language))}${metric(text.units, formatNumber(summary.itemsSold, language))}</section>
<section class="grid">
<article class="card"><header><span class="eyebrow">${escapeHtml(text.payments)}</span><h2>${escapeHtml(text.cash)} / Point${web ? ' / Web' : ''}</h2></header><div class="payment-grid"><div class="payment"><span>${escapeHtml(text.cash)}</span><strong>${formatCurrency(cash.revenue, language)}</strong><small>${cash.transactions} ${escapeHtml(text.sales)}</small></div><div class="payment"><span>${escapeHtml(text.point)}</span><strong>${formatCurrency(card.revenue, language)}</strong><small>${card.transactions} ${escapeHtml(text.sales)}</small></div>${web ? `<div class="payment"><span>Web</span><strong>${formatCurrency(web.revenue, language)}</strong><small>${web.transactions} ${escapeHtml(text.sales)}</small></div>` : ''}</div></article>
<article class="card"><header><span class="eyebrow">${escapeHtml(text.operations)}</span><h2>${summary.pendingPoint || summary.failedPayments ? escapeHtml(text.attention) : escapeHtml(text.healthy)}</h2></header><div class="operations">${metric(text.pending, summary.pendingPoint)}${metric(text.failed, summary.failedPayments)}${metric(text.refunds, formatCurrency(summary.refundedTotal, language))}</div></article>
<article class="card full"><header><span class="eyebrow">01</span><h2>${escapeHtml(text.products)}</h2></header>${productRows ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>${escapeHtml(text.product)}</th><th>${escapeHtml(text.quantity)}</th><th>${escapeHtml(text.revenue)}</th><th>${escapeHtml(text.share)}</th></tr></thead><tbody>${productRows}</tbody></table></div>` : `<div class="empty">${escapeHtml(text.empty)}</div>`}</article>
<article class="card"><header><span class="eyebrow">02</span><h2>${escapeHtml(text.hours)}</h2></header>${hourRows ? `<div class="hours">${hourRows}</div>` : `<div class="empty">${escapeHtml(text.empty)}</div>`}</article>
<article class="card"><header><span class="eyebrow">03 · ${attentionItems.length} ${escapeHtml(text.attention)}</span><h2>${escapeHtml(text.inventory)}</h2></header><div class="table-wrap"><table><thead><tr><th>${escapeHtml(text.product)}</th><th>${escapeHtml(text.category)}</th><th>${escapeHtml(text.available)}</th><th>${escapeHtml(text.status)}</th></tr></thead><tbody>${inventoryRows}</tbody></table></div></article>
<article class="card full"><header><span class="eyebrow">04</span><h2>${escapeHtml(text.close)}</h2></header>${closure ? `<div class="close-grid">${metric(text.opening, formatCurrency(closure.openingCash, language))}${metric(text.adjustments, formatCurrency(closure.cashAdjustments, language))}${metric(text.expected, formatCurrency(closure.expectedCash, language))}${metric(text.counted, formatCurrency(closure.countedCash, language))}<div class="${differenceClass}">${metric(text.difference, `${closure.difference > 0 ? '+' : ''}${formatCurrency(closure.difference, language)}`)}</div></div>${closure.note ? `<p class="close-note">${escapeHtml(closure.note)}</p>` : ''}` : `<div class="empty">${escapeHtml(text.noClose)}</div>`}</article>
</section><footer>${escapeHtml(text.footer)}</footer></main></body></html>`
}
