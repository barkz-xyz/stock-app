import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BadgeCheck, Banknote, BarChart3,
  Boxes, CakeSlice, Calculator, CalendarClock, Check, ChevronRight, CirclePlus, Clock3, Coffee, CreditCard, Download,
  Croissant, ExternalLink, FileCheck2, History, LayoutDashboard, LineChart, LockKeyhole, LogOut, MapPin, Menu, Minus, Moon, PanelLeftClose,
  PackageOpen, Pencil, Plus, ReceiptText, RotateCw, Search, ShoppingBasket, Monitor,
  Settings, SlidersHorizontal, Sparkles, Store, Sun, TrendingDown, TrendingUp, Trash2, Undo2, WalletCards, Wheat, Wifi, X,
} from 'lucide-react'
import { api } from './api.js'
import { dateOnly, parseCalendarDate } from './dates.js'
import { useI18n } from './i18n.js'

const categories = ['Bread', 'Pastries', 'Cakes', 'Ingredients', 'Packaging', 'Drinks', 'Other']
const units = ['pieces', 'loaves', 'cakes', 'kg', 'g', 'litres', 'bottles', 'boxes', 'packs']
const categoryIcons = { Bread: Wheat, Pastries: Croissant, Cakes: CakeSlice, Ingredients: Wheat, Packaging: PackageOpen, Drinks: Coffee, Other: Sparkles }
const AstryxDeleteDialog = lazy(() => import('./AstryxDeleteDialog.jsx'))
let openModalCount = 0
const noop = () => {}

function categoryClass(category = '') {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function CategoryIcon({ category, size = 20, className = '' }) {
  const Icon = categoryIcons[category] || Sparkles
  return <Icon className={className} size={size} aria-hidden="true" />
}

function formatQuantity(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function daysUntil(dateValue) {
  const target = parseCalendarDate(dateValue)
  if (!target) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target - today) / 86400000)
}

function stockState(item, t) {
  if (item.quantity === 0) return { label: t('outOfStock'), tone: 'danger' }
  if (item.quantity <= item.lowStockThreshold) return { label: t('lowStockStatus'), tone: 'warning' }
  return { label: t('inStock'), tone: 'success' }
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

function LanguageToggle() {
  const { language, setLanguage, t } = useI18n()
  return <div className="language-toggle" role="group" aria-label={t('language')}>
    <button className={language === 'es' ? 'active' : ''} onClick={() => setLanguage('es')} aria-pressed={language === 'es'}>ES</button>
    <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} aria-pressed={language === 'en'}>EN</button>
  </div>
}

function ThemeToggle({ theme, onToggle }) {
  const { t } = useI18n()
  const dark = theme === 'dark'
  return <button className="icon-button theme-toggle" onClick={onToggle} aria-label={dark ? t('lightMode') : t('darkMode')} title={dark ? t('lightMode') : t('darkMode')}>
    {dark ? <Sun size={18} /> : <Moon size={18} />}
  </button>
}

function LoginScreen({ onLogin, theme, onThemeToggle }) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await onLogin(pin); setPin('') } catch (nextError) { setError(nextError.message) } finally { setBusy(false) }
  }
  return <main className="login-page">
    <div className="login-language"><ThemeToggle theme={theme} onToggle={onThemeToggle} /><LanguageToggle /></div>
    <section className="login-card">
      <div className="login-mark"><Croissant size={31} /></div>
      <span className="eyebrow">Bakery POS</span>
      <h1>{t('welcomeBack')}</h1>
      <p>{t('loginDescription')}</p>
      <form onSubmit={submit}>
        <label htmlFor="staff-pin">{t('staffPin')}</label>
        <div className="pin-input"><LockKeyhole size={19} /><input id="staff-pin" type="password" inputMode="numeric" autoComplete="current-password" autoFocus required value={pin} onChange={(event) => setPin(event.target.value)} placeholder="••••" /></div>
        {error && <div className="inline-error"><AlertTriangle size={16} />{error}</div>}
        <button className="button primary" disabled={busy}>{busy ? t('signingIn') : t('signIn')}<ArrowRight size={18} /></button>
      </form>
    </section>
  </main>
}

function Modal({ title, eyebrow, onClose, children, wide = false, closeable = true }) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && closeable && !document.querySelector('dialog[open]')) onClose()
    }
    document.addEventListener('keydown', onKey)
    openModalCount += 1
    document.body.classList.add('modal-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      openModalCount = Math.max(0, openModalCount - 1)
      if (openModalCount === 0) document.body.classList.remove('modal-open')
    }
  }, [closeable, onClose])

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => closeable && event.target === event.currentTarget && onClose()}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-handle" />
      <header className="modal-header">
        <div><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2></div>
        {closeable && <button className="icon-button" onClick={onClose} aria-label={t('close')}><X size={20} /></button>}
      </header>
      {children}
    </section>
  </div>, document.body)
}

function RefundInventoryPrompt({ sale, refund, onResolve, busy }) {
  const { t, unitLabel, formatCurrency } = useI18n()
  const reference = sale.mpExternalReference || `#${sale.shortId}`
  return <Modal title={t('stockDecisionTitle')} eyebrow={t('externalRefundDetected')} onClose={noop} closeable={false}>
    <div className="inventory-decision">
      <div className="inventory-decision-summary">
        <div className="inventory-decision-icon"><Undo2 size={22} /></div>
        <div><span>{t('refundedSaleReference', { reference })}</span><strong>{formatCurrency(refund.amount)}</strong><small>{t('stockDecisionDescription')}</small></div>
      </div>
      <div className="inventory-decision-lines">
        <span className="section-label">{t('returnedProducts')}</span>
        {refund.items.map((item) => {
          const originalLine = sale.items.find((line) => line.lineId === item.lineId)
          return <div key={item.lineId || item.itemId || item.name}>
            <span><strong>{item.name}</strong><small>{formatCurrency(item.lineTotal || item.unitPrice * item.quantity)}</small></span>
            <b>{formatQuantity(item.quantity)} {originalLine?.unit ? unitLabel(originalLine.unit) : ''}</b>
          </div>
        })}
      </div>
      <div className="inventory-decision-note"><AlertTriangle size={17} /><span>{t('stockDecisionHelp')}</span></div>
      <div className="modal-actions inventory-decision-actions">
        <button type="button" className="button secondary" onClick={() => onResolve(sale.id, refund.id, false)} disabled={busy}><Check size={18} />{t('doNotRestock')}</button>
        <button type="button" className="button primary" onClick={() => onResolve(sale.id, refund.id, true)} disabled={busy || !refund.items.length}><PackageOpen size={18} />{t('restockProducts')}</button>
      </div>
    </div>
  </Modal>
}

