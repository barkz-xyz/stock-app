import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, BadgeCheck, Banknote, Check, ChevronRight, ChevronUp, ChevronDown, CreditCard, FileCheck2, History, LayoutDashboard, Minus, PackageOpen, Plus, ReceiptText, RotateCw, Search, ShoppingBasket, Monitor, Star, Trash2, Undo2, Wifi, X } from 'lucide-react'
import { api } from './api.js'
import { beginCheckout, clearCheckout, pendingCheckout } from './checkoutAttempts.js'
import { useI18n } from './i18n.js'
import { categories, CategoryIcon, categoryClass, formatQuantity, Modal } from './ui.jsx'

import { getProductPhoto } from './productPhotos.js'
import CajaHeader from './CajaHeader.jsx'
import { loadCartDraft, saveCartDraft, loadFavorites, saveFavorites, productLabel, searchText, cashTender } from './posWorkspace.js'

function ProductArtwork({ item }) {
  const photo = getProductPhoto(item.name)
  const [failedSource, setFailedSource] = useState(null)
  if (!photo || failedSource === photo.src) return <CategoryIcon category={item.category} size={82} className="sale-product-art" />
  return <img className="sale-product-photo" src={photo.src} srcSet={photo.srcSet}
    sizes="(max-width: 480px) calc((100vw - 48px) / 2), 180px"
    width={photo.width} height={photo.height} alt="" aria-hidden="true"
    loading="lazy" decoding="async" onError={() => setFailedSource(photo.src)} />
}

function saleState(status, t) {
  const states = {
    paid: { label: t('salePaid'), tone: 'success' },
    pending: { label: t('salePending'), tone: 'warning' },
    failed: { label: t('saleFailed'), tone: 'danger' },
    cancelled: { label: t('saleCancelled'), tone: 'neutral' },
    expired: { label: t('saleExpired'), tone: 'neutral' },
    refunded: { label: t('saleRefunded'), tone: 'neutral' },
  }
  return states[status] || states.pending
}

