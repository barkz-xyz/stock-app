import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BarChart3, Boxes, CalendarClock, Check, ChevronRight, CirclePlus, Clock3, Croissant, History, LayoutDashboard, LineChart, LockKeyhole, LogOut, Menu, Minus, Moon, PanelLeftClose, PackageOpen, Pencil, Plus, ReceiptText, Search, ShoppingBasket, Settings, SlidersHorizontal, Sparkles, Sun, Trash2, Undo2, Wifi, X } from 'lucide-react'
import { api } from './api.js'
import { watchUpdates } from './liveUpdates.js'
import { createRouter, isPlainNavigation, parseRoute, sectionHref } from './routes.js'
import { dateOnly, parseCalendarDate } from './dates.js'
import { useI18n } from './i18n.js'
import { categories, CategoryIcon, categoryClass, formatQuantity, Modal } from './ui.jsx'

const units = ['pieces', 'loaves', 'cakes', 'kg', 'g', 'litres', 'bottles', 'boxes', 'packs']
const AstryxDeleteDialog = lazy(() => import('./AstryxDeleteDialog.jsx'))
const SalesCounter = lazy(() => import('./SalesCounter.jsx'))
const MetricsPage = lazy(() => import('./MetricsPage.jsx'))
const CashCloseForm = lazy(() => import('./MetricsPage.jsx').then(module => ({ default: module.CashCloseForm })))
const MercadoPagoSettings = lazy(() => import('./MercadoPagoSettings.jsx'))
const noop = () => {}
const router = createRouter(window)

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