function ProductForm({ item, onSubmit, onDelete, onClose, busy, theme }) {
  const { t, categoryLabel, unitLabel, language } = useI18n()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteDialogLoaded, setDeleteDialogLoaded] = useState(false)
  const deleteButtonRef = useRef(null)
  const [form, setForm] = useState({
    name: item?.name || '', category: item?.category || 'Bread', unit: item?.unit || 'pieces',
    quantity: item?.quantity ?? '', lowStockThreshold: item?.lowStockThreshold ?? '',
    sku: item?.sku || '', expiryDate: dateOnly(item?.expiryDate) || '',
    price: item?.price ?? '', sellable: item?.sellable ?? true,
  })
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const submitProduct = (event) => {
    event.preventDefault()
    onSubmit({
      ...form,
      name: form.name.trim(),
      quantity: Number(form.quantity || 0),
      lowStockThreshold: Number(form.lowStockThreshold || 0),
      sku: form.sku.trim(),
      price: form.sellable ? Number(form.price) : 0,
      sellable: Boolean(form.sellable),
    })
  }
  const deleteDescription = item
    ? [
        t('deleteProductDescription', { name: item.name }),
        item.quantity > 0 ? t('deleteProductStockWarning', { count: formatQuantity(item.quantity), unit: unitLabel(item.unit) }) : '',
      ].filter(Boolean).join(' ')
    : ''
  return <>
    <form onSubmit={submitProduct} className="form-stack">
    <div className="field full"><label htmlFor="name">{t('productName')}</label><input id="name" autoFocus required value={form.name} onChange={update('name')} placeholder={t('productNamePlaceholder')} /></div>
    <div className={`sellable-panel ${form.sellable ? 'is-enabled' : 'is-disabled'}`}>
      <label className="switch-field"><input type="checkbox" checked={form.sellable} onChange={(event) => setForm((current) => ({ ...current, sellable: event.target.checked }))} /><i aria-hidden="true" /><span><strong>{t('sellAtCounter')}</strong><small>{t('sellAtCounterDescription')}</small></span></label>
      <div className="field price-field"><label htmlFor="price">{t('salePrice')}</label><div className="money-input"><span aria-hidden="true">$</span><input id="price" type="number" inputMode="numeric" min={form.sellable ? '1' : '0'} step="1" required={form.sellable} disabled={!form.sellable} value={form.price} onChange={update('price')} placeholder="0" /></div></div>
    </div>
    <div className="form-grid">
      <div className="field"><label htmlFor="category">{t('category')}</label><select id="category" value={form.category} onChange={update('category')}>{categories.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></div>
      <div className="field"><label htmlFor="unit">{t('measuredIn')}</label><select id="unit" value={form.unit} onChange={update('unit')}>{units.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}</select></div>
      {!item && <div className="field"><label htmlFor="quantity">{t('openingQuantity')}</label><input id="quantity" type="number" min="0" step="0.01" required value={form.quantity} onChange={update('quantity')} placeholder="0" /></div>}
      <div className="field"><label htmlFor="threshold">{t('lowStockAlert')}</label><input id="threshold" type="number" min="0" step="0.01" required value={form.lowStockThreshold} onChange={update('lowStockThreshold')} placeholder="0" /></div>
      <div className="field"><label htmlFor="expiry">{t('expiryDate')} <span>{t('optional')}</span></label><input id="expiry" type="date" value={form.expiryDate} onChange={update('expiryDate')} /></div>
      <div className="field"><label htmlFor="sku">{t('sku')} <span>{t('optional')}</span></label><input id="sku" value={form.sku} onChange={update('sku')} placeholder={t('skuPlaceholder')} /></div>
    </div>
    {item && <button ref={deleteButtonRef} type="button" className="delete-product-link" onClick={() => { setDeleteDialogLoaded(true); setConfirmingDelete(true) }}><Trash2 size={16} />{t('deleteProduct')}</button>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('saving') : item ? t('saveChanges') : t('addProduct')}<Check size={18} /></button></div>
    </form>
    {item && deleteDialogLoaded && <Suspense fallback={null}><AstryxDeleteDialog
        language={language}
        mode={theme}
        className="bakery-alert-dialog"
        isOpen={confirmingDelete}
        onOpenChange={(isOpen) => {
          if (busy) return
          setConfirmingDelete(isOpen)
          if (!isOpen) window.requestAnimationFrame(() => window.requestAnimationFrame(() => deleteButtonRef.current?.focus()))
        }}
        title={t('deleteProductQuestion')}
        description={deleteDescription}
        cancelLabel={t('keepProduct')}
        actionLabel={busy ? t('deleting') : t('deletePermanently')}
        actionVariant="destructive"
        isActionLoading={busy}
        onAction={onDelete}
        width="min(480px, calc(100vw - 32px))"
      /></Suspense>}
  </>
}

function AdjustForm({ item, initialType = 'stock_in', onSubmit, onClose, busy }) {
  const { t, unitLabel } = useI18n()
  const [type, setType] = useState(initialType)
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const newBalance = type === 'adjustment' ? Number(quantity || item.quantity) : Math.max(0, item.quantity + (type === 'stock_in' ? 1 : -1) * Number(quantity || 0))
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit({ type, quantity, note }) }} className="form-stack">
    <div className="current-balance"><div className={`product-glyph category-${categoryClass(item.category)}`}><CategoryIcon category={item.category} size={22} /></div><div><span>{t('currentBalance')}</span><strong>{formatQuantity(item.quantity)} {unitLabel(item.unit)}</strong></div></div>
    <div className="segmented" aria-label={t('stockAction')}>
      <button type="button" className={type === 'stock_in' ? 'active' : ''} onClick={() => setType('stock_in')}><Plus size={17} /> {t('stockIn')}</button>
      <button type="button" className={type === 'stock_out' ? 'active' : ''} onClick={() => setType('stock_out')}><Minus size={17} /> {t('stockOut')}</button>
      <button type="button" className={type === 'adjustment' ? 'active' : ''} onClick={() => setType('adjustment')}><SlidersHorizontal size={17} /> {t('setCount')}</button>
    </div>
    <div className="field full"><label htmlFor="adjust-quantity">{type === 'adjustment' ? t('newTotalQuantity') : t('quantity')}</label><div className="input-suffix"><input id="adjust-quantity" autoFocus type="number" min="0" max={type === 'stock_out' ? item.quantity : undefined} step="0.01" required value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" /><span>{unitLabel(item.unit)}</span></div></div>
    <div className="balance-preview"><span>{t('balanceAfterUpdate')}</span><strong>{formatQuantity(newBalance)} {unitLabel(item.unit)}</strong></div>
    <div className="field full"><label htmlFor="note">{t('note')} <span>{t('optional')}</span></label><input id="note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('notePlaceholder')} /></div>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('updating') : t('updateStockButton')}<ArrowRight size={18} /></button></div>
  </form>
}

function EmptyState({ onAdd }) {
  const { t } = useI18n()
  return <div className="empty-state"><div className="empty-art"><PackageOpen size={32} /></div><h3>{t('shelvesReady')}</h3><p>{t('emptyInventoryDescription')}</p><button className="button primary" onClick={onAdd}><Plus size={18} /> {t('addFirstProduct')}</button></div>
}

