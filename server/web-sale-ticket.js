import { closureTimeZone } from './cash-closure.js'
import { escapeHtml } from './report.js'

const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' })
const quantity = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 })
const date = new Intl.DateTimeFormat('es-CL', { timeZone: closureTimeZone, dateStyle: 'short', timeStyle: 'short' })

export function renderWebSaleTicket(sale) {
  const { web } = sale
  const missing = 'Sin informar'
  const products = sale.items.map(item => `<tr><td>${escapeHtml(item.name)}<small>${quantity.format(item.quantity)} × ${clp.format(item.unitPrice)}</small></td><td>${clp.format(item.lineTotal)}</td></tr>`).join('')
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket web #${escapeHtml(sale.shortId)}</title>
<style>
  body{font:14px system-ui,sans-serif;color:#171717;margin:1rem auto;padding:0 8px;max-width:76mm}
  header{text-align:center}h1{font-size:18px;margin:.25rem 0}p{margin:.35rem 0;overflow-wrap:anywhere}
  table{width:100%;border-collapse:collapse;margin:.8rem 0;font-variant-numeric:tabular-nums}
  th{text-align:left;border-bottom:1px solid}td,th{padding:5px 0;vertical-align:top}
  td:last-child,th:last-child{text-align:right;white-space:nowrap}td:first-child{padding-right:6px;overflow-wrap:anywhere}
  tr{break-inside:avoid}small{display:block}.total{font-weight:bold;border-top:1px solid}
  footer{text-align:center;font-size:12px}button{margin-top:1rem;padding:.5rem 1rem}
  @media print{body{margin:0 auto}button{display:none}}
</style><script src="/web-ticket-print.js" defer></script></head>
<body><header><h1>Bakery POS · Ticket web</h1>${web.environment === 'test' ? '<strong>PRUEBA</strong>' : ''}</header>
<p>Venta #${escapeHtml(sale.shortId)}</p>
<p>Pedido: ${escapeHtml(web.externalReference)}</p>
${web.orderReference ? `<p>Orden Mercado Pago: ${escapeHtml(web.orderReference)}</p>` : ''}
<p>Pago: ${escapeHtml(web.paymentId || web.paymentReference)}</p>
<p>${web.approvedAt ? 'Aprobación' : 'Confirmación'}: ${date.format(new Date(sale.paidAt))}</p>
<table><thead><tr><th>Producto / cantidad × precio</th><th>Importe</th></tr></thead><tbody>${products}</tbody></table>
<table><tbody>
<tr><td>Subtotal productos</td><td>${clp.format(web.subtotal)}</td></tr>
<tr><td>Despacho</td><td>${web.shippingAmount == null ? missing : clp.format(web.shippingAmount)}</td></tr>
<tr class="total"><td>Total cobrado</td><td>${web.chargedTotal == null ? missing : clp.format(web.chargedTotal)}</td></tr>
</tbody></table>
<footer>Comprobante interno · Sin validez tributaria</footer>
<button type="button" id="reprint">Reimprimir</button>
</body></html>`
}
