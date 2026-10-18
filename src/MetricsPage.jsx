import { useEffect, useState } from 'react'
import { ArrowRight, BadgeCheck, Banknote, BarChart3, Boxes, Calculator, Check, CreditCard, Download, ReceiptText, RotateCw, TrendingDown, TrendingUp, WalletCards } from 'lucide-react'

import { useI18n } from './i18n.js'
import { formatQuantity } from './ui.jsx'

function BarSeries({ data, valueKey = 'revenue', formatValue }) {
  const { t } = useI18n()
  const max = Math.max(...data.map((entry) => Number(entry[valueKey]) || 0), 1)
  const hasData = data.some((entry) => Number(entry[valueKey]) > 0)
  const entryKey = (entry) => String(entry.key ?? entry.date ?? entry.hour)
  const suggested = data.reduce((best, entry) => Number(entry[valueKey]) > Number(best?.[valueKey] || 0) ? entry : best, data[0])
  const signature = data.map((entry) => `${entryKey(entry)}:${entry[valueKey]}:${entry.transactions}`).join('|')
  const [activeKey, setActiveKey] = useState(() => suggested ? entryKey(suggested) : null)
  useEffect(() => { if (suggested) setActiveKey(entryKey(suggested)) }, [signature])
  const active = data.find((entry) => entryKey(entry) === activeKey) || suggested
  return <div className="chart-shell">
    <div className="chart-scroll"><div className={`bar-series ${data.length > 12 ? 'dense' : ''}`} style={{ '--columns': data.length }}>
      {data.map((entry) => {
        const value = Number(entry[valueKey]) || 0
        const key = entryKey(entry)
        const label = entry.detailLabel || entry.label
        return <button type="button" className={`bar-column ${active && entryKey(active) === key ? 'active' : ''}`} key={key} title={`${label}: ${formatValue(value)}`} aria-label={t('chartBarLabel', { label, value: formatValue(value), count: entry.transactions || 0 })} aria-pressed={active && entryKey(active) === key} onMouseEnter={() => setActiveKey(key)} onFocus={() => setActiveKey(key)} onClick={() => setActiveKey(key)}>
          <div className="bar-value">{value > 0 ? formatValue(value) : ''}</div>
          <div className="bar-well"><i style={{ height: value > 0 ? `${Math.max((value / max) * 100, 4)}%` : '2px' }} /></div>
          <span>{entry.label}</span>
        </button>
      })}
      {!hasData && <div className="chart-empty-line" />}
    </div></div>
    {active && <div className="chart-detail" aria-live="polite"><div className="chart-detail-mark"><BarChart3 size={18} /></div><div><span>{t('selectedPeriod')}</span><strong>{active.detailLabel || active.label}</strong></div><div><span>{t('revenue')}</span><strong>{formatValue(active[valueKey])}</strong></div><div><span>{t('transactions')}</span><strong>{active.transactions || 0}</strong></div><small>{t('chartInteractionHint')}</small></div>}
  </div>
}

function dailySeries(source, range, language) {
  const count = range === '30d' ? 30 : range === '7d' ? 7 : 1
  const indexed = new Map(source.map((entry) => [entry.date, entry]))
  const formatter = new Intl.DateTimeFormat(language === 'es' ? 'es-CL' : 'en-US', { day: 'numeric', month: 'short' })
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (count - index - 1))
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { key, date: key, label: formatter.format(date), revenue: indexed.get(key)?.revenue || 0, transactions: indexed.get(key)?.transactions || 0 }
  })
}