function InventoryList({ items, onAdjust, onEdit }) {
  const { t, categoryLabel, unitLabel, formatDate, formatCurrency } = useI18n()
  return <div className="inventory-list">
    <div className="inventory-head"><span>{t('product')}</span><span>{t('available')}</span><span>{t('status')}</span><span>{t('expiry')}</span><span aria-hidden="true" /></div>
    {items.map((item) => {
      const state = stockState(item, t); const expiry = daysUntil(item.expiryDate)
      const details = [categoryLabel(item.category), item.sku, item.sellable && item.price > 0 ? formatCurrency(item.price) : t('notForSale')].filter(Boolean).join(' · ')
      return <article className="inventory-row" key={item.id}>
        <div className="product-cell"><div className={`product-glyph category-${categoryClass(item.category)}`}><CategoryIcon category={item.category} size={20} /></div><div><strong>{item.name}</strong><span>{details}</span></div></div>
        <div className="quantity-cell"><strong>{formatQuantity(item.quantity)}</strong><span>{unitLabel(item.unit)}</span></div>
        <div><span className={`status ${state.tone}`}><i />{state.label}</span></div>
        <div className={`expiry-cell ${expiry !== null && expiry <= 2 ? 'urgent' : ''}`}>{item.expiryDate ? <><CalendarClock size={16} /><span>{expiry < 0 ? t('expired') : expiry === 0 ? t('todayExpiry') : formatDate(item.expiryDate)}</span></> : <span>—</span>}</div>
        <div className="row-actions"><button className="button compact" onClick={() => onAdjust(item)}>{t('updateStockButton')}</button><button className="icon-button subtle" onClick={() => onEdit(item)} aria-label={`${t('productDetails')}: ${item.name}`}><Pencil size={17} /></button></div>
      </article>
    })}
  </div>
}