function Dashboard({ items, movements, dailySummary, onAdd, onAdjust, onGoInventory, onGoPos }) {
  const { t, categoryLabel, unitLabel, formatCurrency } = useI18n()
  const lowItems = items.filter((item) => item.quantity <= item.lowStockThreshold)
  const expiring = items.filter((item) => { const days = daysUntil(item.expiryDate); return days !== null && days >= 0 && days <= 3 })
  const unitsOnHand = items.reduce((sum, item) => sum + Number(item.quantity), 0)
  const todayRevenue = dailySummary?.revenue || 0
  const categoriesData = Object.entries(items.reduce((acc, item) => ({ ...acc, [item.category]: (acc[item.category] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])
  const maxCategory = Math.max(...categoriesData.map(([, value]) => value), 1)
  const greetingKey = new Date().getHours() < 12 ? 'greetingMorning' : new Date().getHours() < 18 ? 'greetingAfternoon' : 'greetingEvening'
  return <div className="page enter">
    <section className="welcome-row"><div><span className="eyebrow">{t('liveInventory')}</span><h1>{t(greetingKey)}</h1><p>{t('welcomeMessage')}</p></div><div className="heading-actions"><button className="button secondary desktop-action" onClick={onGoPos}><ShoppingBasket size={19} /> {t('newSale')}</button><button className="button primary desktop-action" onClick={onAdd}><CirclePlus size={19} /> {t('addProduct')}</button></div></section>
    <section className="metrics" aria-label={t('inventorySummary')}>
      <div className="metric-card"><div className="metric-icon cocoa"><ReceiptText size={20} /></div><div><span>{t('salesToday')}</span><strong>{formatCurrency(todayRevenue)}</strong><small>{t('transactionsToday', { count: dailySummary?.transactions || 0 })}</small></div></div>
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

export default function App() {
  const { t, formatDate, language } = useI18n()
  const routeUrl = useSyncExternalStore(router.subscribe, router.getSnapshot)
  const route = useMemo(() => parseRoute(routeUrl), [routeUrl])
  const page = route.page
  const setPage = page => router.navigate(sectionHref(page))
  const [items, setItems] = useState([])
  const [movements, setMovements] = useState([])
  const [sales, setSales] = useState([])
  const [dailySummary, setDailySummary] = useState(null)
  const [metricsData, setMetricsData] = useState(null)
  const metricsRange = route.metricsRange
  const setMetricsRange = range => router.navigate(sectionHref('metrics', { range }))
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
  const refreshSequence = useRef(0)
  const metricsRequest = useRef(null)
  useEffect(() => { if (route.canonical) router.navigate(route.canonical, { replace: true }) }, [route.canonical])
  useEffect(() => { setModal(null); setMobileMenu(false) }, [routeUrl])
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
    const sequence = ++refreshSequence.current
    const next = await api.bootstrap()
    if (sequence !== refreshSequence.current) return
    setAuth(next.auth)
    if (!next.auth.authenticated) return
    setItems(next.items); setMovements(next.movements); setSales(next.sales); setPosConfig(next.posConfig); setDailySummary(next.dailySummary)
  }, [])
  const loadMetrics = useCallback(async (range = metricsRange) => {
    metricsRequest.current?.abort()
    const controller = new AbortController()
    metricsRequest.current = controller
    setMetricsLoading(true)
    try {
      const metrics = await api.metrics(range, { signal: controller.signal })
      if (!controller.signal.aborted) setMetricsData(metrics)
    } catch (error) {
      if (!controller.signal.aborted) setToast({ type: 'error', message: error.message })
    } finally {
      if (metricsRequest.current === controller) setMetricsLoading(false)
    }
  }, [metricsRange])
  useEffect(() => {
    let active = true
    refresh().catch((error) => { if (active) setToast({ type: 'error', message: error.message }) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; refreshSequence.current += 1 }
  }, [refresh])
  useEffect(() => {
    if (!auth?.authenticated) return undefined
    return watchUpdates({ refresh, onUnauthorized: () => setAuth(current => ({ ...current, authenticated: false })) })
  }, [auth?.authenticated, refresh])
  useEffect(() => {
    if (page === 'metrics' && auth?.authenticated) loadMetrics(metricsRange)
    return () => metricsRequest.current?.abort()
  }, [auth?.authenticated, loadMetrics, metricsRange, page])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4200); return () => clearTimeout(id) }, [toast])

  const handleLogin = async (pin) => {
    const status = await api.login(pin)
    setAuth(status); setLoading(true)
    try { await refresh() } finally { setLoading(false) }
  }
  const handleLogout = async () => {
    refreshSequence.current += 1
    metricsRequest.current?.abort()
    await api.logout()
    setAuth({ ...auth, authenticated: false }); setItems([]); setSales([]); setMovements([]); setMetricsData(null); setDailySummary(null)
  }
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
  const pageTitle = nav.find((entry) => entry.id === page)?.label || t('sectionNotFound')
  useEffect(() => { document.title = `${pageTitle} · Bakery POS` }, [pageTitle])
  const followSection = (event, href) => {
    if (isPlainNavigation(event)) { event.preventDefault(); router.navigate(href); setMobileMenu(false) }
  }

  if (loading && !auth) return <div className="loading full"><div className="loader-mark"><Croissant size={28} /></div><span>{t('preparing')}</span></div>
  if (auth?.required && !auth.authenticated) return <LoginScreen onLogin={handleLogin} theme={theme} onThemeToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${page === 'pos' ? 'is-caja' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><button ref={brandLogoRef} className="brand-logo" onClick={toggleSidebar} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')} title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}><span className="brand-mark"><Croissant size={24} /></span></button><span className="brand-copy"><strong>Bakery POS</strong><span>{t('brandSubtitle')}</span></span><button className="sidebar-toggle" onClick={toggleSidebar} aria-label={t('collapseSidebar')} title={t('collapseSidebar')}><PanelLeftClose size={17} /></button></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <a key={id} href={sectionHref(id)} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} title={sidebarCollapsed ? label : undefined} onClick={event => followSection(event, sectionHref(id))}><Icon size={20} /><span className="nav-label">{label}</span>{page === id && <i />}</a>)}</nav>
      <div className="sidebar-footer"><ThemeToggle theme={theme} onToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />{auth?.required && <button onClick={handleLogout} aria-label={t('signOut')}><LogOut size={15} /></button>}</div>
    </aside>
    {mobileMenu && <button className="menu-backdrop" onClick={() => setMobileMenu(false)} aria-label={t('close')} />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileMenu(true)} aria-label={t('openMenu')}><Menu size={21} /></button><div className="topbar-context"><span>Bakery POS</span><strong>{pageTitle}</strong></div>{page === 'pos' && <button className={`terminal-chip topbar-terminal ${posConfig.configured ? 'ready' : ''}`} onClick={checkPoint} disabled={!posConfig.configured} aria-label={t('pointStatus')} title={posConfig.configured ? t('pointStatus') : t('pointOffline')}><Wifi size={15} /><span className="terminal-dot" /><span className="topbar-terminal-copy"><strong>{posConfig.mockMode ? t('pointDemoMode') : posConfig.configured ? `Point · ${posConfig.terminalLabel}` : t('pointOffline')}</strong><small>{posConfig.mockMode ? t('pointDemoMode') : posConfig.configured ? t('pointStatusReady') : t('pointOffline')}</small></span></button>}<span className="topbar-spacer" /><ThemeToggle theme={theme} onToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} /><LanguageToggle />{['dashboard', 'inventory'].includes(page) && <button className="button primary mobile-add" onClick={() => setModal({ type: 'add' })}><Plus size={20} /><span>{t('add')}</span></button>}<div className="date-chip"><Clock3 size={17} /><span>{formatDate(new Date().toISOString().slice(0, 10))}</span></div></header>
      {loading ? <div className="loading"><div className="loader-mark"><Croissant size={28} /></div><span>{t('preparing')}</span></div> : <Suspense fallback={<div className="loading"><span>{t('preparing')}</span></div>}>
        {page === 'dashboard' && <Dashboard items={items} movements={movements} dailySummary={dailySummary} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onGoInventory={() => setPage('inventory')} onGoPos={() => setPage('pos')} />}
        {page === 'pos' && <SalesCounter items={items} sales={sales} posConfig={posConfig} onRefresh={refresh} setToast={setToast} registerView={route.registerView} onRegisterViewChange={view => router.navigate(sectionHref('pos', { view }))} />}
        {page === 'inventory' && <Inventory items={items} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onEdit={(item) => setModal({ type: 'edit', item })} />}
        {page === 'metrics' && <MetricsPage metrics={metricsData} range={metricsRange} onRangeChange={setMetricsRange} onRefresh={() => loadMetrics(metricsRange)} onOpenClose={() => setModal({ type: 'cash-close' })} onExport={exportDailyReport} loading={metricsLoading} exporting={exportingReport} />}
        {page === 'activity' && <Activity movements={movements} />}
        {page === 'settings' && <MercadoPagoSettings setToast={setToast} />}
        {page === 'not-found' && <section className="page empty-state"><h1>{t('sectionNotFound')}</h1><p>{t('sectionNotFoundDescription')}</p><a className="button primary" href={sectionHref('dashboard')} onClick={event => followSection(event, sectionHref('dashboard'))}>{t('backToOverview')}</a></section>}
      </Suspense>}
    </main>
    <nav className="bottom-nav">{nav.map(({ id, label, icon: Icon }) => <a key={id} href={sectionHref(id)} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} onClick={event => followSection(event, sectionHref(id))}><Icon size={20} /><span>{label}</span></a>)}</nav>
    {modal?.type === 'add' && <Modal title={t('addProduct')} eyebrow={t('inventorySetup')} onClose={() => setModal(null)}><ProductForm onSubmit={addItem} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'edit' && <Modal title={modal.item.name} eyebrow={t('productDetails')} onClose={() => setModal(null)}><ProductForm item={modal.item} onSubmit={(form) => editItem(modal.item, form)} onDelete={() => deleteItem(modal.item)} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'adjust' && <Modal title={modal.item.name} eyebrow={t('updateStock')} onClose={() => setModal(null)}><AdjustForm item={modal.item} onSubmit={(form) => adjustItem(modal.item, form)} onClose={() => setModal(null)} busy={busy} /></Modal>}
    {modal?.type === 'cash-close' && metricsData && <Modal title={t('dayClose')} eyebrow={t('closeSummary')} onClose={() => setModal(null)}><Suspense fallback={<span>{t('preparing')}</span>}><CashCloseForm metrics={metricsData} onSubmit={saveCashClose} onClose={() => setModal(null)} busy={busy} /></Suspense></Modal>}
    {pendingInventoryReview && <RefundInventoryPrompt sale={pendingInventoryReview.sale} refund={pendingInventoryReview.refund} onResolve={resolvePendingRefundInventory} busy={busy} />}
    {toast && <div className={`toast ${toast.type}`} role="status"><div>{toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}</div><span>{toast.message}</span><button onClick={() => setToast(null)} aria-label={t('close')}><X size={16} /></button></div>}
  </div>
}
