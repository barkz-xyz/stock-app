import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RotateCw, UnlockKeyhole } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { Modal } from './ui.jsx'

export default function StockReservations({ setToast }) {
  const { language } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [history, setHistory] = useState(false)
  const [selected, setSelected] = useState(null), [verified, setVerified] = useState(false), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setRows((await api.stockReservations()).reservations); setError('') }
    catch (next) { setError(next.message) }
  }, [])
  useEffect(() => { load(); const timer = setInterval(load, 20000); return () => clearInterval(timer) }, [load])
  const active = row => ['held', 'payment_pending'].includes(row.status)
  const visible = history ? rows : rows.filter(active)
  const label = status => ({ held: tx('Reservada', 'Held'), payment_pending: tx('Pago en curso', 'Payment pending'),
    confirmed: tx('Confirmada', 'Confirmed'), released: tx('Liberada', 'Released'), expired: tx('Vencida', 'Expired') })[status]
  const amount = row => new Intl.NumberFormat(language === 'es' ? 'es-CL' : 'en-US', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(row.total.amount)
  const release = async () => {
    setBusy(true); setError('')
    try {
      await api.releaseStockReservation(selected.row.id, selected.row.status === 'payment_pending'
        ? { reason: 'payment_cancelled', paymentAttemptId: selected.row.paymentAttemptId, outcomeVerified: verified }
        : { reason: 'checkout_cancelled' }, selected.key)
      setSelected(null); await load(); setToast({ type: 'success', message: tx('Stock liberado', 'Stock released') })
    } catch (next) { setError(next.message) } finally { setBusy(false) }
  }
  return <section className="card reservation-panel">
    <header className="card-header"><h2>{tx('Reservas online', 'Online reservations')} <span className="status-pill neutral">{rows.filter(active).length}</span></h2><div className="integration-actions"><button className="text-button" onClick={() => setHistory(!history)}>{tx(history ? 'Pendientes' : 'Historial', history ? 'Pending' : 'History')}</button><button className="icon-button subtle" disabled={busy} onClick={load} aria-label={tx('Actualizar reservas', 'Refresh reservations')}><RotateCw size={16}/></button></div></header>
    {error && !selected && <div className="inline-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {!visible.length ? <p className="reservation-empty">{tx('Sin reservas', 'No reservations')}</p> : <div className="reservation-list">{visible.map(row => <article key={row.id}>
      <div className="reservation-copy"><strong>{row.clientName}</strong><code>{row.externalReference}</code><small>{row.status === 'held' ? tx('Vence', 'Expires') : tx('Creada', 'Created')} {new Date(row.status === 'held' ? row.expiresAt : row.createdAt).toLocaleString(language === 'es' ? 'es-CL' : 'en-GB', { timeZone: 'America/Santiago', dateStyle: 'short', timeStyle: 'short' })}</small><details><summary>{row.items.length} {row.items.length === 1 ? tx('producto', 'product') : tx('productos', 'products')}</summary>{row.items.map(item => <small key={item.itemId}>{item.quantity} × {item.name}</small>)}</details></div>
      <div className="reservation-amount"><strong>{amount(row)}</strong><span className={`status-pill ${row.status === 'payment_pending' ? 'warning' : row.status === 'confirmed' ? 'success' : 'neutral'}`}>{label(row.status)}</span></div>
      {active(row) && <button className="icon-button subtle" disabled={busy} aria-label={`${tx('Liberar reserva', 'Release reservation')} ${row.externalReference}`} onClick={() => { setSelected({ row, key: crypto.randomUUID() }); setVerified(false); setError('') }}><UnlockKeyhole size={17}/></button>}
    </article>)}</div>}
    {selected && <Modal title={tx('Liberar stock', 'Release stock')} closeable={!busy} onClose={() => !busy && setSelected(null)}><div className="form-stack integration-confirmation"><strong>{selected.row.externalReference}</strong><p>{selected.row.status === 'payment_pending' ? tx('Hay un pago en curso. Verifica su cancelación o rechazo en el checkout antes de liberar las unidades.', 'A payment is pending. Verify its cancellation or rejection in the checkout before releasing the units.') : tx('Las unidades volverán a estar disponibles para Caja y la tienda.', 'The units become available to the register and storefront again.')}</p>{selected.row.status === 'payment_pending' && <label className="reservation-checkbox"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)}/>{tx('Confirmé que el pago fue cancelado o rechazado', 'I verified the payment was cancelled or rejected')}</label>}{error && <div className="inline-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setSelected(null)}>{tx('Volver', 'Back')}</button><button className="button primary" disabled={busy || selected.row.status === 'payment_pending' && !verified} onClick={release}>{tx(busy ? 'Liberando…' : 'Liberar stock', busy ? 'Releasing…' : 'Release stock')}</button></div></div></Modal>}
  </section>
}
