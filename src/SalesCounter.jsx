import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, BadgeCheck, Banknote, Check, ChevronRight, CreditCard, FileCheck2, History, LayoutDashboard, Minus, PackageOpen, Plus, ReceiptText, RotateCw, Search, ShoppingBasket, Monitor, Trash2, Undo2, Wifi, X } from 'lucide-react'
import { api } from './api.js'
import { beginCheckout, clearCheckout, pendingCheckout } from './checkoutAttempts.js'
import { useI18n } from './i18n.js'
import { categories, CategoryIcon, categoryClass, formatQuantity, Modal } from './ui.jsx'

import { getProductPhoto } from './productPhotos.js'

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

function SaleList({ sales, onResume, onSelect, compact = false }) {
  const { t, formatCurrency, formatTime } = useI18n()
  if (!sales.length) return <div className="sales-empty"><ReceiptText size={25} /><span>{t('noSalesYet')}</span></div>
  return <div className={`sales-list ${compact ? 'compact' : ''}`}>{sales.map((sale) => {
    const state = sale.status === 'paid' && sale.refundedTotal > 0
      ? { label: t('salePartiallyRefunded'), tone: 'warning' }
      : saleState(sale.status, t)
    const interactive = sale.status === 'pending' || sale.status === 'paid' || sale.status === 'refunded'
    return <button key={sale.id} disabled={!interactive} aria-label={`${t('openSaleDetails')} #${sale.shortId}`} onClick={() => sale.status === 'pending' ? onResume(sale) : onSelect?.(sale)}>
      <div className={`sale-icon ${sale.paymentMethod}`} >{sale.paymentMethod === 'card' ? <CreditCard size={17} /> : <Banknote size={17} />}</div>
      <div className="sale-copy"><strong>#{sale.shortId}</strong><span>{sale.items.length} {sale.items.length === 1 ? t('item') : t('items')} · {formatTime(sale.createdAt)}</span></div>
      <div className="sale-value"><strong>{formatCurrency(sale.total)}</strong><span className={`sale-status ${state.tone}`}>{state.label}</span></div>
      {interactive && <ChevronRight size={17} />}
    </button>
  })}</div>
}

function CheckoutModal({ checkout, posConfig, onCash, onCard, onRetry, onCancelSale, onClose, busy }) {
  const { t, formatCurrency } = useI18n()
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
  return <Modal title={checkout.stage === 'method' ? t('choosePaymentMethod') : sale ? `#${sale.shortId}` : t('cardPayment')} eyebrow={t('checkout')} onClose={onClose} closeable={!pending}>
    {checkout.stage === 'method' && <div className="checkout-body">
      <div className="checkout-total"><span>{t('totalToPay')}</span><strong>{formatCurrency(checkout.total)}</strong></div>
      <div className="payment-options">
        <button onClick={onCash} disabled={busy}><div className="payment-icon cash"><Banknote size={25} /></div><span><strong>{t('cash')}</strong><small>{t('cashDescription')}</small></span><ChevronRight size={20} /></button>
        <button onClick={onCard} disabled={busy || !posConfig.configured}><div className="payment-icon card"><CreditCard size={25} /></div><span><strong>{t('card')}</strong><small>{posConfig.configured ? t('pointSmart2Description') : t('pointNotConfigured')}</small></span><ChevronRight size={20} /></button>
      </div>
      {!posConfig.configured && <div className="setup-hint"><AlertTriangle size={17} /><span>{t('pointSetupHint')}</span></div>}
    </div>}
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
      <div><BadgeCheck size={34} /></div><h3>{t('paymentApproved')}</h3><p>{sale?.paymentMethod === 'card' ? t('cardSaleCompleted') : t('cashSaleCompleted')}</p>
      <div className="success-total"><span>#{sale?.shortId}</span><strong>{formatCurrency(sale?.total || 0)}</strong></div>
      {sale?.paymentMethod === 'card' && <div className="point-receipt-reminder"><ReceiptText size={17} /><span>{t('deliverPointReceipt')}</span></div>}
      <button className="button primary" onClick={onClose}>{t('newSale')}</button>
    </div>}
  </Modal>
}

