import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, History, Search, SlidersHorizontal, X } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { businessDayKey } from './registerDay.js'
import { NumberedPagination } from './ui.jsx'

const filters = [
  ['all', 'activityAllTypes'],
  ['stock_in', 'activityEntries'],
  ['stock_out', 'activityExits'],
  ['adjustment', 'activityAdjustments'],
  ['web', 'activityWebReservations'],
]
const movementIcons = { stock_in: ArrowUp, stock_out: ArrowDown, adjustment: SlidersHorizontal }

function isWebReservation({ reservationId, note }) {
  return Boolean(reservationId) || /^Reserva online\b/i.test(note)
}

function reasonKey(movement) {
  const { type, note } = movement
  if (isWebReservation(movement)) {
    if (/^Reserva online vencida\b/i.test(note)) return 'activityWebExpired'
    return type === 'stock_in' ? 'activityWebReleased' : 'activityWebHeld'
  }
  if (note === 'Opening stock') return 'openingStock'
  if (/^Sale #/i.test(note)) return 'activityCounterSale'
  if (/^Reserved for (?:card|Point) sale #/i.test(note)) return 'activityPointHeld'
  if (/^(?:Card|Point) sale #.+stock restored$/i.test(note)) return 'activityPointRestored'
  if (/^(?:Point )?Refund #/i.test(note)) return 'activityRefund'
  return type === 'stock_in' ? 'stockReceived' : type === 'stock_out' ? 'stockRemoved' : 'countCorrected'
}

function MovementRow({ movement, quantity, time }) {
  const { t } = useI18n()
  const Icon = movementIcons[movement.type] || SlidersHorizontal
  const reason = t(reasonKey(movement))
  const after = movement.balanceAfter
  const delta = movement.quantity
  const signedDelta = quantity(delta, true)
  const deltaTone = delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''
  const before = Number.isFinite(after) && Number.isFinite(delta) ? after - delta : null

  return <details className="stock-activity-movement">
    <summary className="stock-activity-row">
      <span className={`movement-icon ${movement.type}`}><Icon size={18} aria-hidden="true" /></span>
      <strong className="stock-activity-product">{movement.itemName}</strong>
      <span className="stock-activity-reason">{reason}</span>
      <strong className={`stock-activity-delta ${deltaTone}`}><span className="sr-only">{t('activityChange')}: </span>{signedDelta}</strong>
      <span className="stock-activity-after"><span className="sr-only">{t('activityStockAfter')}: </span>{quantity(after)}</span>
      <time className="stock-activity-time" dateTime={movement.createdAt}>{time.format(new Date(movement.createdAt))}</time>
      <ChevronDown className="stock-activity-chevron" size={17} aria-hidden="true" />
    </summary>
    <div className="stock-activity-detail">
      <dl className="stock-activity-balances">
        <div><dt>{t('activityStockBefore')}</dt><dd>{quantity(before)}</dd></div>
        <div><dt>{t('activityChange')}</dt><dd className={deltaTone}>{signedDelta}</dd></div>
        <div><dt>{t('activityStockAfter')}</dt><dd>{quantity(after)}</dd></div>
      </dl>
      {movement.note && movement.note !== 'Opening stock' && <p><strong>{t('note')}</strong> {movement.note}</p>}
    </div>
  </details>
}

export default function ActivityPage({ items, movements, dayKey, timeZone = 'America/Santiago' }) {
  const { t, language, formatDate } = useI18n()
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState(null)
  const controls = useRef(null)
  const query = search.trim()
  const key = JSON.stringify([query, type, page, retry])
  useEffect(() => {
    const controller = new AbortController()
    api.movementHistory({ search: query, type, page }, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }) })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: true }) })
    return () => controller.abort()
  }, [key, query, type, page, movements, items])

  const current = result?.key === key ? result : null
  const data = current?.data
  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0
  function goToPage(next) {
    if (next === data.page) return
    setPage(next)
    controls.current?.scrollIntoView({ block: 'start' })
  }

  const groups = new Map()
  for (const movement of data?.movements || []) {
    const day = businessDayKey(movement.createdAt, timeZone)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day).push(movement)
  }

  const locale = language === 'es' ? 'es-CL' : 'en-US'
  const time = new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' })
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const quantity = (value, signed = false) => {
    if (!Number.isFinite(value)) return '—'
    return `${signed && value > 0 ? '+' : ''}${number.format(value === 0 ? 0 : value)}`
  }
  const filtered = Boolean(query) || type !== 'all'

  return <div className="page enter activity-page">
    <section className="card stock-activity" aria-label={t('stockMovementHistory')} aria-busy={!current}>
      <header className="stock-activity-controls" ref={controls}>
        <div className="search-box">
          <Search size={18} aria-hidden="true" />
          <input type="search" maxLength={120} aria-label={t('activitySearch')} placeholder={t('activitySearchPlaceholder')} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />
          {search && <button type="button" aria-label={t('clearSearch')} onClick={() => { setSearch(''); setPage(1) }}><X size={16} /></button>}
        </div>
        <select aria-label={t('activityFilterType')} value={type} onChange={event => { setType(event.target.value); setPage(1) }}>
          {filters.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </header>
      {!current ? <div className="stock-activity-empty" role="status">{t('activityLoading')}</div> : current.error ?
        <div className="stock-activity-empty">
          <strong role="alert">{t('activityLoadError')}</strong>
          <button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>{t('serverRetry')}</button>
        </div> : groups.size ? <>
        <div className="stock-activity-columns stock-activity-row" aria-hidden="true">
          <span />
          <span>{t('product')}</span>
          <span>{t('activityReason')}</span>
          <span>{t('activityChange')}</span>
          <span>{t('activityStockAfter')}</span>
          <span>{t('activityTime')}</span>
        </div>
        {[...groups].map(([day, entries]) => <section className="stock-activity-day" key={day}>
          <h2>{day === dayKey ? t('today') : formatDate(day)}</h2>
          {entries.map(movement => <MovementRow key={movement.id} movement={movement} quantity={quantity} time={time} />)}
        </section>)}
      </> : <div className="stock-activity-empty">
        <History size={24} aria-hidden="true" />
        <strong>{t(filtered ? 'activityNoMatches' : 'noActivity')}</strong>
        {filtered && <button type="button" className="button secondary" onClick={() => { setSearch(''); setType('all'); setPage(1) }}>{t('activityClearFilters')}</button>}
      </div>}
      {data && <NumberedPagination label={t('activityPagination')} current={data.page} total={totalPages} onPageChange={goToPage} />}
    </section>
  </div>
}
