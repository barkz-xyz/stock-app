export function saleUsesPoint(sale) {
  return Boolean(sale && (sale.pointPayment || sale.paymentMethod === 'card'))
}
