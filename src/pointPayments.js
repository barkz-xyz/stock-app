export function saleUsesPoint(sale) {
  return Boolean(sale && (sale.pointPayment || sale.paymentMethod === 'card'))
}

const finalPrintStatuses = new Set(['processed', 'failed', 'canceled', 'cancelled', 'expired'])

export function pointPrintIsFinal(status) {
  return finalPrintStatuses.has(status)
}
