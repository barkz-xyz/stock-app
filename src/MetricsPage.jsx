import { useEffect, useState } from 'react'
import { Banknote, BarChart3, Boxes, Calculator, CreditCard, Download, Globe, ReceiptText, RotateCw, TrendingDown, TrendingUp, WalletCards } from 'lucide-react'

import { useI18n } from './i18n.js'
import { businessDayKey } from './registerDay.js'
import { LoadingSkeleton } from './ui.jsx'

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
    {active && <div className="chart-detail" aria-live="polite"><div className="chart-detail-mark"><BarChart3 size={18} /></div><div><strong>{active.detailLabel || active.label}</strong></div><div><span>{t('revenue')}</span><strong>{formatValue(active[valueKey])}</strong></div><div><span>{t('transactions')}</span><strong>{active.transactions || 0}</strong></div></div>}
  </div>
}

function dailySeries(source, range, language, businessDate) {
  const count = range === '30d' ? 30 : 7
  const indexed = new Map(source.map((entry) => [entry.date, entry]))
  const formatter = new Intl.DateTimeFormat(language === 'es' ? 'es-CL' : 'en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`${businessDate}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - (count - index - 1))
    const key = date.toISOString().slice(0, 10)
    const detailLabel = formatter.format(date)
    const showLabel = count !== 30 || index % 6 === 0 || index === count - 1
    return { key, date: key, detailLabel, label: showLabel ? detailLabel : '', revenue: indexed.get(key)?.revenue || 0, transactions: indexed.get(key)?.transactions || 0 }
  })
}

function MetricTile({ icon: Icon, tone, label, value, detail, trend }) {
  return <article>
    <div className={`metric-icon ${tone}`}><Icon size={18} aria-hidden="true" /></div>
    <div className="metric-tile-content">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small className={trend}>{detail}</small>}
    </div>
  </article>
}

