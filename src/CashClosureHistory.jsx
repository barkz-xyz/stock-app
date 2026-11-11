import { useEffect, useState } from 'react'
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, History, RotateCw } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { isPlainNavigation, sectionHref } from './routes.js'

function adjacentMonth(month, delta) {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value - 1 + delta, 1)).toISOString().slice(0, 7)
}

export default function CashClosureHistory({ month, currentMonth, user, onNavigate, refreshToken }) {
  const { language, formatCurrency: money } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [page, setPage] = useState({ month, offset: 0 })
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const offset = page.month === month ? page.offset : 0
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= '2000-01' && month <= currentMonth
  const dateFormatter = new Intl.DateTimeFormat(language === 'es' ? 'es-CL' : 'en-US', { timeZone: 'UTC', dateStyle: 'medium' })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    api.closureHistory(month, offset, { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) setData(next)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [month, offset, refreshToken, reload])
  const changeMonth = value => onNavigate(sectionHref('pos', { view: 'close', closureView: 'history', month: value }))
  return <section className="card closure-history" aria-label={tx('Historial mensual de cierres', 'Monthly close history')}>
    <header className="closure-history-heading">
      <div><h2>{tx('Historial de cierres', 'Close history')}</h2><p>{user?.role === 'admin' ? tx('Consulta las cajas del equipo y sus cierres.', 'View the team’s registers and closes.') : tx('Consulta tus cajas pendientes y cierres guardados.', 'View your pending registers and saved closes.')}</p></div>
      <span className="closure-history-count">{data ? `${data.total} ${data.total === 1 ? tx('registro', 'entry') : tx('registros', 'entries')}` : '—'}</span>
    </header>
    <div className="closure-history-toolbar">
      <label><span>{tx('Mes de caja', 'Register month')}</span><div className="closure-month-control"><CalendarDays size={17} aria-hidden="true" /><input type="month" aria-label={tx('Mes del historial', 'History month')} value={validMonth ? month : ''} min="2000-01" max={currentMonth} onChange={e => e.target.value && changeMonth(e.target.value)} /></div></label>
      <div className="closure-month-arrows">
        <button type="button" className="icon-button" aria-label={tx('Mes anterior', 'Previous month')} disabled={!validMonth || month <= '2000-01'} onClick={() => changeMonth(adjacentMonth(month, -1))}><ChevronLeft size={18} /></button>
        <button type="button" className="icon-button" aria-label={tx('Mes siguiente', 'Next month')} disabled={!validMonth || month >= currentMonth} onClick={() => changeMonth(adjacentMonth(month, 1))}><ChevronRight size={18} /></button>
      </div>
      <button type="button" className="icon-button closure-history-refresh" aria-label={tx('Actualizar historial de cierres', 'Refresh close history')} disabled={loading} onClick={() => setReload(n => n + 1)}><RotateCw size={17} className={loading ? 'spin' : ''} /></button>
    </div>
    {error && <div className="closure-notice error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button className="text-button" onClick={() => setReload(n => n + 1)}>{tx('Reintentar', 'Retry')}</button></div>}
    <div className="closure-history-list" aria-busy={loading}>
      {loading ? <p className="closure-empty" role="status">{tx('Cargando cierres…', 'Loading closes…')}</p> : data?.entries.length ? <>
        <div className="closure-history-columns" aria-hidden="true"><span>{tx('Caja', 'Register')}</span><span>{tx('Efectivo contado', 'Counted cash')}</span><span>{tx('Diferencia', 'Difference')}</span><span /></div>
        {data.entries.map(entry => {
          const archived = entry.scope === 'day'
          const archivedWithoutPdf = archived && !entry.exportable
          const Row = archivedWithoutPdf ? 'div' : 'a'
          const href = archived ? api.cashClosurePdfUrl(entry.businessDate, entry.revision) :
            sectionHref('pos', { view: 'close', sessionId: entry.registerSessionId, date: entry.businessDate, month })
          const closedLabel = dateFormatter.format(new Date(`${entry.businessDate}T12:00:00Z`))
          const isOpen = entry.status === 'open'
          const archivedLabel = archivedWithoutPdf ? tx('Cierre diario anterior · Sin PDF', 'Former daily close · No PDF') : tx('Cierre diario anterior · PDF', 'Former daily close · PDF')
          return <Row className="closure-history-row" key={`${entry.scope}:${entry.id}`} href={archivedWithoutPdf ? undefined : href}
            aria-label={archivedWithoutPdf ? undefined : `${archived ? tx('Descargar cierre diario anterior', 'Download former daily close') : isOpen ? tx('Abrir caja pendiente','Open pending register') : tx('Abrir y modificar cierre', 'Open and edit close')} · ${entry.operator || tx('General diario', 'Full daily')} · ${closedLabel}`}
            download={archived && entry.exportable || undefined} onClick={archived ? undefined : e => { if (isPlainNavigation(e)) { e.preventDefault(); onNavigate(href) } }}>
            <div className="closure-history-reference"><span className="closure-history-icon"><History size={18} /></span><div><strong>{entry.operator || tx('General diario', 'Full daily')}</strong><time dateTime={entry.businessDate}>{closedLabel}</time><small className={isOpen ? 'closure-open-state' : ''}>{isOpen ? tx('Abierta · Pendiente de cierre','Open · Awaiting close') : `${archived ? archivedLabel : tx('Cerrada', 'Closed')} · v${entry.revision}`}</small></div></div>
            <div className="closure-history-amount"><small>{tx('Contado', 'Counted')}</small><strong>{isOpen ? '—' : money(entry.countedCash)}</strong></div>
            <div className={`closure-history-difference ${isOpen ? '' : entry.difference === 0 ? 'balanced' : 'unbalanced'}`}><small>{tx('Diferencia', 'Difference')}</small><strong>{isOpen ? tx('Sin cierre','Not closed') : `${entry.difference > 0 ? '+' : ''}${money(entry.difference)}`}</strong></div>
            {!archivedWithoutPdf && <ChevronRight size={18} aria-hidden="true" />}
          </Row>
        })}
      </> : data && <div className="closure-history-empty"><CalendarDays size={28} /><strong>{tx('No hay cajas en este mes', 'No registers this month')}</strong><p>{tx('Selecciona otro mes para consultar el historial.', 'Select another month to view its history.')}</p></div>}
    </div>
    {data && data.total > 0 && <footer className="history-pagination"><span>{data.entries.length ? `${offset + 1}–${offset + data.entries.length}` : '0'} {tx('de', 'of')} {data.total}</span><button className="button secondary" disabled={loading || offset === 0} onClick={() => setPage({ month, offset: Math.max(0, offset - data.limit) })}><ChevronLeft size={16} />{tx('Anterior', 'Previous')}</button><button className="button secondary" disabled={loading || !data.hasMore} onClick={() => setPage({ month, offset: offset + data.limit })}>{tx('Siguiente', 'Next')}<ChevronRight size={16} /></button></footer>}
  </section>
}
