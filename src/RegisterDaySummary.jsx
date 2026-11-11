import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, Banknote, CreditCard, Download, Globe } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { isPlainNavigation, sectionHref } from './routes.js'

export default function RegisterDaySummary({ date, today, refreshToken, onDateChange, onNavigate }) {
  const { language, formatCurrency: money } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const current = summary?.businessDate === date ? summary : null
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api.registerDaySummary(date, { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) setSummary(next)
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message)
    })
    return () => controller.abort()
  }, [date, refreshToken, reload])

  const channels = current && [
    [Banknote, tx('Efectivo', 'Cash'), current.cash],
    [CreditCard, tx('Tarjeta Point', 'Point card'), current.card],
    [Globe, 'Web', current.web],
  ]
  return <section id="resumen-del-dia" className="card register-day-summary" aria-labelledby="register-day-title">
    <header className="register-day-heading">
      <div><h2 id="register-day-title">{tx('Resumen del día', 'Day summary')}</h2><p>{tx('Ventas netas de todas las cajas y del canal web.', 'Net sales across all registers and the web channel.')}</p></div>
      <div className="register-day-tools">
        <label className="closure-field"><span>{tx('Fecha del resumen', 'Summary date')}</span><input type="date" min="2000-01-01" max={today} value={date} onChange={e => onDateChange(e.target.value)} /></label>
        {current && <a className="button secondary" href={api.registerDaySummaryPdfUrl(date)} download><Download size={16} />{tx('Exportar PDF', 'Export PDF')}</a>}
      </div>
    </header>
    {error && <div className="closure-notice error" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" className="text-button" onClick={() => setReload(n => n + 1)}>{tx('Reintentar', 'Retry')}</button></div>}
    {!current && !error && <p className="closure-empty" role="status">{tx('Cargando resumen…', 'Loading summary…')}</p>}
    {current && <>
      <div className="register-day-totals">
        {channels.map(([Icon, name, channel]) => <article key={name}><span><Icon size={16} aria-hidden="true" />{name}</span><strong>{money(channel.net)}</strong><small>{channel.transactions} {tx(channel.transactions === 1 ? 'venta' : 'ventas', channel.transactions === 1 ? 'sale' : 'sales')}</small></article>)}
        <article className="register-day-net"><span>{tx('Total neto', 'Net total')}</span><strong>{money(current.net)}</strong><small>{tx('Ventas', 'Sales')} {money(current.gross)} · {tx('Devoluciones', 'Refunds')} {money(current.refunds)}</small></article>
      </div>
      {current.web.transactions > 0 && <p className="register-day-web">Web: {tx('Productos', 'Products')} {money(current.web.subtotal)} · {tx('Despacho informado', 'Reported shipping')} {money(current.web.shippingAmount)}
        {current.web.incompleteCount > 0 && <span> · {tx(`${current.web.incompleteCount} sin total cobrado informado`, `${current.web.incompleteCount} without a reported charge`)}</span>}</p>}
      <div className="register-day-registers">
        <strong>{tx('Cajas', 'Registers')}</strong>
        <span>{current.registers.closed} {tx(current.registers.closed === 1 ? 'cerrada' : 'cerradas', 'closed')} · {current.registers.open.length} {tx(current.registers.open.length === 1 ? 'pendiente de cierre' : 'pendientes de cierre', 'awaiting close')}</span>
        {current.pendingCount > 0 && <span>{current.pendingCount} {tx('operaciones pendientes fuera del total', 'pending operations excluded')}</span>}
        {current.registers.open.map(register => {
          const href = sectionHref('pos', { view: 'close', date, sessionId: register.id, month: date.slice(0, 7) })
          return <a key={register.id} href={href} onClick={e => { if (isPlainNavigation(e)) { e.preventDefault(); onNavigate(href) } }}>{register.operator}<ArrowRight size={14} /></a>
        })}
      </div>
    </>}
  </section>
}