export default function MetricsPage({ metrics, range, onRangeChange, onRefresh, onExport, loading, exporting }) {
  const { t, language, formatCurrency } = useI18n()
  if (loading && !metrics) return <LoadingSkeleton />
  const data = metrics || {
    summary: {}, paymentMethods: { cash: {}, card: {} }, daily: [], hourly: [], topProducts: [],
  }
  const summary = data.summary
  const chartRange = data.range || range
  const formatQuantity = new Intl.NumberFormat(language === 'es' ? 'es-CL' : 'en-US', { maximumFractionDigits: 2 }).format
  const revenueChange = summary.revenueChangePct ?? null
  const revenueTrend = revenueChange > 0 ? 'positive' : revenueChange < 0 ? 'negative' : undefined
  const revenueComparison = revenueChange === null ? t('noPreviousComparison') : <>
    {revenueTrend === 'positive' && <TrendingUp size={13} aria-hidden="true" />}
    {revenueTrend === 'negative' && <TrendingDown size={13} aria-hidden="true" />}
    <span>{t('comparedWithPrevious', { value: `${revenueChange > 0 ? '+' : ''}${formatQuantity(revenueChange)}` })}</span>
  </>
  const chart = chartRange === 'today'
    ? data.hourly.map(entry => {
      const detailLabel = `${String(entry.hour).padStart(2, '0')}:00`
      return { ...entry, detailLabel, label: entry.hour % 4 === 0 ? detailLabel : '' }
    })
    : dailySeries(data.daily, chartRange, language, data.businessDate || businessDayKey())
  const paymentShare = (amount) => summary.revenue ? Math.round((amount / summary.revenue) * 100) : 0
  return <div className="page enter analytics-page" aria-busy={loading}>
    <div className="page-actions analytics-heading"><div className="analytics-actions"><button className="button secondary report-export-button" onClick={onExport} disabled={exporting}><Download size={17} /><span>{exporting ? t('exportingReport') : t('exportDailyReport')}</span></button><div className="range-switch" role="group" aria-label={t('metricsTitle')}>{[['today', 'periodToday'], ['7d', 'period7Days'], ['30d', 'period30Days']].map(([id, key]) => <button key={id} className={range === id ? 'active' : ''} aria-pressed={range === id} onClick={() => onRangeChange(id)}>{t(key)}</button>)}</div><button className="icon-button" onClick={onRefresh} aria-label={t('refreshMetrics')} title={t('refreshMetrics')}><RotateCw size={18} className={loading ? 'spin' : ''} /></button></div></div>

    <section className="analytics-kpis">
      <MetricTile icon={ReceiptText} tone="cocoa" label={t('collectedSales')} value={formatCurrency(summary.revenue)} detail={revenueComparison} trend={revenueTrend} />
      <MetricTile icon={WalletCards} tone="sage" label={t('transactions')} value={summary.transactions || 0} />
      <MetricTile icon={Calculator} tone="amber" label={t('averageTicket')} value={formatCurrency(summary.averageTicket)} />
      <MetricTile icon={Boxes} tone="rose" label={t('unitsSold')} value={formatQuantity(summary.itemsSold || 0)}
        detail={summary.transactions > 0 ? t('itemsPerTicket', { count: formatQuantity(summary.itemsPerTransaction || 0) }) : null} />
    </section>

    <section className="analytics-main-grid">
      <article className="card chart-card">
        <header className="card-header"><h2>{chartRange === 'today' ? t('revenueByHour') : t('revenueByDay')}</h2><strong>{formatCurrency(summary.revenue)}</strong></header>
        <BarSeries key={chartRange} data={chart} formatValue={formatCurrency} />
      </article>
      <article className="card payment-mix-card"><header className="card-header"><h2>{t('paymentMix')}</h2></header><div className="payment-metrics">
        {[['cash', t('cashSales'), Banknote, 'sage'], ['card', t('pointSales'), CreditCard, 'cocoa'], ...(data.paymentMethods.web ? [['web', 'Web', Globe, 'cocoa']] : [])].map(([method, label, Icon, tone]) => { const item = data.paymentMethods[method] || {}; const share = paymentShare(item.revenue || 0); return <div className="payment-metric" key={method}><div className={`payment-metric-icon ${tone}`}><Icon size={19} /></div><div><span>{label}</span><strong>{formatCurrency(item.revenue)}</strong><small>{item.transactions || 0} {t('transactions').toLowerCase()}</small></div><b>{share}%</b><div className="payment-track"><i style={{ width: `${share}%` }} /></div></div> })}
      </div></article>
    </section>

    <article className="card top-products-card"><header className="card-header"><h2>{t('topProducts')}</h2></header>{data.topProducts.length ? <div className="top-products-list">{data.topProducts.map((product, index) => <div key={product.itemId || product.name}><b>{String(index + 1).padStart(2, '0')}</b><div><span><strong>{product.name}</strong><small>{t('soldQuantity', { count: formatQuantity(product.quantity) })}</small></span><span><strong>{formatCurrency(product.revenue)}</strong><small>{product.revenueShare}%</small></span><div><i style={{ width: `${product.revenueShare}%` }} /></div></div></div>)}</div> : <div className="analytics-empty"><BarChart3 size={28} /><p>{t('noSalesForPeriod')}</p></div>}</article>

    <section className="operations-strip" aria-label={t('operationalPulse')}>
      <div className="operations-title"><strong>{summary.pendingPoint || summary.failedPayments ? t('needsReview') : t('allReconciled')}</strong></div>
      <div><span>{t('pendingPointPayments')}</span><strong>{summary.pendingPoint || 0}</strong></div>
      <div><span>{t('failedPayments')}</span><strong>{summary.failedPayments || 0}</strong></div>
      <div><span>{t('refundedAmount')}</span><strong>{formatCurrency(summary.refundedTotal)}</strong></div>
    </section>
  </div>
}
