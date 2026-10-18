import { useRef, useState } from 'react'
import { AlertTriangle, Check, Search } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { formatQuantity } from './ui.jsx'
import { searchText, loadPendingBatch, savePendingBatch } from './posWorkspace.js'

export default function InventoryBatch({ items, onSaved, onClose }) {
  const { t, unitLabel } = useI18n()
  const [pending] = useState(loadPendingBatch)
  const rows = useRef(pending?.rows || items).current
  const [type, setType] = useState(pending?.body.type || 'stock_in'), [values, setValues] = useState(() => Object.fromEntries((pending?.body.items || []).map(i => [i.itemId,String(i.quantity)]))), [search, setSearch] = useState('')
  const [note, setNote] = useState(pending?.body.note || ''), [busy, setBusy] = useState(false), [error, setError] = useState(pending ? t('batchRetryHint') : '')
  const frozen = useRef(pending), submitting = useRef(false)
  const selected = rows.filter(i => values[i.id] !== undefined && values[i.id] !== '')
  const visible = rows.filter(i => searchText(`${i.name} ${i.sku}`).includes(searchText(search)))
  const invalid = selected.some(i => !Number.isFinite(Number(values[i.id])) || Number(values[i.id]) < (type === 'stock_in' ? .01 : 0) || Number(values[i.id]) > 1000000)
  const submit = async e => {
    e.preventDefault()
    if (submitting.current || !selected.length || invalid) return
    submitting.current = true; setBusy(true); setError('')
    frozen.current ||= { key: crypto.randomUUID(), rows, body: { type, note, items: selected.map(i => ({ itemId: i.id, quantity: Number(values[i.id]), expectedQuantity: i.quantity })) } }
    savePendingBatch(frozen.current)
    try {
      await api.inventoryBatch(frozen.current.body, frozen.current.key)
      savePendingBatch(null)
      await onSaved()
    } catch (e) {
      setError(e.message)
      if (e.status && e.status < 500 && e.status !== 408) { frozen.current = null; savePendingBatch(null) }
    } finally { submitting.current = false; setBusy(false) }
  }
  const locked = busy || Boolean(frozen.current)
  return <form className="batch-form" onSubmit={submit}>
    <div className="segmented"><button type="button" disabled={locked} className={type === 'stock_in' ? 'active' : ''} onClick={() => { setType('stock_in'); setValues({}) }}>{t('productionEntry')}</button><button type="button" disabled={locked} className={type === 'adjustment' ? 'active' : ''} onClick={() => { setType('adjustment'); setValues({}) }}>{t('physicalCount')}</button></div>
    <label className="search-box"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchPlaceholder')} aria-label={t('searchProducts')} /></label>
    <div className="batch-head"><span>{t('product')}</span><span>{t(type === 'stock_in' ? 'stockIn' : 'countedStock')}</span></div>
    <div className="batch-lines">{visible.map(i => <label key={i.id}><span><strong>{i.name}</strong><small>{formatQuantity(i.quantity)} {unitLabel(i.unit)}{values[i.id] !== undefined && values[i.id] !== '' && <> → {formatQuantity(type === 'stock_in' ? i.quantity + Number(values[i.id]) : Number(values[i.id]))}</>}</small></span><input type="number" inputMode="decimal" min={type === 'stock_in' ? '.01' : '0'} max="1000000" step=".01" value={values[i.id] ?? ''} disabled={locked} onChange={e => setValues(v => ({ ...v, [i.id]: e.target.value }))} placeholder="—" aria-label={`${t('quantity')}: ${i.name}`} /></label>)}{!visible.length && <p>{t('noProductsFound')}</p>}</div>
    <label className="field"><span>{t('note')} · {t('optional')}</span><input maxLength={300} value={note} disabled={locked} onChange={e => setNote(e.target.value)} /></label>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={16} />{error}{frozen.current && <small>{t('batchRetryHint')}</small>}</div>}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy || Boolean(frozen.current)} onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={busy || !selected.length || invalid}><Check size={17} />{busy ? t('saving') : frozen.current ? t('retryConnection') : t('saveBatch', { count: selected.length })}</button></div>
  </form>
}