function Dashboard({ items, movements, sales, onAdd, onAdjust, onGoInventory, onGoPos }) {
  const { t, categoryLabel, unitLabel, formatCurrency } = useI18n()
  const lowItems = items.filter((item) => item.quantity <= item.lowStockThreshold)
  const expiring = items.filter((item) => { const days = daysUntil(item.expiryDate); return days !== null && days >= 0 && days <= 3 })
  const unitsOnHand = items.reduce((sum, item) => sum + Number(item.quantity), 0)
  const today = new Date().toDateString()
  const todaySales = sales.filter((sale) => sale.status === 'paid' && new Date(sale.paidAt || sale.createdAt).toDateString() === today)
  const todayRevenue = todaySales.reduce((sum, sale) => sum + sale.total, 0)
  const categoriesData = Object.entries(items.reduce((acc, item) => ({ ...acc, [item.category]: (acc[item.category] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])
  const maxCategory = Math.max(...categoriesData.map(([, value]) => value), 1)
  const greetingKey = new Date().getHours() < 12 ? 'greetingMorning' : new Date().getHours() < 18 ? 'greetingAfternoon' : 'greetingEvening'
  return <div className="page enter">
    <section className="welcome-row"><div><span className="eyebrow">{t('liveInventory')}</span><h1>{t(greetingKey)}</h1><p>{t('welcomeMessage')}</p></div><div className="heading-actions"><button className="button secondary desktop-action" onClick={onGoPos}><ShoppingBasket size={19} /> {t('newSale')}</button><button className="button primary desktop-action" onClick={onAdd}><CirclePlus size={19} /> {t('addProduct')}</button></div></section>
    <section className="metrics" aria-label={t('inventorySummary')}>
      <div className="metric-card"><div className="metric-icon cocoa"><ReceiptText size={20} /></div><div><span>{t('salesToday')}</span><strong>{formatCurrency(todayRevenue)}</strong><small>{t('transactionsToday', { count: todaySales.length })}</small></div></div>
      <div className="metric-card"><div className="metric-icon sage"><BarChart3 size={20} /></div><div><span>{t('unitsOnHand')}</span><strong>{formatQuantity(unitsOnHand)}</strong><small>{t('currentRecordedTotal')}</small></div></div>
      <div className={`metric-card ${lowItems.length ? 'attention' : ''}`}><div className="metric-icon amber"><AlertTriangle size={20} /></div><div><span>{t('needAttention')}</span><strong>{lowItems.length}</strong><small>{lowItems.length ? t('atOrBelowMinimum') : t('everythingHealthy')}</small></div></div>
      <div className="metric-card"><div className="metric-icon rose"><CalendarClock size={20} /></div><div><span>{t('expiringSoon')}</span><strong>{expiring.length}</strong><small>{t('next3Days')}</small></div></div>
    </section>
    <section className="dashboard-grid">
      <div className="card stock-card"><header className="card-header"><div><span className="eyebrow">{t('inventoryHealth')}</span><h2>{t('stockRequiringAttention')}</h2></div><button className="text-button" onClick={onGoInventory}>{t('viewAll')} <ChevronRight size={17} /></button></header>
        {lowItems.length ? <div className="attention-list">{lowItems.slice(0, 5).map((item) => <button key={item.id} onClick={() => onAdjust(item)}><div className={`product-glyph category-${categoryClass(item.category)}`}><CategoryIcon category={item.category} size={19} /></div><div className="attention-copy"><strong>{item.name}</strong><span>{categoryLabel(item.category)} · {t('minimum')} {formatQuantity(item.lowStockThreshold)}</span></div><div className="attention-count"><strong>{formatQuantity(item.quantity)}</strong><span>{unitLabel(item.unit)}</span></div><ChevronRight size={18} /></button>)}</div> : <div className="all-good"><div><Sparkles size={24} /></div><h3>{t('everythingStocked')}</h3><p>{t('noBelowAlert')}</p></div>}
      </div>
      <div className="card category-card"><header className="card-header"><div><span className="eyebrow">{t('productMix')}</span><h2>{t('byCategory')}</h2></div></header>
        {categoriesData.length ? <div className="category-bars">{categoriesData.slice(0, 6).map(([category, count], index) => <div className="category-bar" key={category}><div><span>{categoryLabel(category)}</span><strong>{count}</strong></div><div className="bar-track"><i style={{ width: `${(count / maxCategory) * 100}%`, '--delay': `${index * 60}ms` }} /></div></div>)}</div> : <p className="muted">{t('categoriesEmpty')}</p>}
      </div>
      <div className="card activity-card"><header className="card-header"><div><span className="eyebrow">{t('latestChanges')}</span><h2>{t('recentActivity')}</h2></div></header>
        {movements.length ? <div className="activity-list">{movements.slice(0, 6).map((movement) => <Movement key={movement.id} movement={movement} />)}</div> : <div className="all-good small"><Clock3 size={23} /><p>{t('stockActivityEmpty')}</p></div>}
      </div>
    </section>
  </div>
}

function Movement({ movement }) {
  const { t, formatTime } = useI18n()
  const positive = movement.quantity >= 0
  const cashSale = movement.note.match(/^Sale #(\w+)/)
  const reservedSale = movement.note.match(/^Reserved for card sale #(\w+)/)
  const restoredSale = movement.note.match(/^Card sale #(\w+).+stock restored$/)
  const note = movement.note === 'Opening stock' ? t('openingStock')
    : cashSale ? t('saleMovement', { id: cashSale[1] })
      : reservedSale ? t('cardStockReserved', { id: reservedSale[1] })
        : restoredSale ? t('cardStockRestored', { id: restoredSale[1] })
          : movement.note || (movement.type === 'stock_in' ? t('stockReceived') : movement.type === 'stock_out' ? t('stockRemoved') : t('countCorrected'))
  return <div className="activity-item"><div className={`movement-icon ${movement.type}`}>{movement.type === 'stock_in' ? <ArrowUp size={17} /> : movement.type === 'stock_out' ? <ArrowDown size={17} /> : <SlidersHorizontal size={17} />}</div><div><strong>{movement.itemName}</strong><span>{note}</span></div><div className="movement-value"><strong className={positive ? 'positive' : 'negative'}>{positive ? '+' : ''}{formatQuantity(movement.quantity)}</strong><span>{formatTime(movement.createdAt)}</span></div></div>
}

function Inventory({ items, onAdd, onAdjust, onEdit }) {
  const { t, categoryLabel } = useI18n()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  const [inStockOnly, setInStockOnly] = useState(true)
  const visibleItems = inStockOnly ? items.filter((item) => item.quantity > 0) : items
  const filtered = visibleItems.filter((item) => {
    const textMatch = `${item.name} ${item.category} ${item.sku}`.toLowerCase().includes(search.toLowerCase())
    const filterMatch = filter === 'All' || filter === item.category || (filter === 'Low stock' && item.quantity <= item.lowStockThreshold) || (filter === 'For sale' && item.sellable)
    return textMatch && filterMatch
  })
  const presentCategories = categories.filter((category) => visibleItems.some((item) => item.category === category))
  return <div className="page enter"><section className="page-heading"><div><span className="eyebrow">{t('allProducts')}</span><h1>{t('inventory')}</h1><p>{t('inventoryDescription')}</p></div><button className="button primary desktop-action" onClick={onAdd}><Plus size={19} /> {t('addProduct')}</button></section>
    <div className="toolbar"><label className="search-box"><Search size={19} /><input aria-label={t('searchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} />{search && <button onClick={() => setSearch('')} aria-label={t('close')}><X size={16} /></button>}</label><label className="stock-only-toggle"><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} /><i aria-hidden="true" /><span>{t('inStockOnly')}</span></label><div className="filter-scroll"><button className={filter === 'All' ? 'active' : ''} onClick={() => setFilter('All')}>{t('all')} <span>{visibleItems.length}</span></button><button className={filter === 'For sale' ? 'active' : ''} onClick={() => setFilter('For sale')}>{t('forSale')} <span>{visibleItems.filter((item) => item.sellable).length}</span></button><button className={filter === 'Low stock' ? 'active' : ''} onClick={() => setFilter('Low stock')}>{t('lowStock')} <span>{visibleItems.filter((item) => item.quantity <= item.lowStockThreshold).length}</span></button>{presentCategories.map((category) => <button key={category} className={filter === category ? 'active' : ''} onClick={() => setFilter(category)}>{categoryLabel(category)}</button>)}</div></div>
    <section className="card inventory-card">{items.length === 0 ? <EmptyState onAdd={onAdd} /> : filtered.length ? <InventoryList items={filtered} onAdjust={onAdjust} onEdit={onEdit} /> : <div className="empty-state compact"><Search size={28} /><h3>{t('noProductsFound')}</h3><p>{t('noProductsDescription')}</p></div>}</section>
  </div>
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

function SalesCounter({ items, sales, posConfig, onRefresh, setToast }) {
  const { t, categoryLabel, unitLabel, formatCurrency } = useI18n()
  const [registerView, setRegisterView] = useState('cart')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  const [inStockOnly, setInStockOnly] = useState(true)
  const [cart, setCart] = useState([])
  const [checkout, setCheckout] = useState(null)
  const [selectedSale, setSelectedSale] = useState(null)
  const [busy, setBusy] = useState(false)
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

  const changeQuantity = (item, delta) => setCart((current) => {
    const existing = current.find((line) => line.itemId === item.id)
    const next = Math.max(0, Math.min(item.quantity, (existing?.quantity || 0) + delta))
    if (!existing && next > 0) return [...current, { itemId: item.id, quantity: next }]
    if (next === 0) return current.filter((line) => line.itemId !== item.id)
    return current.map((line) => line.itemId === item.id ? { ...line, quantity: next } : line)
  })
  const payload = () => cartLines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }))
  const finish = async (sale) => {
    setCheckout((current) => ({ ...current, stage: sale.status === 'paid' ? 'success' : 'error', sale, error: sale.status === 'paid' ? '' : t('stockRestored') }))
    if (sale.status === 'paid') setCart([])
    await onRefresh()
  }
  const payCash = async () => {
    setBusy(true)
    try { await finish(await api.cashSale(payload())) } catch (error) { setCheckout((current) => ({ ...current, stage: 'error', error: error.message })) } finally { setBusy(false) }
  }
  const payCard = async () => {
    setBusy(true); setCheckout((current) => ({ ...current, stage: 'connecting' }))
    try {
      const sale = await api.cardSale(payload())
      setCheckout((current) => ({ ...current, stage: 'processing', sale }))
      await onRefresh()
    } catch (error) {
      const sale = error.saleId && error.uncertain ? { id: error.saleId, shortId: error.saleId.replaceAll('-', '').slice(0, 8).toUpperCase(), total, status: 'pending' } : null
      setCheckout((current) => ({ ...current, stage: error.uncertain ? 'connection-error' : 'error', sale, error: error.message }))
      await onRefresh().catch(() => {})
    } finally { setBusy(false) }
  }
  const retry = async () => {
    if (!checkout.sale?.id) return
    setBusy(true)
    try { const sale = await api.retryCardSale(checkout.sale.id); setCheckout((current) => ({ ...current, stage: 'processing', sale, error: '' })) }
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
        <div className="toolbar pos-toolbar"><label className="search-box"><Search size={19} /><input aria-label={t('searchProducts')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchProducts')} />{search && <button onClick={() => setSearch('')} aria-label={t('close')}><X size={16} /></button>}</label><label className="stock-only-toggle"><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} /><i aria-hidden="true" /><span>{t('inStockOnly')}</span></label><div className="filter-scroll"><button className={filter === 'All' ? 'active' : ''} onClick={() => setFilter('All')}>{t('all')}</button>{presentCategories.map((category) => <button key={category} className={filter === category ? 'active' : ''} onClick={() => setFilter(category)}>{categoryLabel(category)}</button>)}</div></div>
        {sellable.length === 0 ? <div className="card pos-empty"><div className="empty-art"><ReceiptText size={31} /></div><h3>{t('configureProductsForSale')}</h3><p>{t('configureProductsDescription')}</p></div> : products.length ? <div className="product-grid">{products.map((item) => {
          const inCart = cart.find((line) => line.itemId === item.id)?.quantity || 0
          return <button key={item.id} className={`sale-product category-${categoryClass(item.category)} ${item.quantity <= 0 ? 'is-unavailable' : ''}`} disabled={item.quantity <= 0 || inCart >= item.quantity} onClick={() => changeQuantity(item, 1)}>
            <CategoryIcon category={item.category} size={82} className="sale-product-art" />
            {inCart > 0 && <span className="cart-badge">{formatQuantity(inCart)}</span>}
            <strong className="sale-product-name">{item.name}</strong>
            <div className="sale-product-footer"><span className="sale-product-price">{formatCurrency(item.price)}</span>{item.quantity > 0 && <span className="sale-product-stock"><b>{formatQuantity(item.quantity)}</b><small>{unitLabel(item.unit)}</small></span>}</div>
            {item.quantity <= 0 ? <i>{t('outOfStock')}</i> : <Plus className="sale-product-add" size={16} />}
          </button>
        })}</div> : <div className="pos-empty compact"><Search size={27} /><h3>{t('noProductsFound')}</h3></div>}
      </div>
      <aside className={`cart-panel ${cartLines.length ? 'has-items' : ''}`}>
        <header><div><ShoppingBasket size={20} /><h2>{t('cart')}</h2><span className="cart-count" aria-label={t('productsCount', { count: formatQuantity(count) })}>{formatQuantity(count)}</span></div>{cartLines.length > 0 && <button onClick={() => setCart([])}><Trash2 size={14} />{t('clear')}</button>}</header>
        {cartLines.length ? <div className="cart-lines">{cartLines.map(({ item, quantity }) => <article key={item.id}><div className="cart-line-main"><div><strong>{item.name}</strong><span>{formatCurrency(item.price)} · {unitLabel(item.unit)}</span></div><b>{formatCurrency(item.price * quantity)}</b></div><div className="quantity-stepper"><button onClick={() => changeQuantity(item, -1)} aria-label={t('removeOne')}><Minus size={16} /></button><span>{formatQuantity(quantity)}</span><button onClick={() => changeQuantity(item, 1)} disabled={quantity >= item.quantity} aria-label={t('addOne')}><Plus size={16} /></button><button className="remove-line" onClick={() => changeQuantity(item, -quantity)} aria-label={t('removeFromCart')}><Trash2 size={16} /></button></div></article>)}</div> : <div className="cart-empty"><div><ShoppingBasket size={28} /></div><h3>{t('emptyCart')}</h3><p>{t('tapProducts')}</p></div>}
        <footer><div className="cart-summary"><div><span>{t('total')}</span><strong>{formatCurrency(total)}</strong></div></div><button className="button primary pay-button" disabled={!cartLines.length} onClick={() => setCheckout({ stage: 'method', total })}>{t('charge')}<ArrowRight size={19} /></button></footer>
      </aside>
    </section> : <section className="card register-history" id="caja-history-panel" role="tabpanel" aria-labelledby="caja-history-tab">
      <header className="card-header"><div><h2>{t('registerHistory')}</h2><p>{t('recentSales')}</p></div><span className="history-count">{sales.length}</span></header>
      <SaleList sales={sales} onResume={resumeSale} onSelect={setSelectedSale} />
    </section>}
    {checkout && <CheckoutModal checkout={checkout} posConfig={posConfig} onCash={payCash} onCard={payCard} onRetry={retry} onCancelSale={cancelSale} onClose={() => setCheckout(null)} busy={busy} />}
    {selectedSale && <SaleDetailsModal sale={selectedSale} onClose={() => setSelectedSale(null)} onRefund={refundSale} onRetryRefund={retryRefund} onPrintRefundCopy={printRefundCopy} onCreditNote={recordCreditNote} onReconcilePoint={reconcilePointSale} onResolveInventory={resolveRefundInventory} busy={busy} />}
  </div>
}

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

function CashCloseForm({ metrics, onSubmit, onClose, busy }) {
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

function MetricsPage({ metrics, range, onRangeChange, onRefresh, onOpenClose, onExport, loading, exporting }) {
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

function Activity({ movements }) {
  const { t, formatDate } = useI18n()
  const grouped = movements.reduce((acc, movement) => {
    const key = new Date(movement.createdAt).toDateString()
    acc[key] = [...(acc[key] || []), movement]
    return acc
  }, {})
  return <div className="page enter activity-page">
    <section className="page-heading"><div><span className="eyebrow">{t('activityTrail')}</span><h1>{t('activity')}</h1><p>{t('activityDescription')}</p></div></section>
    <section className="card history-card"><header className="activity-section-header"><span className="eyebrow">{t('stockMovementHistory')}</span></header>{movements.length ? Object.entries(grouped).map(([day, entries]) => <div className="history-group" key={day}><h3>{new Date(day).toDateString() === new Date().toDateString() ? t('today') : formatDate(new Date(day))}</h3><div>{entries.map((movement) => <Movement movement={movement} key={movement.id} />)}</div></div>) : <div className="empty-state compact"><History size={30} /><h3>{t('noActivity')}</h3><p>{t('noActivityDescription')}</p></div>}</section>
  </div>
}

function MercadoPagoSettings({ setToast }) {
  const { t } = useI18n()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await api.posManagement()) } catch (nextError) { setError(nextError.message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (action, successMessage) => {
    setBusy(true)
    try { await action(); await load(); setEditor(null); setToast({ type: 'success', message: successMessage }) }
    catch (nextError) { setToast({ type: 'error', message: nextError.message }) }
    finally { setBusy(false) }
  }
  const remove = (kind, entry) => {
    const name = entry.name || entry.id
    if (!window.confirm(t('deleteMpResourceQuestion', { name }))) return
    const action = kind === 'store' ? () => api.deletePointStore(entry.id) : () => api.deletePointRegister(entry.id)
    run(action, t('mpResourceDeleted', { name }))
  }
  const changeMode = (terminal) => {
    const nextMode = terminal.operating_mode === 'PDV' ? 'STANDALONE' : 'PDV'
    if (!window.confirm(t('changeTerminalModeQuestion', { mode: nextMode }))) return
    run(() => api.setPointTerminalMode(terminal.id, nextMode), t('terminalModeUpdated', { mode: nextMode }))
  }

  const stores = data?.stores || []
  const registers = data?.registers || []
  const terminals = data?.terminals || []
  const activeTerminal = terminals.find((terminal) => terminal.configured) || terminals[0] || null
  const storeDeleteBlocked = (store) => store.assigned || Number(store.register_count || 0) > 0
  const registerDeleteBlocked = (register) => register.assigned

  if (loading && !data) return <div className="page enter"><div className="loading"><div className="loader-mark"><Settings size={26} /></div><span>{t('loadingMpSettings')}</span></div></div>
  return <div className="page enter settings-page">
    <section className="page-heading"><div><span className="eyebrow">{t('mpSettingsEyebrow')}</span><h1>{t('mpSettings')}</h1><p>{t('mpSettingsDescription')}</p></div><button className="button secondary compact" onClick={load} disabled={loading}><RotateCw size={16} />{t('refreshSettings')}</button></section>
    {error && <div className="inline-error settings-error"><AlertTriangle size={16} />{error}</div>}
    {data && <>
      <section className="settings-account card">
        <div className="settings-account-identity"><div className="metric-icon"><WalletCards size={20} /></div><div><span className="eyebrow">{t('mpAccount')}</span><strong>{data.account?.nickname || t('sellerAccount')}</strong><small>{t('sellerId')}: {data.account?.id || '—'} · {t('site')}: {data.account?.site_id || '—'}</small></div></div>
        <div className="settings-health" aria-label={t('serverIntegration')}>
          <span className={`status-pill ${data.configuration?.credentialsCentralized && data.configuration?.credentialsExposedToClient === false ? 'success' : 'danger'}`} title={t('serverCredentialsDescription')}><LockKeyhole size={13} />{t('serverCredentials')}</span>
          <span className={`status-pill ${data.configuration?.webhookConfigured && data.configuration?.webhookTopic === 'order' ? 'success' : 'danger'}`} title={t('webhookConfiguredDescription')}><BadgeCheck size={13} />{t('webhookConfigured')}</span>
        </div>
      </section>
      <div className="settings-grid">
        <section className="card settings-card"><header className="card-header"><div><span className="eyebrow">{t('branches')}</span><h2>{t('branchesTitle')}</h2><p>{t('branchesDescription')}</p></div><button className="button secondary compact settings-create-button" onClick={() => setEditor({ type: 'store' })}><Plus size={16} />{t('newBranch')}</button></header><div className="settings-list">{stores.length ? stores.map((store) => {
          const blocked = storeDeleteBlocked(store)
          return <article className={`settings-row ${store.assigned ? 'is-assigned' : ''}`} key={store.id}>
            <div className="settings-row-icon"><Store size={18} /></div>
            <div className="settings-row-copy"><div><strong>{store.name || store.id}</strong>{store.assigned && <span className="resource-current"><BadgeCheck size={12} />{t('currentBranch')}</span>}</div><small>{store.external_id || store.id}{store.location?.city_name ? ` · ${store.location.city_name}` : ''}</small></div>
            <span className="settings-resource-count">{t('cashRegisterCount', { count: Number(store.register_count || 0) })}</span>
            <div className="settings-resource-actions"><button className="settings-action-button" onClick={() => setEditor({ type: 'store', entry: store })}><Pencil size={15} />{t('edit')}</button>{blocked ? <span className="settings-resource-locked" title={t('resourceInUse')}><LockKeyhole size={14} />{t('inUse')}</span> : <button className="settings-action-button danger" onClick={() => remove('store', store)}><Trash2 size={15} />{t('delete')}</button>}</div>
          </article>
        }) : <div className="settings-empty"><Store size={22} /><span>{t('noBranches')}</span></div>}</div></section>
        <section className="card settings-card"><header className="card-header"><div><span className="eyebrow">{t('cashRegisters')}</span><h2>{t('cashRegistersTitle')}</h2><p>{t('cashRegistersDescription')}</p></div><button className="button secondary compact settings-create-button" onClick={() => setEditor({ type: 'register' })}><Plus size={16} />{t('newCashRegister')}</button></header><div className="settings-list">{registers.length ? registers.map((register) => {
          const blocked = registerDeleteBlocked(register)
          return <article className={`settings-row ${register.assigned ? 'is-assigned' : ''}`} key={register.id}>
            <div className="settings-row-icon"><Monitor size={18} /></div>
            <div className="settings-row-copy"><div><strong>{register.name || register.id}</strong>{register.assigned && <span className="resource-current"><BadgeCheck size={12} />{t('currentCashRegister')}</span>}</div><small>{register.external_id || register.id} · {register.store?.name || t('branchNotFound')}</small></div>
            <div className="settings-resource-actions"><button className="settings-action-button" onClick={() => setEditor({ type: 'register', entry: register })}><Pencil size={15} />{t('edit')}</button>{blocked ? <span className="settings-resource-locked" title={t('resourceInUse')}><LockKeyhole size={14} />{t('inUse')}</span> : <button className="settings-action-button danger" onClick={() => remove('register', register)}><Trash2 size={15} />{t('delete')}</button>}</div>
          </article>
        }) : <div className="settings-empty"><Monitor size={22} /><span>{t('noCashRegisters')}</span></div>}</div></section>
      </div>
      <section className="card settings-card terminal-settings-card"><header className="card-header"><div><span className="eyebrow">{t('terminals')}</span><h2>{t('terminalsTitle')}</h2><p>{t('terminalsDescription')}</p></div></header>{activeTerminal ? <div className="terminal-management">
        <div className="terminal-summary"><div className="terminal-identity"><div className="settings-row-icon"><Wifi size={20} /></div><div><span>{t('pointSmart2')}</span><strong>{activeTerminal.serial || activeTerminal.id}</strong><small>{activeTerminal.configured ? t('bakeryPosTerminal') : activeTerminal.id}</small></div></div><div className="terminal-statuses"><span className={`status-pill ${activeTerminal.operating_mode === 'PDV' ? 'success' : 'neutral'}`}>{activeTerminal.operating_mode || '—'}</span><span className={`status-pill ${activeTerminal.ready ? 'success' : 'warning'}`}>{activeTerminal.ready ? t('readyToCharge') : t('setupIncomplete')}</span>{activeTerminal.online === false && <span className="status-pill danger">{t('notConnected')}</span>}</div></div>
        <div className="terminal-assignment"><div className="terminal-assignment-title"><span className="eyebrow">{t('currentAssignment')}</span><small>{t('assignmentVerifiedFromApi')}</small></div><div className="terminal-assignment-flow"><div className="assignment-node"><span><MapPin size={17} /></span><div><small>{t('branch')}</small><strong>{activeTerminal.store?.name || t('unassigned')}</strong><b>{activeTerminal.store?.external_id || activeTerminal.store_id || '—'}</b></div></div><ChevronRight className="assignment-arrow" size={19} /><div className="assignment-node"><span><Monitor size={17} /></span><div><small>{t('cashRegister')}</small><strong>{activeTerminal.register?.name || t('unassigned')}</strong><b>{activeTerminal.register?.external_id || activeTerminal.pos_id || '—'}</b></div></div></div></div>
        <div className="terminal-management-footer"><div className="terminal-guidance"><AlertTriangle size={17} /><div><strong>{t('assignmentManagedByMercadoPago')}</strong><p>{t('assignmentManagedDescription')}</p></div></div><div className="terminal-actions">{activeTerminal.management_url && <a className="button primary compact" href={activeTerminal.management_url} target="_blank" rel="noreferrer">{t('changeAssignment')}<ExternalLink size={15} /></a>}<button className="button secondary compact" onClick={() => changeMode(activeTerminal)} disabled={busy}>{t('changeMode')}</button></div></div>
      </div> : <div className="settings-empty"><Wifi size={22} /><span>{t('noTerminals')}</span></div>}</section>
    </>}
    {editor && <Modal title={editor.type === 'store' ? (editor.entry ? t('editBranch') : t('newBranch')) : (editor.entry ? t('editCashRegister') : t('newCashRegister'))} eyebrow={t('mpSettingsEyebrow')} onClose={() => setEditor(null)}><PointResourceForm type={editor.type} entry={editor.entry} stores={data?.stores || []} busy={busy} onClose={() => setEditor(null)} onSubmit={(form) => run(() => editor.type === 'store' ? (editor.entry ? api.updatePointStore(editor.entry.id, form) : api.createPointStore(form)) : (editor.entry ? api.updatePointRegister(editor.entry.id, form) : api.createPointRegister(form)), t('mpResourceSaved'))} /></Modal>}
  </div>
}

function PointResourceForm({ type, entry, stores, busy, onClose, onSubmit }) {
  const { t } = useI18n()
  const [form, setForm] = useState(() => type === 'store' ? {
    name: entry?.name || '', external_id: entry?.external_id || '', location: { ...(entry?.location || {}) },
  } : { name: entry?.name || '', external_id: entry?.external_id || '', store_id: entry?.store_id || '', fixed_amount: entry?.fixed_amount ?? false })
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const updateLocation = (key, value) => setForm((current) => ({ ...current, location: { ...current.location, [key]: value } }))
  const submit = (event) => { event.preventDefault(); onSubmit(form) }
  return <form className="form-stack settings-form" onSubmit={submit}>
    <label><span>{t('name')}</span><input required maxLength="120" value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
    <label><span>{t('externalId')}</span><input maxLength="60" value={form.external_id} onChange={(event) => update('external_id', event.target.value)} placeholder={type === 'store' ? 'ATELIER-01' : 'CAJA-01'} /></label>
    {type === 'store' ? <div className="settings-form-grid">
      <label><span>{t('street')}</span><input value={form.location.street_name || ''} onChange={(event) => updateLocation('street_name', event.target.value)} /></label>
      <label><span>{t('number')}</span><input value={form.location.street_number || ''} onChange={(event) => updateLocation('street_number', event.target.value)} /></label>
      <label><span>{t('city')}</span><input value={form.location.city_name || ''} onChange={(event) => updateLocation('city_name', event.target.value)} /></label>
      <label><span>{t('region')}</span><input value={form.location.state_name || ''} onChange={(event) => updateLocation('state_name', event.target.value)} /></label>
      <label><span>{t('latitude')}</span><input required type="number" min="-90" max="90" step="any" value={form.location.latitude ?? ''} onChange={(event) => updateLocation('latitude', event.target.value)} placeholder="-33.0245" /></label>
      <label><span>{t('longitude')}</span><input required type="number" min="-180" max="180" step="any" value={form.location.longitude ?? ''} onChange={(event) => updateLocation('longitude', event.target.value)} placeholder="-71.5518" /></label>
    </div> : <>
      <label><span>{t('branch')}</span><select value={form.store_id} onChange={(event) => update('store_id', event.target.value)}><option value="">{t('selectBranch')}</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name || store.id}</option>)}</select></label>
      <label className="switch-field"><input type="checkbox" checked={Boolean(form.fixed_amount)} onChange={(event) => update('fixed_amount', event.target.checked)} /><i /><span>{t('fixedAmount')}</span></label>
    </>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('saving') : t('saveChanges')}<Check size={17} /></button></div>
  </form>
}

export default function App() {
  const { t, formatDate, language } = useI18n()
  const [page, setPage] = useState('dashboard')
  const [items, setItems] = useState([])
  const [movements, setMovements] = useState([])
  const [sales, setSales] = useState([])
  const [metricsData, setMetricsData] = useState(null)
  const [metricsRange, setMetricsRange] = useState('today')
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [exportingReport, setExportingReport] = useState(false)
  const [posConfig, setPosConfig] = useState({ configured: false, mockMode: false, terminalLabel: '' })
  const [auth, setAuth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('bakery-sidebar') !== 'expanded')
  const [theme, setTheme] = useState(() => window.localStorage.getItem('bakery-theme') === 'dark' ? 'dark' : 'light')
  const brandLogoRef = useRef(null)
  const pendingInventoryReview = useMemo(() => {
    for (const sale of sales) {
      const refund = sale.refunds?.find((entry) => entry.status === 'processed' && entry.inventoryReviewStatus === 'pending')
      if (refund) return { sale, refund }
    }
    return null
  }, [sales])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('bakery-theme', theme)
  }, [theme])
  useEffect(() => {
    window.localStorage.setItem('bakery-sidebar', sidebarCollapsed ? 'collapsed' : 'expanded')
  }, [sidebarCollapsed])

  const refresh = useCallback(async () => {
    const [nextItems, nextMovements, nextSales, nextPosConfig] = await Promise.all([api.items(), api.movements(), api.sales(), api.posConfig()])
    setItems(nextItems); setMovements(nextMovements); setSales(nextSales); setPosConfig(nextPosConfig)
  }, [])
  const refreshSales = useCallback(async () => setSales(await api.sales()), [])
  const loadMetrics = useCallback(async (range = metricsRange) => {
    setMetricsLoading(true)
    try { setMetricsData(await api.metrics(range)) }
    catch (error) { setToast({ type: 'error', message: error.message }) }
    finally { setMetricsLoading(false) }
  }, [metricsRange])
  useEffect(() => {
    api.authStatus().then(async (status) => {
      setAuth(status)
      if (status.authenticated) await refresh()
    }).catch((error) => setToast({ type: 'error', message: error.message })).finally(() => setLoading(false))
  }, [refresh])
  useEffect(() => {
    if (!auth?.authenticated) return undefined
    const poll = () => {
      if (document.visibilityState === 'visible') refreshSales().catch(() => {})
    }
    const interval = window.setInterval(poll, 6000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [auth?.authenticated, refreshSales])
  useEffect(() => { if (page === 'metrics' && auth?.authenticated) loadMetrics(metricsRange) }, [auth?.authenticated, loadMetrics, metricsRange, page])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4200); return () => clearTimeout(id) }, [toast])

  const handleLogin = async (pin) => {
    const status = await api.login(pin)
    setAuth(status); setLoading(true)
    try { await refresh() } finally { setLoading(false) }
  }
  const handleLogout = async () => { await api.logout(); setAuth({ ...auth, authenticated: false }); setItems([]); setSales([]); setMovements([]); setMetricsData(null) }
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 780px)').matches) setMobileMenu(false)
    else {
      const willCollapse = !sidebarCollapsed
      setSidebarCollapsed(willCollapse)
      if (willCollapse) window.requestAnimationFrame(() => brandLogoRef.current?.focus({ preventScroll: true }))
    }
  }
  const perform = async (action, message) => {
    setBusy(true)
    try { await action(); await refresh(); setModal(null); setToast({ type: 'success', message }) }
    catch (error) {
      if (error.status === 401) setAuth((current) => ({ ...current, authenticated: false }))
      setToast({ type: 'error', message: error.message })
    } finally { setBusy(false) }
  }
  const checkPoint = async () => {
    try {
      const terminal = await api.terminal()
      const ready = terminal.ready ?? terminal.connected
      setToast({ type: ready ? 'success' : 'error', message: ready ? t('pointReady', { id: terminal.label || '' }) : t('pointNeedsPdv') })
    } catch (error) { setToast({ type: 'error', message: error.message }) }
  }
  const addItem = (form) => perform(() => api.createItem(form), t('productAdded', { name: form.name }))
  const editItem = (item, form) => perform(() => api.updateItem(item.id, form), t('productUpdated', { name: form.name }))
  const deleteItem = (item) => perform(() => api.deleteItem(item.id), t('productDeleted', { name: item.name }))
  const adjustItem = (item, form) => perform(() => api.adjustItem(item.id, form), t('stockUpdated', { name: item.name }))
  const resolvePendingRefundInventory = async (saleId, refundId, restock) => {
    setBusy(true)
    try {
      await api.resolveRefundInventory(saleId, refundId, restock)
      await refresh()
      setToast({ type: 'success', message: restock ? t('inventoryRestocked') : t('inventoryNotRestocked') })
    } catch (error) {
      if (error.status === 401) setAuth((current) => ({ ...current, authenticated: false }))
      setToast({ type: 'error', message: error.message })
    } finally {
      setBusy(false)
    }
  }
  const saveCashClose = async (form) => {
    setBusy(true)
    try {
      await api.saveCashClosure({
        openingCash: Number(form.openingCash || 0), cashAdjustments: Number(form.cashAdjustments || 0),
        countedCash: Number(form.countedCash || 0), note: form.note,
      })
      setModal(null); await loadMetrics(metricsRange); setToast({ type: 'success', message: t('cashCloseSaved') })
    } catch (error) { setToast({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }
  const exportDailyReport = async () => {
    setExportingReport(true)
    try {
      const link = document.createElement('a')
      link.href = api.dailyReportUrl(language); link.download = ''; document.body.appendChild(link); link.click(); link.remove()
      setToast({ type: 'success', message: t('reportExported') })
    } catch (error) { setToast({ type: 'error', message: error.message }) }
    finally { setExportingReport(false) }
  }
  const nav = [
    { id: 'dashboard', label: t('overview'), icon: LayoutDashboard },
    { id: 'pos', label: t('registerTitle'), icon: ShoppingBasket },
    { id: 'inventory', label: t('inventory'), icon: Boxes },
    { id: 'metrics', label: t('metricsNav'), icon: LineChart },
    { id: 'activity', label: t('activity'), icon: History },
    { id: 'settings', label: t('settings'), icon: Settings },
  ]
  const pageTitle = nav.find((entry) => entry.id === page)?.label

  if (loading && !auth) return <div className="loading full"><div className="loader-mark"><Croissant size={28} /></div><span>{t('preparing')}</span></div>
  if (auth?.required && !auth.authenticated) return <LoginScreen onLogin={handleLogin} theme={theme} onThemeToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${page === 'pos' ? 'is-caja' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><button ref={brandLogoRef} className="brand-logo" onClick={toggleSidebar} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')} title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}><span className="brand-mark"><Croissant size={24} /></span></button><span className="brand-copy"><strong>Bakery POS</strong><span>{t('brandSubtitle')}</span></span><button className="sidebar-toggle" onClick={toggleSidebar} aria-label={t('collapseSidebar')} title={t('collapseSidebar')}><PanelLeftClose size={17} /></button></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} title={sidebarCollapsed ? label : undefined} onClick={() => { setPage(id); setMobileMenu(false) }}><Icon size={20} /><span className="nav-label">{label}</span>{page === id && <i />}</button>)}</nav>
      <div className="sidebar-footer"><ThemeToggle theme={theme} onToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />{auth?.required && <button onClick={handleLogout} aria-label={t('signOut')}><LogOut size={15} /></button>}</div>
    </aside>
    {mobileMenu && <button className="menu-backdrop" onClick={() => setMobileMenu(false)} aria-label={t('close')} />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileMenu(true)} aria-label={t('openMenu')}><Menu size={21} /></button><div className="topbar-context"><span>Bakery POS</span><strong>{pageTitle}</strong></div>{page === 'pos' && <button className={`terminal-chip topbar-terminal ${posConfig.configured ? 'ready' : ''}`} onClick={checkPoint} disabled={!posConfig.configured} aria-label={t('pointStatus')} title={posConfig.configured ? t('pointStatus') : t('pointOffline')}><Wifi size={15} /><span className="terminal-dot" /><span className="topbar-terminal-copy"><strong>{posConfig.mockMode ? t('pointDemoMode') : posConfig.configured ? `Point · ${posConfig.terminalLabel}` : t('pointOffline')}</strong><small>{posConfig.mockMode ? t('pointDemoMode') : posConfig.configured ? t('pointStatusReady') : t('pointOffline')}</small></span></button>}<span className="topbar-spacer" /><ThemeToggle theme={theme} onToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} /><LanguageToggle />{['dashboard', 'inventory'].includes(page) && <button className="button primary mobile-add" onClick={() => setModal({ type: 'add' })}><Plus size={20} /><span>{t('add')}</span></button>}<div className="date-chip"><Clock3 size={17} /><span>{formatDate(new Date().toISOString().slice(0, 10))}</span></div></header>
      {loading ? <div className="loading"><div className="loader-mark"><Croissant size={28} /></div><span>{t('preparing')}</span></div> : <>
        {page === 'dashboard' && <Dashboard items={items} movements={movements} sales={sales} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onGoInventory={() => setPage('inventory')} onGoPos={() => setPage('pos')} />}
        {page === 'pos' && <SalesCounter items={items} sales={sales} posConfig={posConfig} onRefresh={refresh} setToast={setToast} />}
        {page === 'inventory' && <Inventory items={items} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onEdit={(item) => setModal({ type: 'edit', item })} />}
        {page === 'metrics' && <MetricsPage metrics={metricsData} range={metricsRange} onRangeChange={setMetricsRange} onRefresh={() => loadMetrics(metricsRange)} onOpenClose={() => setModal({ type: 'cash-close' })} onExport={exportDailyReport} loading={metricsLoading} exporting={exportingReport} />}
        {page === 'activity' && <Activity movements={movements} />}
        {page === 'settings' && <MercadoPagoSettings setToast={setToast} />}
      </>}
    </main>
    <nav className="bottom-nav">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
    {modal?.type === 'add' && <Modal title={t('addProduct')} eyebrow={t('inventorySetup')} onClose={() => setModal(null)}><ProductForm onSubmit={addItem} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'edit' && <Modal title={modal.item.name} eyebrow={t('productDetails')} onClose={() => setModal(null)}><ProductForm item={modal.item} onSubmit={(form) => editItem(modal.item, form)} onDelete={() => deleteItem(modal.item)} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'adjust' && <Modal title={modal.item.name} eyebrow={t('updateStock')} onClose={() => setModal(null)}><AdjustForm item={modal.item} onSubmit={(form) => adjustItem(modal.item, form)} onClose={() => setModal(null)} busy={busy} /></Modal>}
    {modal?.type === 'cash-close' && metricsData && <Modal title={t('dayClose')} eyebrow={t('closeSummary')} onClose={() => setModal(null)}><CashCloseForm metrics={metricsData} onSubmit={saveCashClose} onClose={() => setModal(null)} busy={busy} /></Modal>}
    {pendingInventoryReview && <RefundInventoryPrompt sale={pendingInventoryReview.sale} refund={pendingInventoryReview.refund} onResolve={resolvePendingRefundInventory} busy={busy} />}
    {toast && <div className={`toast ${toast.type}`} role="status"><div>{toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}</div><span>{toast.message}</span><button onClick={() => setToast(null)} aria-label={t('close')}><X size={16} /></button></div>}
  </div>
}