export function CashCloseForm({ metrics, onSubmit, onClose, busy }) {
  const { t, formatCurrency } = useI18n()
  const existing = metrics.cashClosure
  const [form, setForm] = useState({
    openingCash: existing?.openingCash ?? '', cashAdjustments: existing?.cashAdjustments ?? '',
    countedCash: existing?.countedCash ?? '', note: existing?.note || '',
  })
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const openingCash = Number(form.openingCash || 0)
  const adjustments = Number(form.cashAdjustments || 0)
  const countedCash = Number(form.countedCash || 0)
  const expected = openingCash + metrics.today.cashRevenue + adjustments
  const difference = countedCash - expected
  return <form className="form-stack close-form" onSubmit={(event) => { event.preventDefault(); onSubmit(form) }}>
    <div className="close-live-summary">
      <div><span>{t('cashToday')}</span><strong>{formatCurrency(metrics.today.cashRevenue)}</strong></div>
      <div><span>{t('pointToday')}</span><strong>{formatCurrency(metrics.today.cardRevenue)}</strong></div>
      <div><span>{t('transactions')}</span><strong>{metrics.today.transactions}</strong></div>
    </div>
    <div className="form-grid">
      <div className="field"><label htmlFor="opening-cash">{t('openingCash')}</label><input id="opening-cash" type="number" min="0" step="1" required value={form.openingCash} onChange={update('openingCash')} placeholder="0" /></div>
      <div className="field"><label htmlFor="cash-adjustments">{t('cashAdjustments')}</label><input id="cash-adjustments" type="number" step="1" value={form.cashAdjustments} onChange={update('cashAdjustments')} placeholder="0" /></div>
      <p className="field-hint">{t('cashAdjustmentsHint')}</p>
      <div className="field full"><label htmlFor="counted-cash">{t('countedCashLabel')}</label><input id="counted-cash" type="number" min="0" step="1" required value={form.countedCash} onChange={update('countedCash')} placeholder="0" /></div>
    </div>
    <div className="cash-calculation">
      <div><span>{t('expectedCash')}</span><strong>{formatCurrency(expected)}</strong></div>
      <div className={difference === 0 ? 'balanced' : difference > 0 ? 'positive' : 'negative'}><span>{t('cashDifference')}</span><strong>{difference > 0 ? '+' : ''}{formatCurrency(difference)}</strong></div>
    </div>
    <div className="field full"><label htmlFor="closing-note">{t('closingNote')} <span>{t('optional')}</span></label><textarea id="closing-note" rows="3" value={form.note} onChange={update('note')} placeholder={t('closingNotePlaceholder')} /></div>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('savingClose') : t('saveClose')}<Check size={18} /></button></div>
  </form>
}