function CheckoutModal({ checkout, posConfig, onCash, onCard, onRetry, onCancelSale, onClose, busy }) {
  const { t, formatCurrency } = useI18n()
  const [cashMode, setCashMode] = useState(false), [received, setReceived] = useState('')
  const tender = cashTender(checkout.total, received)
  const sale = checkout.sale
  const pending = checkout.stage === 'processing' || checkout.stage === 'connecting'
  const finalState = sale ? saleState(sale.status, t) : null
  const pointHasOrder = checkout.stage === 'processing' && sale?.mpStatus
  const pointHasTerminal = pointHasOrder && ['at_terminal', 'action_required'].includes(sale.mpStatus)
  const pointCanCancelFromPos = sale?.mpOrderId && (!sale.mpStatus || sale.mpStatus === 'created')
  const progressTitle = checkout.stage === 'connecting'
    ? t('sendingToPoint')
    : pointHasTerminal ? t('pointReady') : t('waitingForPoint')
  const progressDescription = checkout.stage === 'connecting'
    ? t('connectingPointDescription')
    : pointHasTerminal ? t('customerUseTerminal') : t('waitingForPointDescription')
  return <Modal title={checkout.stage === 'method' ? t(cashMode ? 'cash' : 'choosePaymentMethod') : sale ? `#${sale.shortId}` : t('cardPayment')} eyebrow={t('checkout')} onClose={onClose} closeable={!pending}>
    {checkout.stage === 'method' && !cashMode && <div className="checkout-body">
      <div className="checkout-total"><span>{t('totalToPay')}</span><strong>{formatCurrency(checkout.total)}</strong></div>
      <div className="payment-options">
        <button onClick={() => setCashMode(true)} disabled={busy}><div className="payment-icon cash"><Banknote size={25} /></div><span><strong>{t('cash')}</strong></span><ChevronRight size={20} /></button>
        <button onClick={onCard} disabled={busy || !posConfig.configured}><div className="payment-icon card"><CreditCard size={25} /></div><span><strong>{t('card')}</strong><small>{posConfig.configured ? t('pointSmart2Description') : t('pointNotConfigured')}</small></span><ChevronRight size={20} /></button>
      </div>
      {!posConfig.configured && <div className="setup-hint"><AlertTriangle size={17} /><span>{t('pointSetupHint')}</span></div>}
    </div>}
    {checkout.stage === 'method' && cashMode && <form className="checkout-body cash-tender" onSubmit={e => { e.preventDefault(); if (tender.valid && !busy) onCash(Number(received)) }}>
      <div className="checkout-total"><span>{t('totalToPay')}</span><strong>{formatCurrency(checkout.total)}</strong></div>
      <label className="field"><span>{t('receivedCash')}</span><div className="money-input"><span>$</span><input autoFocus required type="number" inputMode="numeric" min={checkout.total} max="999999999999" step="1" value={received} disabled={busy} onChange={e => setReceived(e.target.value)} aria-invalid={received !== '' && !tender.valid} /></div></label>
      <div className="cash-shortcuts"><button type="button" disabled={busy} onClick={() => setReceived(String(checkout.total))}>{t('exactAmount')}</button>{[1000,2000,5000,10000,20000].filter(n => n > checkout.total).slice(0,4).map(n => <button key={n} type="button" disabled={busy} onClick={() => setReceived(String(n))}>{formatCurrency(n)}</button>)}</div>
      <div className="tender-change" aria-live="polite"><span>{t('cashChange')}</span><strong>{tender.valid ? formatCurrency(tender.change) : '—'}</strong></div>
      {received !== '' && !tender.valid && <p className="inline-error">{t('cashInsufficient')}</p>}
      <div className="tender-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setCashMode(false)}>{t('back')}</button><button className="button primary" disabled={busy || !tender.valid}>{busy ? t('saving') : t('confirmCash')}<Check size={18} /></button></div>
    </form>}
    {(checkout.stage === 'connecting' || checkout.stage === 'processing') && <div className="payment-progress">
      <div className="terminal-animation"><CreditCard size={31} /><i /><i /><i /></div>
      <h3>{progressTitle}</h3>
      <p>{progressDescription}</p>
      {sale && <div className="payment-reference"><span>{t('sale')}</span><strong>#{sale.shortId}</strong><span>{formatCurrency(sale.total)}</span></div>}
      <div className="progress-line"><i /></div>
      {sale?.mpStatus === 'action_required' && <div className="setup-hint"><AlertTriangle size={17} />{t('checkTerminal')}</div>}
      {pointHasTerminal && <div className="terminal-cancel-guidance" role="note"><Monitor size={17} /><div><strong>{t('cancelAtTerminalTitle')}</strong><span>{t('cancelAtTerminalDescription')}</span></div></div>}
      {pointCanCancelFromPos && <button className="text-button danger-text" onClick={onCancelSale} disabled={busy}>{t('cancelPayment')}</button>}
    </div>}
    {checkout.stage === 'connection-error' && <div className="payment-result error">
      <div><Wifi size={28} /></div><h3>{t('connectionUncertain')}</h3><p>{checkout.error}</p>
      <div className="result-actions"><button className="button secondary" onClick={onClose}>{t('close')}</button><button className="button primary" onClick={onRetry} disabled={busy}><RotateCw size={18} />{t('retryConnection')}</button></div>
    </div>}
    {checkout.stage === 'error' && <div className="payment-result error">
      <div><X size={29} /></div><h3>{finalState?.label || t('paymentCouldNotStart')}</h3><p>{checkout.error || t('stockRestored')}</p>
      <button className="button primary" onClick={onClose}>{t('returnToCart')}</button>
    </div>}
    {checkout.stage === 'success' && <div className="payment-result success">
      <div><BadgeCheck size={34} /></div><h3>{t('paymentApproved')}</h3>
      <div className="success-total"><span>#{sale?.shortId}</span><strong>{formatCurrency(sale?.total || 0)}</strong></div>
      {sale?.cashReceived != null && <div className="cash-result"><span>{t('receivedCash')}<b>{formatCurrency(sale.cashReceived)}</b></span><span>{t('cashChange')}<b>{formatCurrency(sale.cashChange)}</b></span></div>}
      {sale?.paymentMethod === 'card' && <div className="point-receipt-reminder"><ReceiptText size={17} /><span>{t('deliverPointReceipt')}</span></div>}
      <button className="button primary" onClick={onClose}>{t('newSale')}</button>
    </div>}
  </Modal>
}

function SaleDetailsModal({ sale, onClose, onRefund, onRetryRefund, onPrintRefundCopy, onCreditNote, onReconcilePoint, onResolveInventory, busy, canManage }) {
  const { t, formatCurrency, formatTime, unitLabel } = useI18n()
  const [view, setView] = useState('details')
  const [quantities, setQuantities] = useState({})
  const [refundAmountInput, setRefundAmountInput] = useState('')
  const [refundForm, setRefundForm] = useState({
    reason: '', restock: false, creditNoteRequired: false, originalDocumentType: '39', originalFolio: '',
  })
  const [creditNoteRefund, setCreditNoteRefund] = useState(null)
  const [creditNoteForm, setCreditNoteForm] = useState({ originalDocumentType: '39', originalFolio: '', folio: '', siiTrackId: '' })
  const processedRefunds = sale.refunds?.filter((refund) => refund.status === 'processed') || []
  const refundedByLine = new Map()
  for (const refund of processedRefunds) {
    for (const line of refund.items) refundedByLine.set(line.lineId, (refundedByLine.get(line.lineId) || 0) + line.quantity)
  }
  const refundableLines = sale.items.map((line) => ({
    ...line,
    refundableQuantity: Math.max(0, line.quantity - Number(refundedByLine.get(line.lineId) || 0)),
  })).filter((line) => line.refundableQuantity > 0)
  const refundAmount = Math.round(Number(refundAmountInput || 0))
  const refundAmountValid = refundAmountInput !== '' && Number.isInteger(Number(refundAmountInput)) && refundAmount >= 1 && refundAmount <= sale.refundableTotal
  const selectedItems = refundableLines
    .map((line) => ({ lineId: line.lineId, quantity: Number(quantities[line.lineId] || 0) }))
    .filter((line) => line.quantity > 0)
  const state = sale.status === 'paid' && sale.refundedTotal > 0
    ? { label: t('salePartiallyRefunded'), tone: 'warning' }
    : saleState(sale.status, t)
  const pointVoucher = sale.paymentMethod === 'card' && Boolean(sale.mpTaxSetting)

  const openRefund = () => {
    setQuantities({})
    setRefundAmountInput(String(Math.round(sale.refundableTotal)))
    setRefundForm({ reason: '', restock: false, creditNoteRequired: false, originalDocumentType: '39', originalFolio: '' })
    setView('refund')
  }
  const submitRefund = async (event) => {
    event.preventDefault()
    if (!refundAmountValid) return
    try {
      const next = await onRefund({ ...refundForm, amount: refundAmount, restock: refundForm.restock && selectedItems.length > 0, items: selectedItems })
      if (next) setView('details')
    } catch {}
  }
  const openCreditNote = (refund) => {
    setCreditNoteRefund(refund)
    setCreditNoteForm({
      originalDocumentType: refund.creditNote?.originalDocumentType || refund.originalDocumentType || '39',
      originalFolio: refund.creditNote?.originalFolio || refund.originalFolio || '',
      folio: refund.creditNote?.folio || '',
      siiTrackId: refund.creditNote?.siiTrackId || '',
    })
    setView('credit-note')
  }
  const submitCreditNote = async (event) => {
    event.preventDefault()
    try {
      const next = await onCreditNote(creditNoteRefund.id, creditNoteForm)
      if (next) setView('details')
    } catch {}
  }

  return <Modal title={`#${sale.shortId}`} eyebrow={view === 'credit-note' ? t('recordCreditNote') : t('saleDetails')} onClose={onClose} closeable={!busy}>
    {view === 'details' && <div className="sale-details-body">
      <div className="sale-detail-summary">
        <div><span>{t('total')}</span><strong>{formatCurrency(sale.total)}</strong></div>
        <div><span>{t('alreadyRefunded')}</span><strong>{formatCurrency(sale.refundedTotal || 0)}</strong></div>
        <div><span>{t('refundableAmount')}</span><strong>{formatCurrency(sale.refundableTotal || 0)}</strong></div>
      </div>
      <div className="sale-detail-meta"><span className={`sale-status ${state.tone}`}>{state.label}</span><span>{sale.paymentMethod === 'card' ? t('card') : t('cash')} · {formatTime(sale.createdAt)}</span></div>
      {sale.cashReceived != null && <div className="cash-result"><span>{t('receivedCash')}<b>{formatCurrency(sale.cashReceived)}</b></span><span>{t('cashChange')}<b>{formatCurrency(sale.cashChange)}</b></span></div>}
      {sale.paymentMethod === 'card' && <section className="point-payment-details">
        <header><div><CreditCard size={17} /><strong>{t('pointPaymentDetails')}</strong></div>{canManage&&<button type="button" className="button compact" onClick={() => onReconcilePoint().catch(() => {})} disabled={busy}><RotateCw size={15} />{t('syncPoint')}</button>}</header>
        <div className="point-payment-grid">
          <div><span>{t('operationNumber')}</span><strong>{sale.mpOperationId || t('pendingData')}</strong></div>
          <div><span>{t('paymentCard')}</span><strong>{sale.mpCardBrand ? `${sale.mpCardBrand.toUpperCase()}${sale.mpCardLastFour ? ` ···· ${sale.mpCardLastFour}` : ''}` : t('pendingData')}</strong></div>
          <div><span>{t('mercadoPagoFee')}</span><strong>{formatCurrency(sale.mpFeeAmount || 0)}</strong></div>
          <div><span>{t('netReceived')}</span><strong>{sale.mpNetReceivedAmount == null ? t('pendingData') : formatCurrency(sale.mpNetReceivedAmount)}</strong></div>
        </div>
        {pointVoucher && <div className="point-document-state"><ReceiptText size={16} /><div><strong>{t('pointVoucher')}</strong><span>{t('pointVoucherDescription')}</span></div></div>}
      </section>}
      <div className="sale-detail-lines">
        {sale.items.map((line) => <div key={line.lineId}><div><strong>{line.name}</strong><span>{formatQuantity(line.quantity)} {unitLabel(line.unit)} · {formatCurrency(line.unitPrice)}</span></div><b>{formatCurrency(line.lineTotal)}</b></div>)}
      </div>
      {canManage && sale.refunds?.length > 0 && <section className="refund-history"><div className="section-label"><span>{t('refundHistory')}</span></div>{sale.refunds.map((refund) => <article key={refund.id}>
        <div className={`refund-icon ${refund.status}`}><Undo2 size={17} /></div>
        <div><strong>{formatCurrency(refund.amount)}</strong><span>{refund.status === 'processed' ? t('refundCompleted') : refund.status === 'pending' ? t('refundPending') : t('refundFailed')}</span>{refund.reason && <small>{refund.reason}</small>}</div>
        <div className="refund-actions">
          {refund.status === 'pending' && sale.paymentMethod === 'card' && <button className="button compact" onClick={() => onRetryRefund(refund.id).catch(() => {})} disabled={busy}><RotateCw size={15} />{t('retryRefund')}</button>}
          {refund.status === 'processed' && sale.paymentMethod === 'card' && <button className="button compact" onClick={() => onPrintRefundCopy(refund.id).catch(() => {})} disabled={busy}><ReceiptText size={15} />{t('printRefundCopy')}</button>}
          {refund.inventoryReviewStatus === 'pending' && <div className="inventory-review-actions"><span><AlertTriangle size={14} />{t('inventoryReviewPending')}</span>{refund.items.length > 0 && <button className="button compact" onClick={() => onResolveInventory(refund.id, true).catch(() => {})} disabled={busy}><PackageOpen size={15} />{t('restockProducts')}</button>}<button className="button compact" onClick={() => onResolveInventory(refund.id, false).catch(() => {})} disabled={busy}><Check size={15} />{t('doNotRestock')}</button></div>}
          {refund.creditNote?.status === 'pending' && <button className="button compact" onClick={() => openCreditNote(refund)}><FileCheck2 size={15} />{t('recordCreditNote')}</button>}
          {refund.creditNote?.status === 'issued' && <span className="credit-note-state issued"><FileCheck2 size={15} />{t('creditNoteIssued')} · N° {refund.creditNote.folio}</span>}
        </div>
      </article>)}</section>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('close')}</button>{canManage&&<button type="button" className="button primary" onClick={openRefund} disabled={busy || sale.status !== 'paid' || sale.refundableTotal <= 0}><Undo2 size={18} />{sale.refundableTotal > 0 ? t('refundSale') : t('noRefundableProducts')}</button>}</div>
    </div>}

    {view === 'refund' && <form className="refund-form" onSubmit={submitRefund}>
      <p className="modal-description">{t('refundDescription')}</p>
      <section className="refund-amount-card">
        <div className="field full refund-amount-field"><label htmlFor="refund-amount">{t('refundAmountLabel')}</label><div className="money-input"><span aria-hidden="true">$</span><input id="refund-amount" type="number" inputMode="numeric" min="1" max={sale.refundableTotal} step="1" required value={refundAmountInput} onChange={(event) => setRefundAmountInput(event.target.value)} aria-invalid={refundAmountInput !== '' && !refundAmountValid} /></div></div>
        <div className="refund-amount-meta"><span>{t('refundAmountAvailable')}: <strong>{formatCurrency(sale.refundableTotal)}</strong></span><button type="button" className="text-button" onClick={() => setRefundAmountInput(String(Math.round(sale.refundableTotal)))}>{t('useMaximum')}</button></div>
        <small>{t('customRefundExplanation')}</small>
      </section>
      <div className="section-label"><span>{t('selectProductsToRefund')}</span></div>
      <p className="refund-products-description">{t('refundProductsDescription')}</p>
      <div className="refund-lines">{refundableLines.map((line) => <label key={line.lineId}>
        <span><strong>{line.name}</strong><small>{formatQuantity(line.refundableQuantity)} {unitLabel(line.unit)} · {formatCurrency(line.unitPrice)}</small></span>
        <input type="number" min="0" max={line.refundableQuantity} step="0.01" inputMode="decimal" aria-label={`${t('refundQuantity')}: ${line.name}`} value={quantities[line.lineId] ?? ''} onChange={(event) => setQuantities((current) => ({ ...current, [line.lineId]: event.target.value }))} placeholder="0" />
      </label>)}</div>
      <label className={`switch-field refund-switch ${selectedItems.length ? '' : 'is-disabled'}`}><input type="checkbox" checked={selectedItems.length > 0 && refundForm.restock} disabled={!selectedItems.length} onChange={(event) => setRefundForm((current) => ({ ...current, restock: event.target.checked }))} /><i aria-hidden="true" /><span><strong>{t('returnToInventory')}</strong><small>{selectedItems.length ? t('returnToInventoryDescription') : t('selectProductsToRestock')}</small></span></label>
      <div className="field full"><label htmlFor="refund-reason">{t('refundReason')} <span>{t('optional')}</span></label><input id="refund-reason" value={refundForm.reason} onChange={(event) => setRefundForm((current) => ({ ...current, reason: event.target.value }))} placeholder={t('refundReasonPlaceholder')} /></div>
      {pointVoucher ? <div className="point-document-state refund-document-state"><ReceiptText size={16} /><div><strong>{t('pointVoucherRefund')}</strong><span>{t('pointVoucherRefundDescription')}</span></div></div> : <label className="switch-field refund-switch"><input type="checkbox" checked={refundForm.creditNoteRequired} onChange={(event) => setRefundForm((current) => ({ ...current, creditNoteRequired: event.target.checked }))} /><i aria-hidden="true" /><span><strong>{t('electronicReceiptIssued')}</strong><small>{t('electronicReceiptDescription')}</small></span></label>}
      {!pointVoucher && refundForm.creditNoteRequired && <div className="form-grid credit-note-reference"><div className="field"><label htmlFor="original-document-type">{t('originalDocumentType')}</label><select id="original-document-type" value={refundForm.originalDocumentType} onChange={(event) => setRefundForm((current) => ({ ...current, originalDocumentType: event.target.value }))}><option value="39">{t('documentType39')}</option><option value="41">{t('documentType41')}</option><option value="33">{t('documentType33')}</option><option value="34">{t('documentType34')}</option></select></div><div className="field"><label htmlFor="original-folio">{t('originalFolio')} <span>{t('optional')}</span></label><input id="original-folio" inputMode="numeric" value={refundForm.originalFolio} onChange={(event) => setRefundForm((current) => ({ ...current, originalFolio: event.target.value }))} /></div></div>}
      <div className="refund-payment-hint"><AlertTriangle size={16} /><span>{sale.paymentMethod === 'card' ? t('pointRefundHint') : t('cashRefundHint')}</span></div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setView('details')} disabled={busy}>{t('cancel')}</button><button className="button primary" disabled={busy || !refundAmountValid}>{busy ? t('processingRefund') : t('confirmRefund')}<Undo2 size={18} /></button></div>
    </form>}

    {view === 'credit-note' && <form className="form-stack credit-note-form" onSubmit={submitCreditNote}>
      <p className="modal-description">{t('creditNoteDescription')}</p>
      <div className="form-grid"><div className="field"><label htmlFor="credit-original-type">{t('originalDocumentType')}</label><select id="credit-original-type" value={creditNoteForm.originalDocumentType} onChange={(event) => setCreditNoteForm((current) => ({ ...current, originalDocumentType: event.target.value }))}><option value="39">{t('documentType39')}</option><option value="41">{t('documentType41')}</option><option value="33">{t('documentType33')}</option><option value="34">{t('documentType34')}</option></select></div><div className="field"><label htmlFor="credit-original-folio">{t('originalFolio')}</label><input id="credit-original-folio" required inputMode="numeric" pattern="[0-9]+" value={creditNoteForm.originalFolio} onChange={(event) => setCreditNoteForm((current) => ({ ...current, originalFolio: event.target.value }))} /></div><div className="field"><label htmlFor="credit-note-folio">{t('creditNoteFolio')}</label><input id="credit-note-folio" required inputMode="numeric" pattern="[0-9]+" value={creditNoteForm.folio} onChange={(event) => setCreditNoteForm((current) => ({ ...current, folio: event.target.value }))} /></div><div className="field"><label htmlFor="credit-track-id">{t('siiTrackId')} <span>{t('optional')}</span></label><input id="credit-track-id" value={creditNoteForm.siiTrackId} onChange={(event) => setCreditNoteForm((current) => ({ ...current, siiTrackId: event.target.value }))} /></div></div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setView('details')} disabled={busy}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('saving') : t('saveCreditNote')}<FileCheck2 size={18} /></button></div>
    </form>}
  </Modal>
}