function SaleDetailsModal({ sale, onClose, onRefund, onRetryRefund, onPrintRefundCopy, onCreditNote, onReconcilePoint, onResolveInventory, busy }) {
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
      {sale.paymentMethod === 'card' && <section className="point-payment-details">
        <header><div><CreditCard size={17} /><strong>{t('pointPaymentDetails')}</strong></div><button type="button" className="button compact" onClick={() => onReconcilePoint().catch(() => {})} disabled={busy}><RotateCw size={15} />{t('syncPoint')}</button></header>
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
      {sale.refunds?.length > 0 && <section className="refund-history"><div className="section-label"><span>{t('refundHistory')}</span></div>{sale.refunds.map((refund) => <article key={refund.id}>
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
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('close')}</button><button type="button" className="button primary" onClick={openRefund} disabled={busy || sale.status !== 'paid' || sale.refundableTotal <= 0}><Undo2 size={18} />{sale.refundableTotal > 0 ? t('refundSale') : t('noRefundableProducts')}</button></div>
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

export default function SalesCounter({ items, sales, posConfig, onRefresh, setToast }) {
  const { t, categoryLabel, unitLabel, formatCurrency } = useI18n()
  const [registerView, setRegisterView] = useState('cart')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  const [inStockOnly, setInStockOnly] = useState(true)
  const [attempt, setAttempt] = useState(pendingCheckout)
  const [cart, setCart] = useState(() => pendingCheckout()?.items || [])
  const [checkout, setCheckout] = useState(null)
  const [selectedSale, setSelectedSale] = useState(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const recoveryKey = useRef(attempt?.key)
  const sellable = useMemo(() => items.filter((item) => item.sellable && item.price > 0), [items])
  const catalogItems = useMemo(() => inStockOnly ? sellable.filter((item) => item.quantity > 0) : sellable, [inStockOnly, sellable])
  const presentCategories = useMemo(() => categories.filter((category) => catalogItems.some((item) => item.category === category)), [catalogItems])
  const products = catalogItems.filter((item) => (filter === 'All' || item.category === filter) && `${item.name} ${item.sku}`.toLowerCase().includes(search.toLowerCase()))
  const cartLines = cart.map((line) => ({ ...line, item: items.find((item) => item.id === line.itemId) })).filter((line) => line.item)
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
  const pay = async (paymentMethod) => {
    if (submitting.current) return
    submitting.current = true
    const pending = beginCheckout(payload(), paymentMethod, total)
    setAttempt(pending)
    setBusy(true)
    if (pending.paymentMethod === 'card') setCheckout(current => ({ ...current, stage: 'connecting' }))
    try {
      const sale = await (pending.paymentMethod === 'cash' ? api.cashSale : api.cardSale)(pending.items, pending.key)
      await acceptSale(sale)
    } catch (error) {
      const uncertain = error.uncertain || !error.status || error.status >= 500 || error.code === 'CHECKOUT_CONFLICT'
      if (!uncertain) { clearCheckout(pending.key); setAttempt(null) }
      const sale = error.saleId && uncertain ? { id: error.saleId, shortId: error.saleId.replaceAll('-', '').slice(0, 8).toUpperCase(), total: pending.total, status: 'pending' } : null
      setCheckout(current => ({ ...current, stage: uncertain ? 'connection-error' : 'error', sale,
        error: uncertain ? t('checkoutUncertain') : error.message }))
    } finally { setBusy(false); submitting.current = false }
  }
  const payCash = () => pay('cash')
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
    if (filter !== 'All' && !presentCategories.includes(filter)) setFilter('All')
  }, [filter, presentCategories])

  return <div className="page pos-page enter">
    <section className="page-heading pos-heading">
      <h1 className="eyebrow caja-title">{t('registerTitle')}</h1>
      <div className="register-tabs" role="tablist" aria-label={t('registerSections')} onKeyDown={handleRegisterTabKey}>
        <button type="button" id="caja-cart-tab" role="tab" aria-selected={registerView === 'cart'} aria-controls="caja-cart-panel" tabIndex={registerView === 'cart' ? 0 : -1} onClick={() => setRegisterView('cart')}><ShoppingBasket size={16} />{t('cart')}</button>
        <button type="button" id="caja-history-tab" role="tab" aria-selected={registerView === 'history'} aria-controls="caja-history-panel" tabIndex={registerView === 'history' ? 0 : -1} onClick={() => setRegisterView('history')}><History size={16} />{t('registerHistory')}</button>
      </div>
    </section>
    {registerView === 'cart' ? <section className="pos-layout" id="caja-cart-panel" role="tabpanel" aria-labelledby="caja-cart-tab">
      <div className="catalog-panel">
        <div className="toolbar pos-toolbar">
          <div className="catalog-search-row">
            <label className="search-box"><Search size={18} /><input aria-label={t('searchProducts')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} />{search && <button type="button" onClick={() => setSearch('')} aria-label={t('clearSearch')}><X size={16} /></button>}</label>
            <label className="stock-only-toggle"><span>{t('inStockOnly')}</span><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} /><i aria-hidden="true" /></label>
          </div>
          <div className="catalog-category-row">
            <div className="filter-scroll" role="group" aria-label={t('byCategory')}>
              <button type="button" className={filter === 'All' ? 'active' : ''} aria-pressed={filter === 'All'} onClick={() => setFilter('All')}><LayoutDashboard size={15} aria-hidden="true" />{t('all')}<span>{catalogItems.length}</span></button>
              {presentCategories.map((category) => <button type="button" key={category} className={filter === category ? 'active' : ''} aria-pressed={filter === category} onClick={() => setFilter(category)}><CategoryIcon category={category} size={16} />{categoryLabel(category)}<span>{catalogItems.filter((item) => item.category === category).length}</span></button>)}
            </div>
            <span className="catalog-result-count" role="status">{t('productsCount', { count: products.length })}</span>
          </div>
        </div>
        {sellable.length === 0 ? <div className="card pos-empty"><div className="empty-art"><ReceiptText size={31} /></div><h3>{t('configureProductsForSale')}</h3><p>{t('configureProductsDescription')}</p></div> : products.length ? <div className="product-grid">{products.map((item) => {
          const inCart = cart.find((line) => line.itemId === item.id)?.quantity || 0
          return <button key={item.id} className={`sale-product category-${categoryClass(item.category)} ${item.quantity <= 0 ? 'is-unavailable' : ''}`} disabled={Boolean(attempt) || item.quantity <= 0 || inCart >= item.quantity} onClick={() => changeQuantity(item, 1)}>
            <ProductArtwork item={item} />
            {inCart > 0 && <span className="cart-badge">{formatQuantity(inCart)}</span>}
            <strong className="sale-product-name">{item.name}</strong>
            <div className="sale-product-footer"><span className="sale-product-price">{formatCurrency(item.price)}</span>{item.quantity > 0 && <span className="sale-product-stock"><b>{formatQuantity(item.quantity)}</b><small>{unitLabel(item.unit)}</small></span>}</div>
            {item.quantity <= 0 ? <i>{t('outOfStock')}</i> : <Plus className="sale-product-add" size={16} />}
          </button>
        })}</div> : <div className="pos-empty compact"><Search size={27} /><h3>{t('noProductsFound')}</h3></div>}
      </div>
      <aside className={`cart-panel ${cartLines.length ? 'has-items' : ''}`}>
        <header><div><ShoppingBasket size={20} /><h2>{t('cart')}</h2><span className="cart-count" aria-label={t('productsCount', { count: formatQuantity(count) })}>{formatQuantity(count)}</span></div>{cartLines.length > 0 && <button disabled={Boolean(attempt)} onClick={() => setCart([])}><Trash2 size={14} />{t('clear')}</button>}</header>
        {cartLines.length ? <div className="cart-lines">{cartLines.map(({ item, quantity }) => <article key={item.id}><div className="cart-line-main"><div><strong>{item.name}</strong><span>{formatCurrency(item.price)} · {unitLabel(item.unit)}</span></div><b>{formatCurrency(item.price * quantity)}</b></div><div className="quantity-stepper"><button onClick={() => changeQuantity(item, -1)} disabled={Boolean(attempt)} aria-label={t('removeOne')}><Minus size={16} /></button><span>{formatQuantity(quantity)}</span><button onClick={() => changeQuantity(item, 1)} disabled={Boolean(attempt) || quantity >= item.quantity} aria-label={t('addOne')}><Plus size={16} /></button><button className="remove-line" onClick={() => changeQuantity(item, -quantity)} disabled={Boolean(attempt)} aria-label={t('removeFromCart')}><Trash2 size={16} /></button></div></article>)}</div> : <div className="cart-empty"><div><ShoppingBasket size={28} /></div><h3>{t('emptyCart')}</h3><p>{t('tapProducts')}</p></div>}
        <footer><div className="cart-summary"><div><span>{t('total')}</span><strong>{formatCurrency(attempt?.total ?? total)}</strong></div></div><button className="button primary pay-button" disabled={busy || (!attempt && !cartLines.length)} onClick={() => attempt ? recoverCheckout() : setCheckout({ stage: 'method', total })}>{t(attempt ? 'reviewPendingCheckout' : 'charge')}<ArrowRight size={19} /></button></footer>
      </aside>
    </section> : <section className="card register-history" id="caja-history-panel" role="tabpanel" aria-labelledby="caja-history-tab">
      <header className="card-header"><div><h2>{t('registerHistory')}</h2><p>{t('recentSales')}</p></div><span className="history-count">{sales.length}</span></header>
      <SaleList sales={sales} onResume={resumeSale} onSelect={setSelectedSale} />
    </section>}
    {checkout && <CheckoutModal checkout={checkout} posConfig={posConfig} onCash={payCash} onCard={payCard} onRetry={retry} onCancelSale={cancelSale} onClose={() => setCheckout(null)} busy={busy} />}
    {selectedSale && <SaleDetailsModal sale={selectedSale} onClose={() => setSelectedSale(null)} onRefund={refundSale} onRetryRefund={retryRefund} onPrintRefundCopy={printRefundCopy} onCreditNote={recordCreditNote} onReconcilePoint={reconcilePointSale} onResolveInventory={resolveRefundInventory} busy={busy} />}
  </div>
}