export default function MetricsPage({ metrics, range, onRangeChange, onRefresh, onOpenClose, onExport, loading, exporting }) {
  const { t, language, formatCurrency, formatTime } = useI18n()
  if (loading && !metrics) return <div className="page analytics-page"><div className="analytics-loading"><div className="loader-mark"><BarChart3 size={27} /></div><span>{t('preparing')}</span></div></div>
  const data = metrics || {
    summary: {}, paymentMethods: { cash: {}, card: {} }, daily: [], hourly: [], topProducts: [], today: {}, cashClosure: null,
  }
  const summary = data.summary
  const trendPositive = summary.revenueChangePct !== null && summary.revenueChangePct >= 0
  const daily = dailySeries(data.daily, range, language)
  const hourly = data.hourly.map((entry) => ({ ...entry, detailLabel: `${String(entry.hour).padStart(2, '0')}:00`, label: entry.hour % 3 === 0 ? `${String(entry.hour).padStart(2, '0')}:00` : '' }))
  const paymentShare = (amount) => summary.revenue ? Math.round((amount / summary.revenue) * 100) : 0
  const close = data.cashClosure
  const differenceTone = !close || close.difference === 0 ? 'balanced' : close.difference > 0 ? 'positive' : 'negative'
  return <div className="page enter analytics-page">
    <section className="page-heading analytics-heading"><div><span className="eyebrow">{t('businessIntelligence')}</span><h1>{t('metricsTitle')}</h1><p>{t('metricsDescription')}</p></div><div className="analytics-actions"><button className="button secondary report-export-button" onClick={onExport} disabled={exporting}><Download size={17} /><span>{exporting ? t('exportingReport') : t('exportDailyReport')}</span></button><div className="range-switch" role="group" aria-label={t('metricsTitle')}>{[['today', 'periodToday'], ['7d', 'period7Days'], ['30d', 'period30Days']].map(([id, key]) => <button key={id} className={range === id ? 'active' : ''} onClick={() => onRangeChange(id)}>{t(key)}</button>)}</div><button className="icon-button" onClick={onRefresh} aria-label={t('refreshMetrics')} title={t('refreshMetrics')}><RotateCw size={18} className={loading ? 'spin' : ''} /></button></div></section>

    <section className="analytics-kpis">
      <article><div className="metric-icon cocoa"><ReceiptText size={20} /></div><span>{t('collectedSales')}</span><strong>{formatCurrency(summary.revenue)}</strong><small className={trendPositive ? 'positive' : 'negative'}>{summary.revenueChangePct === null ? t('noPreviousComparison') : <>{trendPositive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{t('comparedWithPrevious', { value: Math.abs(summary.revenueChangePct) })}</>}</small></article>
      <article><div className="metric-icon sage"><WalletCards size={20} /></div><span>{t('transactions')}</span><strong>{summary.transactions || 0}</strong><small>{t('exactReconciliation')}</small></article>
      <article><div className="metric-icon amber"><Calculator size={20} /></div><span>{t('averageTicket')}</span><strong>{formatCurrency(summary.averageTicket)}</strong><small>{t('collectedSales')}</small></article>
      <article><div className="metric-icon rose"><Boxes size={20} /></div><span>{t('unitsSold')}</span><strong>{formatQuantity(summary.itemsSold || 0)}</strong><small>{t('itemsPerTicket')}: {formatQuantity(summary.itemsPerTransaction || 0)}</small></article>
    </section>

    <section className="analytics-main-grid">
      <article className="card chart-card"><header className="card-header"><div><span className="eyebrow">{t('salesAnalytics')}</span><h2>{range === 'today' ? t('revenueByHour') : t('revenueByDay')}</h2></div><strong>{formatCurrency(summary.revenue)}</strong></header><BarSeries data={range === 'today' ? hourly : daily} formatValue={formatCurrency} /></article>
      <article className="card payment-mix-card"><header className="card-header"><div><span className="eyebrow">{t('exactReconciliation')}</span><h2>{t('paymentMix')}</h2></div></header><div className="payment-metrics">
        {[['cash', t('cashSales'), Banknote, 'sage'], ['card', t('pointSales'), CreditCard, 'cocoa']].map(([method, label, Icon, tone]) => { const item = data.paymentMethods[method] || {}; const share = paymentShare(item.revenue || 0); return <div className="payment-metric" key={method}><div className={`payment-metric-icon ${tone}`}><Icon size={19} /></div><div><span>{label}</span><strong>{formatCurrency(item.revenue)}</strong><small>{item.transactions || 0} {t('transactions').toLowerCase()}</small></div><b>{share}%</b><div className="payment-track"><i style={{ width: `${share}%` }} /></div></div> })}
      </div></article>
    </section>

    <section className="analytics-lower-grid">
      {range !== 'today' && <article className="card chart-card hourly-card"><header className="card-header"><div><span className="eyebrow">{t('hourlyDemand')}</span><h2>{t('revenueByHour')}</h2><p>{t('hourlyDemandDescription')}</p></div></header><BarSeries data={hourly} formatValue={formatCurrency} /></article>}
      <article className="card top-products-card"><header className="card-header"><div><span className="eyebrow">{t('bestSeller')}</span><h2>{t('topProducts')}</h2><p>{t('topProductsDescription')}</p></div></header>{data.topProducts.length ? <div className="top-products-list">{data.topProducts.map((product, index) => <div key={product.itemId || product.name}><b>{String(index + 1).padStart(2, '0')}</b><div><span><strong>{product.name}</strong><small>{t('soldQuantity', { count: formatQuantity(product.quantity) })}</small></span><span><strong>{formatCurrency(product.revenue)}</strong><small>{product.revenueShare}%</small></span><div><i style={{ width: `${product.revenueShare}%` }} /></div></div></div>)}</div> : <div className="analytics-empty"><BarChart3 size={28} /><p>{t('noSalesForPeriod')}</p></div>}</article>
    </section>

    <section className="operations-strip" aria-label={t('operationalPulse')}>
      <div className="operations-title"><span className="eyebrow">{t('operationalPulse')}</span><strong>{summary.pendingPoint || summary.failedPayments ? t('needsReview') : t('allReconciled')}</strong></div>
      <div><span>{t('pendingPointPayments')}</span><strong>{summary.pendingPoint || 0}</strong></div>
      <div><span>{t('failedPayments')}</span><strong>{summary.failedPayments || 0}</strong></div>
      <div><span>{t('refundedAmount')}</span><strong>{formatCurrency(summary.refundedTotal)}</strong></div>
      <div><span>{t('itemsPerTicket')}</span><strong>{formatQuantity(summary.itemsPerTransaction || 0)}</strong></div>
    </section>

    <section className="card cash-close-card"><div className="cash-close-copy"><div className="cash-close-icon"><Calculator size={24} /></div><div><span className="eyebrow">{t('closeSummary')}</span><h2>{t('dayClose')}</h2><p>{t('dayCloseDescription')}</p></div></div><div className="cash-close-numbers"><div><span>{t('todayCollected')}</span><strong>{formatCurrency(data.today.revenue)}</strong></div><div><span>{t('cashToday')}</span><strong>{formatCurrency(data.today.cashRevenue)}</strong></div><div><span>{t('pointToday')}</span><strong>{formatCurrency(data.today.cardRevenue)}</strong></div>{close && <><div><span>{t('expectedCash')}</span><strong>{formatCurrency(close.expectedCash)}</strong></div><div className={differenceTone}><span>{close.difference === 0 ? t('closeBalanced') : t('cashDifference')}</span><strong>{close.difference > 0 ? '+' : ''}{formatCurrency(close.difference)}</strong></div></>}</div><div className="cash-close-action">{close && <span><BadgeCheck size={16} />{t('closedAt', { time: formatTime(close.closedAt) })}</span>}<button className="button primary" onClick={onOpenClose}>{close ? t('updateClose') : t('registerClose')}<ArrowRight size={18} /></button></div></section>
  </div>
}