function SalesHistory({ refreshToken, onResume, onSelect, showOperator }) {
  const { t, formatCurrency, language } = useI18n()
  const dateFormat = new Intl.DateTimeFormat(language === 'es' ? 'es-CL' : 'en-US', { timeZone: 'America/Santiago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const [filters, setFilters] = useState({ search: '', from: '', to: '', method: '', status: '' }), [offset, setOffset] = useState(0)
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const size = 40
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      api.salesHistory({ ...filters, offset, limit: size }, { signal: controller.signal })
        .then(next => { if (!controller.signal.aborted) setData(next) })
        .catch(e => { if (!controller.signal.aborted) setError(e.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, filters.search ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [filters, offset, refreshToken, retry])
  const update = key => e => { setOffset(0); setFilters(f => ({ ...f, [key]: e.target.value })) }
  const reset = () => { setOffset(0); setFilters({ search: '', from: '', to: '', method: '', status: '' }) }
  return <section className="card register-history" id="caja-history-panel" role="tabpanel" aria-labelledby="caja-history-tab" aria-busy={loading}>
    <div className="history-filters">
      <label className="search-box"><Search size={17} /><input value={filters.search} onChange={update('search')} placeholder={t('searchSale')} aria-label={t('searchSale')} /></label>
      <div className="history-filter-row"><label><span>{t('fromDate')}</span><input type="date" value={filters.from} onChange={update('from')} /></label><label><span>{t('toDate')}</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={update('to')} /></label><select aria-label={t('payment')} value={filters.method} onChange={update('method')}><option value="">{t('allMethods')}</option><option value="cash">{t('cash')}</option><option value="card">{t('card')}</option></select><select aria-label={t('status')} value={filters.status} onChange={update('status')}><option value="">{t('allStatuses')}</option>{['paid','pending','refunded','failed','cancelled','expired'].map(s => <option key={s} value={s}>{saleState(s, t).label}</option>)}</select><button type="button" className="icon-button" onClick={reset} aria-label={t('clearFilters')} title={t('clearFilters')}><X size={17} /></button></div>
    </div>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={16} />{error}<button className="text-button" onClick={() => setRetry(n => n + 1)}>{t('retryConnection')}</button></div>}
    <div className={`history-ledger ${loading ? 'is-updating' : ''}`}>
      <div className="ledger-head"><span>{t('saleReference')}</span><span>{t('payment')}</span><span>{t('status')}</span><span>{t('total')}</span></div>
      {!data && loading ? <div className="section-skeleton" aria-label={t('loadingSection')}>{[0,1,2,3,4].map(n => <i key={n} />)}</div> : data?.sales.map(sale => {
        const state = sale.status === 'paid' && sale.refundedTotal > 0 ? { label: t('salePartiallyRefunded'), tone: 'warning' } : saleState(sale.status, t)
        const interactive = ['paid','pending','refunded'].includes(sale.status)
        return <button className="ledger-row" key={sale.id} disabled={!interactive || loading} onClick={() => sale.status === 'pending' ? onResume(sale) : onSelect(sale)} aria-label={`${t('openSaleDetails')} #${sale.shortId}`}>
          <span className="ledger-reference"><strong>#{sale.shortId}</strong><small>{dateFormat.format(new Date(sale.createdAt))}{showOperator&&` · ${sale.cashierName||(language==='es'?'Sin asignar':'Unassigned')}`}</small></span><span className="ledger-method">{sale.paymentMethod === 'card' ? <CreditCard size={16} /> : <Banknote size={16} />}{t(sale.paymentMethod === 'card' ? 'card' : 'cash')}</span><span className={`sale-status ${state.tone}`}>{state.label}</span><strong className="ledger-amount">{formatCurrency(sale.total)}<ChevronRight size={15} /></strong>
        </button>
      })}
      {data && !data.sales.length && <div className="sales-empty"><Search size={23} /><span>{t('noMatchingSales')}</span></div>}
    </div>
    {data && <footer className="history-pagination"><span role="status">{t('resultRange', { from: data.total ? offset + 1 : 0, to: Math.min(offset + size, data.total), total: data.total })}</span><button className="button compact" disabled={loading || offset === 0} onClick={() => setOffset(n => Math.max(0,n-size))}>{t('previousPage')}</button><button className="button compact" disabled={loading || !data.hasMore} onClick={() => setOffset(n => n + size)}>{t('nextPage')}</button></footer>}
  </section>
}

export default function SalesCounter({ items, sales, posConfig, onRefresh, setToast, onNavigate, registerView = 'cart', onRegisterViewChange, serverAvailable = true, user, registerSession, onOpenRegister }) {
  const { t, categoryLabel, unitLabel, formatCurrency, language } = useI18n()
  const tx=(es,en)=>language==='es'?es:en
  const [openingCash,setOpeningCash]=useState(''),[opening,setOpening]=useState(false),[openError,setOpenError]=useState('')
  const setRegisterView = onRegisterViewChange
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  const [inStockOnly, setInStockOnly] = useState(true)
  const [attempt, setAttempt] = useState(pendingCheckout)
  const [cart, setCart] = useState(() => pendingCheckout()?.items || loadCartDraft())
  const [favorites, setFavorites] = useState(loadFavorites), [cartExpanded, setCartExpanded] = useState(false)
  const [checkout, setCheckout] = useState(null)
  const [selectedSale, setSelectedSale] = useState(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const recoveryKey = useRef(attempt?.key)
  const sellable = useMemo(() => items.filter((item) => item.sellable && item.price > 0), [items])
  const catalogItems = useMemo(() => inStockOnly ? sellable.filter((item) => item.quantity > 0) : sellable, [inStockOnly, sellable])
  const presentCategories = useMemo(() => categories.filter((category) => catalogItems.some((item) => item.category === category)), [catalogItems])
  const products = catalogItems.filter((item) => (filter === 'All' || filter === 'Favorites' && favorites.includes(item.id) || item.category === filter) && searchText(`${item.name} ${item.sku}`).includes(searchText(search))).sort((a,b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) || a.name.localeCompare(b.name, 'es'))
  const cartLines = cart.map((line) => ({ ...line, item: items.find((item) => item.id === line.itemId) || { id: line.itemId, name: t('unavailableProduct'), price: 0, quantity: 0, unit: 'pieces', missing: true } }))
  const cartInvalid = cartLines.some(l => l.item.missing || !l.item.sellable || l.item.price <= 0 || l.quantity > l.item.quantity)
  useEffect(() => { saveCartDraft(cart) }, [cart])
  useEffect(() => { saveFavorites(favorites) }, [favorites])
  const total = cartLines.reduce((sum, line) => sum + Math.round(line.item.price * line.quantity), 0)
  const count = cartLines.reduce((sum, line) => sum + line.quantity, 0)
  const resumeSale = (sale) => {
    setRegisterView('cart')
    setCheckout({ stage: sale.mpOrderId ? 'processing' : 'connection-error', sale, total: sale.total, error: sale.mpOrderId ? '' : t('reservedSaleRecovery') })
  }
  const handleRegisterTabKey = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'cart' : event.key === 'End' ? 'history' : registerView === 'cart' ? 'history' : 'cart'
    setRegisterView(next)
    event.currentTarget.querySelector(`#caja-${next}-tab`)?.focus()
  }

  const changeQuantity = (item, delta) => {
    if (attempt) return
    setCart((current) => {
    const existing = current.find((line) => line.itemId === item.id)
    const next = Math.max(0, Math.min(item.quantity, (existing?.quantity || 0) + delta))
    if (!existing && next > 0) return [...current, { itemId: item.id, quantity: next }]
    if (next === 0) return current.filter((line) => line.itemId !== item.id)
    return current.map((line) => line.itemId === item.id ? { ...line, quantity: next } : line)
    })
  }
  const payload = () => cartLines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }))
  const finish = async (sale) => {
    const pending = pendingCheckout()
    if (pending?.key === sale.checkoutKey) { clearCheckout(pending.key); setAttempt(null) }
    setCheckout((current) => ({ ...current, stage: sale.status === 'paid' ? 'success' : 'error', sale, error: sale.status === 'paid' ? '' : t('stockRestored') }))
    if (sale.status === 'paid') setCart([])
    await onRefresh().catch(error => setToast({ type: 'error', message: error.message }))
  }
  const acceptSale = async (sale) => {
    if (sale.status !== 'pending') return finish(sale)
    setCheckout({ stage: sale.mpOrderId ? 'processing' : 'connection-error', sale, total: sale.total,
      error: sale.mpOrderId ? '' : t('reservedSaleRecovery') })
    await onRefresh().catch(() => {})
  }
  const pay = async (paymentMethod, cashReceived = null) => {
    if (submitting.current) return
    submitting.current = true
    const pending = beginCheckout(payload(), paymentMethod, total, cashReceived)
    setAttempt(pending)
    setBusy(true)
    if (pending.paymentMethod === 'card') setCheckout(current => ({ ...current, stage: 'connecting' }))
    try {
      const sale = await (pending.paymentMethod === 'cash' ? api.cashSale : api.cardSale)(pending.items, pending.key, pending.cashReceived)
      await acceptSale(sale)
    } catch (error) {
      const uncertain = error.uncertain || !error.status || error.status >= 500 || error.code === 'CHECKOUT_CONFLICT'
      if (!uncertain) { clearCheckout(pending.key); setAttempt(null) }
      const sale = error.saleId && uncertain ? { id: error.saleId, shortId: error.saleId.replaceAll('-', '').slice(0, 8).toUpperCase(), total: pending.total, status: 'pending' } : null
      setCheckout(current => ({ ...current, stage: uncertain ? 'connection-error' : 'error', sale,
        error: uncertain ? t('checkoutUncertain') : error.message }))
    } finally { setBusy(false); submitting.current = false }
  }
  const payCash = received => pay('cash', received)
  const payCard = () => pay('card')
  const recoverCheckout = async () => {
    const pending = pendingCheckout()
    if (!pending) return
    setBusy(true)
    try { await acceptSale(await api.checkout(pending.key)) }
    catch (error) {
      setCheckout({ stage: 'connection-error', total: pending.total, error: t('checkoutUncertain') })
    } finally { setBusy(false) }
  }
  useEffect(() => {
    if (recoveryKey.current) { recoveryKey.current = null; recoverCheckout() }
  }, [])
  const retry = async () => {
    if (!checkout.sale?.id) return pay(pendingCheckout()?.paymentMethod || 'cash')
    setBusy(true)
    try { await acceptSale(await api.retryCardSale(checkout.sale.id)) }
    catch (error) { setCheckout((current) => ({ ...current, stage: error.uncertain ? 'connection-error' : 'error', error: error.message })) }
    finally { setBusy(false) }
  }
  const cancelSale = async () => {
    if (!checkout.sale?.id) return
    setBusy(true)
    try { await finish(await api.cancelSale(checkout.sale.id)) }
    catch (error) {
      const knownCancellation = error.code === 'POINT_CANCEL_ON_TERMINAL' || error.code === 'POINT_CANCEL_UNAVAILABLE'
      setToast({
        type: knownCancellation ? 'warning' : 'error',
        message: error.code === 'POINT_CANCEL_ON_TERMINAL'
          ? t('cancelAtTerminalToast')
          : error.code === 'POINT_CANCEL_UNAVAILABLE' ? t('cancelUnavailableToast') : error.message,
      })
      if (knownCancellation) {
        const refreshed = await api.sale(checkout.sale.id, true).catch(() => null)
        if (refreshed) setCheckout((current) => ({ ...current, sale: refreshed }))
      }
    }
    finally { setBusy(false) }
  }
  const refundSale = async (input) => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const next = await api.refundSale(selectedSale.id, input)
      setSelectedSale(next)
      await onRefresh()
      setToast({ type: 'success', message: t('refundCompleted') })
      return next
    } catch (error) {
      if (error.refundId) {
        const refreshed = await api.sale(selectedSale.id).catch(() => null)
        if (refreshed) setSelectedSale(refreshed)
      }
      setToast({ type: 'error', message: error.message })
      throw error
    } finally { setBusy(false) }
  }
  const retryRefund = async (refundId) => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const next = await api.retryRefund(selectedSale.id, refundId)
      setSelectedSale(next); await onRefresh(); setToast({ type: 'success', message: t('refundCompleted') })
      return next
    } catch (error) { setToast({ type: 'error', message: error.message }); throw error }
    finally { setBusy(false) }
  }
  const printRefundCopy = async (refundId) => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const action = await api.printRefundCopy(selectedSale.id, refundId)
      setToast({ type: 'success', message: t('refundCopyQueued') })
      return action
    } catch (error) { setToast({ type: 'error', message: error.message }); throw error }
    finally { setBusy(false) }
  }
  const reconcilePointSale = async () => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const next = await api.reconcilePointSale(selectedSale.id)
      setSelectedSale(next); await onRefresh(); setToast({ type: 'success', message: t('pointSynced') })
      return next
    } catch (error) { setToast({ type: 'error', message: error.message }); throw error }
    finally { setBusy(false) }
  }
  const resolveRefundInventory = async (refundId, restock) => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const next = await api.resolveRefundInventory(selectedSale.id, refundId, restock)
      setSelectedSale(next); await onRefresh(); setToast({ type: 'success', message: t('inventoryReviewResolved') })
      return next
    } catch (error) { setToast({ type: 'error', message: error.message }); throw error }
    finally { setBusy(false) }
  }
  const recordCreditNote = async (refundId, input) => {
    if (!selectedSale) return null
    setBusy(true)
    try {
      const next = await api.recordCreditNote(selectedSale.id, refundId, input)
      setSelectedSale(next); await onRefresh(); setToast({ type: 'success', message: t('creditNoteRecorded') })
      return next
    } catch (error) { setToast({ type: 'error', message: error.message }); throw error }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (checkout?.stage !== 'processing' || !checkout.sale?.id || !posConfig.configured) return undefined
    let active = true
    let timeoutId
    let errorNotified = false
    const startedAt = Date.now()
    const schedule = () => {
      if (!active) return
      const elapsed = Date.now() - startedAt
      timeoutId = setTimeout(poll, elapsed < 12000 ? 1000 : 2500)
    }
    const poll = async () => {
      try {
        const sale = await api.sale(checkout.sale.id, true)
        if (!active) return
        setCheckout((current) => ({ ...current, sale }))
        if (sale.status !== 'pending') {
          active = false
          await finish(sale)
          return
        }
        schedule()
      } catch (error) {
        if (active && !errorNotified) {
          errorNotified = true
          setToast({ type: 'error', message: error.message })
        }
        schedule()
      }
    }
    poll()
    return () => { active = false; clearTimeout(timeoutId) }
  }, [checkout?.stage, checkout?.sale?.id, posConfig.configured])
  useEffect(() => {
    setSelectedSale((current) => current ? sales.find((sale) => sale.id === current.id) || current : null)
  }, [sales])
  useEffect(() => {
    if (!['All','Favorites'].includes(filter) && !presentCategories.includes(filter)) setFilter('All')
  }, [filter, presentCategories])

  return <div className="page pos-page enter">
    <CajaHeader onNavigate={onNavigate} />
    <section className="register-subnav">
      <div className="register-tabs" role="tablist" aria-label={t('registerSections')} onKeyDown={handleRegisterTabKey}>
        <button type="button" id="caja-cart-tab" role="tab" aria-selected={registerView === 'cart'} aria-controls="caja-cart-panel" tabIndex={registerView === 'cart' ? 0 : -1} onClick={() => setRegisterView('cart')}><ShoppingBasket size={16} />{t('cart')}</button>
        <button type="button" id="caja-history-tab" role="tab" aria-selected={registerView === 'history'} aria-controls="caja-history-panel" tabIndex={registerView === 'history' ? 0 : -1} onClick={() => setRegisterView('history')}><History size={16} />{t('registerHistory')}</button>
      </div>
    </section>
    {registerView==='cart'&&!registerSession&&!attempt&&<form className="card open-register" onSubmit={async e=>{e.preventDefault();setOpening(true);setOpenError('');try{await onOpenRegister(Number(openingCash));setOpeningCash('')}catch(e){setOpenError(e.message)}finally{setOpening(false)}}}><Banknote size={26}/><h2>{tx('Abrir sesión de caja','Open register session')}</h2><label className="field"><span>{tx('Fondo inicial · CLP','Opening cash · CLP')}</span><div className="money-input"><span>$</span><input type="number" inputMode="numeric" min="0" max="100000000000" step="1" required value={openingCash} onChange={e=>setOpeningCash(e.target.value)}/></div></label>{openError&&<div className="inline-error" role="alert">{openError}</div>}<button className="button primary" disabled={opening||!serverAvailable}>{opening?t('saving'):tx('Abrir caja','Open register')}<ArrowRight size={18}/></button></form>}
    {registerView === 'cart' ? <section className={`pos-layout ${!registerSession&&!attempt?'session-locked':''}`} id="caja-cart-panel" role="tabpanel" aria-labelledby="caja-cart-tab">
      <div className="catalog-panel">
        <div className="toolbar pos-toolbar">
          <div className="catalog-search-row">
            <label className="search-box"><Search size={18} /><input aria-label={t('searchProducts')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} />{search && <button type="button" onClick={() => setSearch('')} aria-label={t('clearSearch')}><X size={16} /></button>}</label>
            <label className="stock-only-toggle"><span>{t('inStockOnly')}</span><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} /><i aria-hidden="true" /></label>
          </div>
          <div className="catalog-category-row">
            <div className="filter-scroll" role="group" aria-label={t('byCategory')}>
              <button type="button" className={filter === 'All' ? 'active' : ''} aria-pressed={filter === 'All'} onClick={() => setFilter('All')}><LayoutDashboard size={15} aria-hidden="true" />{t('all')}<span>{catalogItems.length}</span></button>
              <button type="button" className={filter === 'Favorites' ? 'active' : ''} aria-pressed={filter === 'Favorites'} onClick={() => setFilter('Favorites')}><Star size={15} />{t('favorites')}<span>{catalogItems.filter(i => favorites.includes(i.id)).length}</span></button>
              {presentCategories.map((category) => <button type="button" key={category} className={filter === category ? 'active' : ''} aria-pressed={filter === category} onClick={() => setFilter(category)}><CategoryIcon category={category} size={16} />{categoryLabel(category)}<span>{catalogItems.filter((item) => item.category === category).length}</span></button>)}
            </div>
            <span className="catalog-result-count" role="status">{t('productsCount', { count: products.length })}</span>
          </div>
        </div>
        {sellable.length === 0 ? <div className="card pos-empty"><div className="empty-art"><ReceiptText size={31} /></div><h3>{t('configureProductsForSale')}</h3><p>{t('configureProductsDescription')}</p></div> : products.length ? <div className="product-grid">{products.map((item) => {
          const inCart = cart.find((line) => line.itemId === item.id)?.quantity || 0
          const label = productLabel(item.name), favorite = favorites.includes(item.id)
          return <div key={item.id} className="product-tile"><button className={`sale-product category-${categoryClass(item.category)} ${item.quantity <= 0 ? 'is-unavailable' : ''}`} aria-label={`${item.name} · ${formatCurrency(item.price)}`} title={item.name} disabled={Boolean(attempt) || item.quantity <= 0 || inCart >= item.quantity} onClick={() => changeQuantity(item, 1)}>
            <ProductArtwork item={item} />
            {inCart > 0 && <span className="cart-badge">{formatQuantity(inCart)}</span>}
            <span className="sale-product-label"><strong>{label.title}</strong>{label.variant && <small>{label.variant}</small>}</span>
            <div className="sale-product-footer"><span className="sale-product-price">{formatCurrency(item.price)}</span>{item.quantity > 0 && <span className="sale-product-stock"><b>{formatQuantity(item.quantity)}</b><small>{unitLabel(item.unit)}</small></span>}</div>
            {item.quantity <= 0 ? <i>{t('outOfStock')}</i> : <Plus className="sale-product-add" size={16} />}
          </button><button type="button" className={`favorite-button ${favorite ? 'active' : ''}`} aria-label={`${t(favorite ? 'removeFavorite' : 'addFavorite')}: ${item.name}`} aria-pressed={favorite} onClick={() => setFavorites(v => favorite ? v.filter(id => id !== item.id) : [...v, item.id])}><Star size={15} fill={favorite ? 'currentColor' : 'none'} /></button></div>
        })}</div> : <div className="pos-empty compact"><Search size={27} /><h3>{t('noProductsFound')}</h3></div>}
      </div>
      <aside className={`cart-panel ${cartLines.length ? 'has-items' : ''} ${cartExpanded ? 'is-expanded' : ''}`}>
        <header><div><ShoppingBasket size={20} /><h2>{t('cart')}</h2><span className="cart-count">{formatQuantity(count)}</span></div><div>{cartLines.length > 0 && <button disabled={Boolean(attempt)} onClick={() => setCart([])}><Trash2 size={14} />{t('clear')}</button>}<button className="cart-collapse" onClick={() => setCartExpanded(false)} aria-label={t('hideCart')}><ChevronDown size={19} /></button></div></header>
        <div className="cart-detail" id="cart-detail">
        {cartInvalid && !attempt && <div className="inline-error" role="alert"><AlertTriangle size={15} />{t('cartReview')}</div>}
        {cartLines.length ? <div className="cart-lines">{cartLines.map(({ item, quantity }) => <article className={quantity > item.quantity || item.missing ? 'invalid-line' : ''} key={item.id}><div className="cart-line-main"><div><strong>{item.name}</strong><span>{formatCurrency(item.price)} · {unitLabel(item.unit)}{quantity > item.quantity && ` · ${t('available')}: ${formatQuantity(item.quantity)}`}</span></div><b>{formatCurrency(item.price * quantity)}</b></div><div className="quantity-stepper"><button onClick={() => changeQuantity(item, -1)} disabled={Boolean(attempt)} aria-label={`${t('removeOne')}: ${item.name}`}><Minus size={16} /></button><span>{formatQuantity(quantity)}</span><button onClick={() => changeQuantity(item, 1)} disabled={Boolean(attempt) || quantity >= item.quantity} aria-label={`${t('addOne')}: ${item.name}`}><Plus size={16} /></button><button className="remove-line" onClick={() => changeQuantity(item, -quantity)} disabled={Boolean(attempt)} aria-label={`${t('removeFromCart')}: ${item.name}`}><Trash2 size={16} /></button></div></article>)}</div> : <div className="cart-empty"><div><ShoppingBasket size={28} /></div><h3>{t('emptyCart')}</h3></div>}
        </div>
        <footer><button type="button" className="cart-summary-toggle" onClick={() => setCartExpanded(v => !v)} aria-expanded={cartExpanded} aria-controls="cart-detail" aria-label={t(cartExpanded ? 'hideCart' : 'cartDetails')}><span>{t('productsCount', { count: formatQuantity(count) })}</span><strong>{formatCurrency(attempt?.total ?? total)}</strong>{cartExpanded ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button><div className="cart-summary"><div><span>{t('total')}</span><strong>{formatCurrency(attempt?.total ?? total)}</strong></div></div><button className="button primary pay-button" disabled={busy || !serverAvailable || (!attempt && (!registerSession || !cartLines.length || cartInvalid))} onClick={() => attempt ? recoverCheckout() : setCheckout({ stage: 'method', total })}>{t(!serverAvailable ? 'serverOffline' : attempt ? 'reviewPendingCheckout' : 'charge')}<ArrowRight size={19} /></button></footer>
      </aside>
    </section> : <SalesHistory showOperator={user?.role==='admin'} refreshToken={sales} onResume={resumeSale} onSelect={setSelectedSale} />}
    {checkout && <CheckoutModal checkout={checkout} posConfig={posConfig} onCash={payCash} onCard={payCard} onRetry={retry} onCancelSale={cancelSale} onClose={() => setCheckout(null)} busy={busy || !serverAvailable} />}
    {selectedSale && <SaleDetailsModal canManage={user?.role==='admin'} sale={selectedSale} onClose={() => setSelectedSale(null)} onRefund={refundSale} onRetryRefund={retryRefund} onPrintRefundCopy={printRefundCopy} onCreditNote={recordCreditNote} onReconcilePoint={reconcilePointSale} onResolveInventory={resolveRefundInventory} busy={busy} />}
  </div>
}
