import { LoadingSkeleton } from './ui.jsx'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Banknote, Check, ChevronDown, CreditCard, Download, History, RotateCw, ShieldCheck } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { sectionHref } from './routes.js'
import CajaHeader from './CajaHeader.jsx'

const denominations = [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 10]
const emptyForm = data => {
  const c = data.closure
  return { openingCash: c?.openingCash ?? '', cashIn: c?.cashIn ?? Math.max(c?.cashAdjustments || 0, 0),
    cashOut: c?.cashOut ?? Math.max(-(c?.cashAdjustments || 0), 0), countedCash: c?.countedCash ?? '',
    countedCard: c?.countedCard ?? '', operator: c?.operator || '', terminalReference: c?.terminalReference || '', note: '',
    denominations: c?.denominations || Object.fromEntries(denominations.map(n => [n, 0])), useDenominations: Boolean(c?.denominations),
    expectedRevision: c?.revision || 0, fingerprint: data.live.fingerprint }
}

export default function CashClosurePage({ date, onNavigate, setToast, refreshToken }) {
  const { language, formatCurrency: money } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [data, setData] = useState(null), [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [reviewing, setReviewing] = useState(false), [exporting, setExporting] = useState(false)
  const [method, setMethod] = useState('all'), [kind, setKind] = useState('all')
  const generation = useRef(0)
  const dataRef = useRef(null)
  const requestSequence = useRef(0)
  const load = async (reset = false) => {
    const current = generation.current, sequence = ++requestSequence.current
    if (reset) { setLoading(true); setReviewing(false) }
    try {
      const next = await api.cashClosure(date)
      if (current !== generation.current || sequence !== requestSequence.current) return
      setData(next); dataRef.current = next
      if (reset || !dataRef.current) setForm(emptyForm(next))
      if (reset) setError('')
    } catch (e) { if (current === generation.current && sequence === requestSequence.current) setError(e.message) }
    finally { if (current === generation.current && sequence === requestSequence.current) setLoading(false) }
  }
  useEffect(() => {
    generation.current++
    setData(null); dataRef.current = null; setForm(null); setError(''); setReviewing(false)
    load(true)
    return () => { generation.current++ }
  }, [date])
  // Reuse the app's live update stream; keep a draft intact when another register changes the day.
  useEffect(() => { if (dataRef.current) load(false) }, [refreshToken])
  const update = key => event => { setForm(current => ({ ...current, [key]: event.target.value })); setReviewing(false) }
  const time = value => new Intl.DateTimeFormat(language === 'es' ? 'es-CL' : 'en-US', { timeZone: data.live.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  const exportPdf = async revision => {
    setExporting(true)
    try {
      const response = await fetch(api.cashClosurePdfUrl(data.live.businessDate, revision), { cache: 'no-store', signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error((await response.json()).error || tx('No se pudo exportar el PDF.', 'PDF export failed.'))
      const blob = await response.blob(), href = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = href; link.download = `bakery-pos-cierre-${data.live.businessDate}-v${revision}.pdf`; link.click()
      setTimeout(() => URL.revokeObjectURL(href), 10000)
      setToast({ type: 'success', message: tx(`PDF descargado · ${(blob.size / 1024).toFixed(1)} KB`, `PDF downloaded · ${(blob.size / 1024).toFixed(1)} KB`) })
    } catch (e) { setError(e.message) }
    finally { setExporting(false) }
  }
  const save = async () => {
    setBusy(true); setError('')
    try {
      const saved = await api.saveCashClosure({ ...form, businessDate: data.live.businessDate,
        denominations: form.useDenominations ? Object.fromEntries(Object.entries(form.denominations).map(([value, count]) => [value, Number(count || 0)])) : null })
      await load(true)
      setToast({ type: 'success', message: tx(`Cierre guardado · versión ${saved.revision}`, `Close saved · version ${saved.revision}`) })
    } catch (e) { setError(e.message); setReviewing(false); if (e.status === 409) await load(false) }
    finally { setBusy(false) }
  }
  const changed = data && form && (form.fingerprint !== data.live.fingerprint || form.expectedRevision !== (data.closure?.revision || 0))
  const expectedCash = data && form ? Number(form.openingCash || 0) + data.live.cash.net + Number(form.cashIn || 0) - Number(form.cashOut || 0) : 0
  const cashDifference = form?.countedCash === '' ? null : Number(form?.countedCash) - expectedCash
  const cardDifference = form?.countedCard === '' ? null : Number(form?.countedCard) - (data?.live.card.net || 0)
  const needsNote = data && form && (cashDifference || cardDifference || Number(form.cashIn) || Number(form.cashOut) || data.live.pendingCount || data.closure)
  const amountField = (key, label, hint, signed = false) => <label className="closure-field" key={key}><span>{label}</span><div className="closure-money"><span>$</span><input name={key} type="number" inputMode={signed ? 'text' : 'numeric'} min={signed ? undefined : 0} max="100000000000" step="1" required value={form[key]} onChange={update(key)} readOnly={key === 'countedCash' && form.useDenominations} placeholder="0" /></div>{hint && <small>{hint}</small>}</label>
  const statRow = (label, value, strong = false) => <div className={strong ? 'closure-total' : ''}><span>{label}</span><strong>{money(value)}</strong></div>
  const differenceRow = (label, value) => <div className={`closure-difference ${value == null ? '' : value === 0 ? 'balanced' : 'unbalanced'}`}><span>{label}</span><strong>{value == null ? tx('Por contar', 'Not counted') : value === 0 ? tx('Cuadrado · $0', 'Balanced · $0') : `${value > 0 ? '+' : ''}${money(value)}`}</strong></div>
  return <div className="page closure-page enter">
    <CajaHeader active="close" onNavigate={onNavigate} />
    <section className="closure-intro" aria-label={tx('Día y estado del cierre', 'Closing date and status')}>
      <div className="closure-tools"><input aria-label={tx('Día del cierre', 'Closing date')} title={tx('Fecha del cierre · Chile', 'Closing date · Chile')} type="date" value={date || data?.live.businessDate || ''} max={data?.today} min="2000-01-01" onChange={e => e.target.value && onNavigate(sectionHref('pos', { view: 'close', date: e.target.value }))} /><button type="button" className="icon-button" onClick={() => load(true)} disabled={loading || busy} aria-label={tx('Actualizar día y restablecer formulario', 'Refresh day and reset form')} title={tx('Actualizar día y restablecer formulario', 'Refresh day and reset form')}><RotateCw size={16} className={loading ? 'spin' : ''} /></button></div>
      {data && form && <div className={`closure-status ${data.stale || changed ? 'attention' : ''}`} role="status" title={data.closure ? `${time(data.closure.closedAt)} · ${data.closure.operator || ''}` : tx('Día completo · Chile · CLP', 'Full day · Chile · CLP')}><ShieldCheck size={16} /><strong>{changed ? tx('Actualizar cierre', 'Refresh close') : data.stale ? tx('Cambios sin incluir', 'Changes not included') : data.closure ? tx(`Guardado · v${data.closure.revision}`, `Saved · v${data.closure.revision}`) : tx('Sin cierre', 'Not closed')}</strong></div>}
    </section>
    {error && <div className="closure-notice error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
    {loading && !data && <LoadingSkeleton />}
    {data && form && <>
      {changed && <div className="closure-notice" role="status"><AlertTriangle size={16} /><span>{tx('El día cambió. Actualiza para continuar.', 'The day changed. Refresh to continue.')}</span></div>}
      <section className="closure-kpis" aria-label={tx('Resumen del día', 'Day summary')}>
        <article><span>{tx('Ventas', 'Sales')} <small>{data.live.transactions}</small></span><strong>{money(data.live.gross)}</strong></article>
        <article><span>{tx('Devoluciones', 'Refunds')} <small>{data.live.cash.refundCount + data.live.card.refundCount}</small></span><strong>{money(-data.live.refunds)}</strong></article>
        <article><span>{tx('Total neto', 'Net total')} <small>CLP</small></span><strong>{money(data.live.net)}</strong></article>
      </section>
      <form className="closure-form" onSubmit={event => { event.preventDefault(); setReviewing(true); setError('') }}>
        <div className="closure-methods">
          <section className="card closure-method"><header className="card-header"><div className="closure-method-title"><span className="metric-icon sage"><Banknote size={21} /></span><h3>{tx('Efectivo', 'Cash')}</h3></div><small>{data.live.cash.transactions} {tx('ventas', 'sales')}</small></header><div className="closure-method-body">
            <div className="closure-pair">{amountField('openingCash', tx('Fondo inicial', 'Opening cash'))}{amountField('countedCash', tx('Contado', 'Counted cash'))}</div>
            <div className="closure-ledger">{statRow(tx('Ventas', 'Sales'), data.live.cash.gross)}{statRow(tx('Devoluciones', 'Refunds'), -data.live.cash.refunds)}</div>
            <div className="closure-pair">{amountField('cashIn', tx('Entradas', 'Cash in'))}{amountField('cashOut', tx('Retiros', 'Cash out'))}</div>
            <label className="closure-check"><input type="checkbox" checked={form.useDenominations} onChange={e => {
              const enabled = e.target.checked
              setForm(f => ({ ...f, useDenominations: enabled, countedCash: enabled ? denominations.reduce((n, value) => n + value * Number(f.denominations[value] || 0), 0) : f.countedCash })); setReviewing(false)
            }} />{tx('Billetes y monedas', 'Banknotes and coins')}</label>
            {form.useDenominations && <div className="closure-denominations">{denominations.map(value => <label key={value}><span>{money(value)}</span><input aria-label={`${tx('Cantidad de', 'Number of')} ${money(value)}`} type="number" min="0" max="1000000" step="1" value={form.denominations[value]} onChange={e => {
              const count = e.target.value === '' ? '' : Number(e.target.value)
              setForm(f => { const next = { ...f.denominations, [value]: count }; return { ...f, denominations: next, countedCash: denominations.reduce((total, n) => total + n * Number(next[n] || 0), 0) } }); setReviewing(false)
            }} /></label>)}</div>}
            <div className="closure-ledger">{statRow(tx('Efectivo esperado', 'Expected cash'), expectedCash, true)}</div>
            {differenceRow(tx('Diferencia', 'Difference'), cashDifference)}
          </div></section>
          <section className="card closure-method"><header className="card-header"><div className="closure-method-title"><span className="metric-icon cocoa"><CreditCard size={21} /></span><h3>{tx('Tarjeta', 'Card')}</h3></div><small>{data.live.card.transactions} {tx('ventas', 'sales')}</small></header><div className="closure-method-body">
            <div className="closure-ledger">{statRow(tx('Ventas', 'Sales'), data.live.card.gross)}{statRow(tx('Devoluciones', 'Refunds'), -data.live.card.refunds)}{statRow(tx('Total esperado', 'Expected total'), data.live.card.net, true)}</div>
            {amountField('countedCard', tx('Total del terminal', 'Terminal total'), tx('Ventas menos devoluciones, sin comisiones.', 'Sales minus refunds, before fees.'), true)}
            <label className="closure-field"><span>{tx('Lote / referencia', 'Batch / reference')} <small>{tx('(opcional)', '(optional)')}</small></span><input maxLength="100" value={form.terminalReference} onChange={update('terminalReference')} placeholder={tx('Opcional', 'Optional')} /></label>
            {differenceRow(tx('Diferencia', 'Difference'), cardDifference)}
            <details className="closure-settlement"><summary>{tx('Comisiones y liquidación', 'Fees and settlement')}<ChevronDown size={15} /></summary><div className="closure-ledger">{statRow(tx('Comisiones', 'Fees'), data.live.card.recordedFees)}{statRow(tx('Neto del proveedor', 'Provider net'), data.live.card.recordedSettlement)}</div><p>{tx(`${data.live.card.reconciledTransactions} cobros con datos · ${data.live.card.unreconciledTransactions} sin datos. Información parcial; no confirma abono bancario.`, `${data.live.card.reconciledTransactions} collections with data · ${data.live.card.unreconciledTransactions} without data. Partial information; does not confirm a bank deposit.`)}</p></details>
          </div></section>
        </div>
        <section className="card closure-confirm"><div className="closure-pair"><label className="closure-field"><span>{tx('Responsable', 'Operator')}</span><input required maxLength="80" value={form.operator} onChange={update('operator')} autoComplete="name" placeholder={tx('Nombre de quien cuenta', 'Name of person counting')} /></label><label className="closure-field"><span>{tx('Observaciones', 'Notes')} {needsNote ? '*' : tx('(opcional)', '(optional)')}</span><textarea required={Boolean(needsNote)} maxLength="1000" rows="2" value={form.note} onChange={update('note')} placeholder={tx('Diferencias o movimientos…', 'Differences or cash movements…')} /></label></div>
          {data.live.pendingCount > 0 && <div className="closure-notice"><AlertTriangle size={18} /><span>{tx(`${data.live.pendingCount} pendientes fuera del total.`, `${data.live.pendingCount} pending operations excluded.`)}</span></div>}
          {reviewing && <div className="closure-review" role="status"><Check size={20} /><div><strong>{tx('Revisa antes de confirmar', 'Review before confirming')}</strong><p>{tx('Efectivo contado', 'Counted cash')}: {money(form.countedCash)} · {tx('Tarjeta declarada', 'Declared card')}: {money(form.countedCard)}</p><p>{tx('Diferencias', 'Differences')}: {tx('efectivo', 'cash')} {money(cashDifference)} / {tx('tarjeta', 'card')} {money(cardDifference)}</p></div></div>}
          <div className="closure-actions"><button type="button" className="button secondary" disabled={!data.closure?.snapshot || exporting} title={tx('Descargar cierre guardado', 'Download saved close')} aria-label={tx('Descargar PDF del cierre guardado', 'Download saved close PDF')} onClick={() => exportPdf(data.closure.revision)}><Download size={16} />{exporting ? tx('Preparando…', 'Preparing…') : 'PDF'}</button><div>{reviewing ? <><button type="button" className="button secondary" onClick={() => setReviewing(false)} disabled={busy}>{tx('Volver', 'Back')}</button><button type="button" className="button primary" onClick={save} disabled={busy || changed || loading}><Check size={17} />{busy ? tx('Guardando…', 'Saving…') : tx('Confirmar cierre', 'Confirm close')}</button></> : <button className="button primary" disabled={busy || changed || loading}>{tx(data.closure ? 'Revisar corrección' : 'Revisar cierre', data.closure ? 'Review correction' : 'Review close')}<ArrowRight size={17} /></button>}</div></div>
        </section>
      </form>
      {data.stale && <p className="closure-pdf-note">{tx('El PDF corresponde a la versión guardada.', 'The PDF reflects the saved version.')}</p>}
      <details className="card closure-operations"><summary className="closure-section-summary"><span>{tx('Operaciones', 'Operations')} <small>{data.live.operations.length}</small></span><ChevronDown size={17} /></summary><header className="card-header"><div className="closure-filters"><select aria-label={tx('Medio de pago', 'Payment method')} value={method} onChange={e => setMethod(e.target.value)}><option value="all">{tx('Todos los medios', 'All methods')}</option><option value="cash">{tx('Efectivo', 'Cash')}</option><option value="card">{tx('Tarjeta', 'Card')}</option></select><select aria-label={tx('Tipo de operación', 'Operation type')} value={kind} onChange={e => setKind(e.target.value)}><option value="all">{tx('Todos los tipos', 'All types')}</option><option value="sale">{tx('Ventas', 'Sales')}</option><option value="refund">{tx('Devoluciones', 'Refunds')}</option></select></div></header><div className="closure-table-wrap"><table className="closure-table"><thead><tr>{[tx('Fecha / venta', 'Date / sale'), tx('Operación', 'Operation'), tx('Detalle', 'Details'), tx('Referencia', 'Reference'), tx('Monto', 'Amount')].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{data.live.operations.filter(op => (method === 'all' || method === op.method) && (kind === 'all' || kind === op.type)).map(op => <tr key={op.id}><td><strong>{op.shortId}</strong><small>{time(op.at)}</small></td><td>{op.type === 'sale' ? tx('Venta', 'Sale') : tx('Devolución', 'Refund')}<small>{op.method === 'cash' ? tx('Efectivo', 'Cash') : tx('Tarjeta', 'Card')}</small></td><td><details><summary>{op.items.length} {tx('productos', 'products')}{op.reason ? ` · ${op.reason}` : ''}</summary>{op.items.map((item, i) => <div key={i}>{item.quantity} × {item.name} · {money(item.lineTotal)}</div>)}{op.originalSaleAt && <small>{tx('Venta original', 'Original sale')}: {time(op.originalSaleAt)}</small>}</details></td><td>{op.reference || '—'}{op.cardBrand && <small>{op.cardBrand} ···· {op.cardLastFour}</small>}</td><td className={op.amount < 0 ? 'negative' : ''}>{money(op.amount)}</td></tr>)}</tbody></table>{!data.live.operations.length && <p className="closure-empty">{tx('Sin operaciones cobradas en este día.', 'No collected operations this day.')}</p>}</div>{data.live.excluded.length > 0 && <details className="closure-excluded"><summary>{tx('Operaciones excluidas del total cobrado', 'Operations excluded from collections')} ({data.live.excluded.length})</summary>{data.live.excluded.map(op => <div key={op.id}><span>{op.shortId} · {op.type === 'refund' ? tx('Devolución', 'Refund') : tx('Venta', 'Sale')} · {op.status}</span><strong>{money(op.amount)}</strong></div>)}</details>}</details>
      {data.revisions.length > 0 && <details className="card closure-revisions"><summary className="closure-section-summary"><span><History size={16} />{tx('Versiones', 'Versions')} <small>{data.revisions.length}</small></span><ChevronDown size={17} /></summary>{[...data.revisions].reverse().map(version => <div key={version.revision}><div><strong>{tx('Versión', 'Version')} {version.revision} · {version.operator || tx('Registro anterior', 'Legacy record')}</strong><span>{time(version.closedAt)}</span>{version.note && <p>{version.note}</p>}</div><button type="button" className="button secondary" disabled={exporting || !version.exportable} onClick={() => exportPdf(version.revision)}><Download size={15} />PDF</button></div>)}</details>}
    </>}
  </div>
}
