import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BarChart3, Boxes, CalendarClock, Check, ChevronRight, CirclePlus, Clock3, Croissant, History, LayoutDashboard, LineChart, LockKeyhole, LogOut, Menu, Minus, Moon, PanelLeftClose, PackageOpen, Pencil, Plus, ReceiptText, Search, ShoppingBasket, Settings, SlidersHorizontal, Sparkles, Sun, Trash2, Undo2, Wifi, X } from 'lucide-react'
import { api } from './api.js'
import { watchUpdates } from './liveUpdates.js'
import { createRouter, isPlainNavigation, parseRoute, sectionHref } from './routes.js'
import { dateOnly, parseCalendarDate } from './dates.js'
import { useI18n } from './i18n.js'
import { categories, CategoryIcon, categoryClass, formatQuantity, Modal, LoadingSkeleton } from './ui.jsx'
import { saveCartDraft, searchText, setWorkspaceUser } from './posWorkspace.js'
import { setCheckoutUser } from './checkoutAttempts.js'
import { Cloud as CloudCheck, CloudOff, Ellipsis, LoaderCircle } from 'lucide-react'

const units = ['pieces', 'loaves', 'cakes', 'kg', 'g', 'litres', 'bottles', 'boxes', 'packs']
const AstryxDeleteDialog = lazy(() => import('./AstryxDeleteDialog.jsx'))
const SalesCounter = lazy(() => import('./SalesCounter.jsx'))
const MetricsPage = lazy(() => import('./MetricsPage.jsx'))
const CashClosurePage = lazy(() => import('./CashClosurePage.jsx'))
const SettingsPage = lazy(() => import('./SettingsPage.jsx'))
const InventoryBatch = lazy(() => import('./InventoryBatch.jsx'))
const UserManagement = lazy(() => import('./UserManagement.jsx'))
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

function LoginScreen({ auth,onLogin,onSetup,onPassword,theme,onThemeToggle }) {
  const { t,language }=useI18n(),tx=(es,en)=>language==='es'?es:en
  const [username,setUsername]=useState('admin'),[name,setName]=useState(''),[password,setPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const setup=auth?.setupRequired,change=auth?.user?.mustChangePassword
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{
    if((setup||change)&&newPassword!==confirm)throw new Error(tx('Las contraseñas no coinciden.','Passwords do not match.'))
    if(setup)await onSetup({username,name,password:newPassword})
    else if(change)await onPassword({currentPassword:password,password:newPassword})
    else await onLogin(username,password)
    setPassword('');setNewPassword('');setConfirm('')
  }catch(e){setError(e.message)}finally{setBusy(false)}}
  return <main className="login-page"><div className="login-language"><ThemeToggle theme={theme} onToggle={onThemeToggle}/><LanguageToggle/></div><section className="login-card">
    <div className="login-mark"><Croissant size={31}/></div><span className="eyebrow">Bakery POS</span><h1>{tx(setup?'Crear administrador':change?'Nueva contraseña':'Ingresar',setup?'Create administrator':change?'New password':'Sign in')}</h1>
    <form onSubmit={submit}>
      {setup&&<label className="field"><span>{tx('Nombre','Name')}</span><input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>}
      {!change&&<label className="field"><span>{tx('Usuario','Username')}</span><input required autoComplete="username" autoCapitalize="none" value={username} onChange={e=>setUsername(e.target.value.toLowerCase())}/></label>}
      {change&&<p className="login-identity">{auth.user.name} · @{auth.user.username}</p>}
      {!setup&&<label className="field"><span>{tx(change?'Contraseña actual o código inicial':'Contraseña',change?'Current password or initial code':'Password')}</span><input required type="password" autoComplete="current-password" maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
      {(setup||change)&&<><label className="field"><span>{tx('Nueva contraseña · mínimo 8 caracteres','New password · 8 characters minimum')}</span><input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label className="field"><span>{tx('Repetir contraseña','Repeat password')}</span><input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label></>}
      {error&&<div className="inline-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
      <button className="button primary" disabled={busy}>{busy?t('saving'):tx(setup?'Crear administrador':change?'Guardar contraseña':'Ingresar',setup?'Create administrator':change?'Save password':'Sign in')}<ArrowRight size={18}/></button>
    </form></section></main>
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
      <label className="switch-field"><input type="checkbox" checked={form.sellable} onChange={(event) => setForm((current) => ({ ...current, sellable: event.target.checked }))} /><i aria-hidden="true" /><span><strong>{t('sellAtCounter')}</strong></span></label>
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
  return <div className="empty-state"><div className="empty-art"><PackageOpen size={32} /></div><h3>{t('emptyInventoryTitle')}</h3><button className="button primary" onClick={onAdd}><Plus size={18} /> {t('addFirstProduct')}</button></div>
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
  return <div className="page enter">
    <div className="page-actions dashboard-actions"><button className="button secondary" onClick={onGoPos}><ShoppingBasket size={19} /> {t('newSale')}</button><button className="button primary" onClick={onAdd}><CirclePlus size={19} /> {t('addProduct')}</button></div>
    <section className="metrics" aria-label={t('inventorySummary')}>
      <div className="metric-card"><div className="metric-icon cocoa"><ReceiptText size={20} /></div><div><span>{t('salesToday')}</span><strong>{formatCurrency(todayRevenue)}</strong><small>{t('transactionsToday', { count: dailySummary?.transactions || 0 })}</small></div></div>
      <div className="metric-card"><div className="metric-icon sage"><BarChart3 size={20} /></div><div><span>{t('unitsOnHand')}</span><strong>{formatQuantity(unitsOnHand)}</strong></div></div>
      <div className={`metric-card ${lowItems.length ? 'attention' : ''}`}><div className="metric-icon amber"><AlertTriangle size={20} /></div><div><span>{t('needAttention')}</span><strong>{lowItems.length}</strong><small>{lowItems.length ? t('atOrBelowMinimum') : t('everythingHealthy')}</small></div></div>
      <div className="metric-card"><div className="metric-icon rose"><CalendarClock size={20} /></div><div><span>{t('expiringSoon')}</span><strong>{expiring.length}</strong><small>{t('next3Days')}</small></div></div>
    </section>
    <section className="dashboard-grid">
      <div className="card stock-card"><header className="card-header"><h2>{t('stockRequiringAttention')}</h2><button className="text-button" onClick={onGoInventory}>{t('viewAll')} <ChevronRight size={17} /></button></header>
        {lowItems.length ? <div className="attention-list">{lowItems.slice(0, 5).map((item) => <button key={item.id} onClick={() => onAdjust(item)}><div className={`product-glyph category-${categoryClass(item.category)}`}><CategoryIcon category={item.category} size={19} /></div><div className="attention-copy"><strong>{item.name}</strong><span>{categoryLabel(item.category)} · {t('minimum')} {formatQuantity(item.lowStockThreshold)}</span></div><div className="attention-count"><strong>{formatQuantity(item.quantity)}</strong><span>{unitLabel(item.unit)}</span></div><ChevronRight size={18} /></button>)}</div> : <div className="all-good"><div><Sparkles size={24} /></div><h3>{t('everythingStocked')}</h3></div>}
      </div>
      <div className="card category-card"><header className="card-header"><h2>{t('productsByCategory')}</h2></header>
        {categoriesData.length ? <div className="category-bars">{categoriesData.slice(0, 6).map(([category, count], index) => <div className="category-bar" key={category}><div><span>{categoryLabel(category)}</span><strong>{count}</strong></div><div className="bar-track"><i style={{ width: `${(count / maxCategory) * 100}%`, '--delay': `${index * 60}ms` }} /></div></div>)}</div> : <p className="muted">{t('categoriesEmpty')}</p>}
      </div>
      <div className="card activity-card"><header className="card-header"><h2>{t('recentActivity')}</h2></header>
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

function Inventory({ items, onAdd, onAdjust, onEdit, onBatch }) {
  const { t, categoryLabel } = useI18n()
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('All'), [category, setCategory] = useState('All')
  const filtered = items.filter(item => searchText(`${item.name} ${item.sku}`).includes(searchText(search)) &&
    (category === 'All' || item.category === category) && (filter === 'All' || filter === 'Low' && item.quantity <= item.lowStockThreshold || filter === 'Out' && item.quantity === 0))
  return <div className="page enter"><div className="page-actions"><button className="button secondary" onClick={onBatch}><Boxes size={18} />{t('batchInventory')}</button><button className="button primary desktop-action" onClick={onAdd}><Plus size={19} />{t('addProduct')}</button></div>
    <div className="toolbar inventory-toolbar"><label className="search-box"><Search size={18} /><input aria-label={t('searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchPlaceholder')} />{search && <button onClick={() => setSearch('')} aria-label={t('clearSearch')}><X size={16} /></button>}</label><select value={category} onChange={e => setCategory(e.target.value)} aria-label={t('category')}><option value="All">{t('allCategories')}</option>{categories.filter(c => items.some(i => i.category === c)).map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select><div className="filter-scroll" role="group" aria-label={t('status')}>{[['All','all',items.length],['Low','lowMinimum',items.filter(i => i.quantity <= i.lowStockThreshold).length],['Out','soldOutFilter',items.filter(i => i.quantity === 0).length]].map(([key,label,count]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{t(label)}<span>{count}</span></button>)}</div></div>
    <section className="card inventory-card">{items.length === 0 ? <EmptyState onAdd={onAdd} /> : filtered.length ? <InventoryList items={filtered} onAdjust={onAdjust} onEdit={onEdit} /> : <div className="empty-state compact"><Search size={27} /><h3>{t('noProductsFound')}</h3></div>}</section>
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
    <section className="card history-card" aria-label={t('stockMovementHistory')}>{movements.length ? Object.entries(grouped).map(([day, entries]) => <div className="history-group" key={day}><h2>{new Date(day).toDateString() === new Date().toDateString() ? t('today') : formatDate(new Date(day))}</h2><div>{entries.map((movement) => <Movement movement={movement} key={movement.id} />)}</div></div>) : <div className="empty-state compact"><History size={30} /><h2>{t('noActivity')}</h2></div>}</section>
  </div>
}

export default function App() {
  const { t, formatDate, formatTime, language } = useI18n()
  const routeUrl = useSyncExternalStore(router.subscribe, router.getSnapshot)
  const route = useMemo(() => parseRoute(routeUrl), [routeUrl])
  const page = route.page
  const isCounterPage = page === 'pos' && route.registerView !== 'close'
  const setPage = page => router.navigate(sectionHref(page))
  const [items, setItems] = useState([])
  const [movements, setMovements] = useState([])
  const [sales, setSales] = useState([])
  const [dailySummary, setDailySummary] = useState(null)
  const [registerSession,setRegisterSession]=useState(null),[registerSessions,setRegisterSessions]=useState([])
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
  const [toast, setToastState] = useState(null), [issue, setIssue] = useState(null)
  const setToast = useCallback(next => { if (next?.type === 'error' || next?.type === 'warning') setIssue(next); else setToastState(next) }, [])
  const [syncing, setSyncing] = useState(false), [syncError, setSyncError] = useState(''), [lastSync, setLastSync] = useState(null)
  const [pointStatus, setPointStatus] = useState('unchecked')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('bakery-sidebar') !== 'expanded')
  const [theme, setTheme] = useState(() => window.localStorage.getItem('bakery-theme') === 'dark' ? 'dark' : 'light')
  const brandLogoRef = useRef(null)
  const refreshSequence = useRef(0)
  const metricsRequest = useRef(null)
  useEffect(() => { if (route.canonical) router.navigate(route.canonical, { replace: true }) }, [route.canonical])
  useLayoutEffect(() => {
    if (auth?.authenticated && isCounterPage) window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [auth?.authenticated, isCounterPage])
  useEffect(() => { setModal(null); setMobileMenu(false) }, [routeUrl])
  useEffect(() => {
    if (!mobileMenu) return
    const close = e => { if (e.key === 'Escape') setMobileMenu(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [mobileMenu])
  const pendingInventoryReview = useMemo(() => {
    if(auth?.user?.role!=='admin')return null
    for (const sale of sales) {
      const refund = sale.refunds?.find((entry) => entry.status === 'processed' && entry.inventoryReviewStatus === 'pending')
      if (refund) return { sale, refund }
    }
    return null
  }, [sales,auth?.user?.role])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('bakery-theme', theme)
  }, [theme])
  useEffect(() => {
    window.localStorage.setItem('bakery-sidebar', sidebarCollapsed ? 'collapsed' : 'expanded')
  }, [sidebarCollapsed])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    setSyncing(true)
    try {
      const next = await api.bootstrap()
      if (sequence !== refreshSequence.current) return
      setAuth(next.auth); setSyncError(''); setLastSync(Date.now())
      if (!next.auth.authenticated || next.auth.user.mustChangePassword) return
      setCheckoutUser(next.auth.user.id,next.auth.user.role==='admin');setWorkspaceUser(next.auth.user.id)
      setRegisterSession(next.registerSession);setRegisterSessions(next.registerSessions||[])
      setItems(next.items); setMovements(next.movements); setSales(next.sales); setPosConfig(next.posConfig); setDailySummary(next.dailySummary)
    } catch (error) {
      if (sequence === refreshSequence.current) setSyncError(error.message)
      throw error
    } finally { if (sequence === refreshSequence.current) setSyncing(false) }
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
    refresh().catch(() => {}).finally(() => { if (active) setLoading(false) })
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
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToastState(null), 4200); return () => clearTimeout(id) }, [toast])
  useEffect(() => {
    const offline = () => setSyncError(t('serverOffline'))
    const online = () => refresh().catch(() => {})
    window.addEventListener('offline', offline); window.addEventListener('online', online)
    return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online) }
  }, [refresh, t])

  const handleLogin = async (username,password) => {
    const status = await api.login(username,password)
    setAuth(status); setLoading(true)
    try { await refresh() } finally { setLoading(false) }
  }
  const handleSetup=async body=>{setAuth(await api.setupAdmin(body));await refresh()}
  const handlePassword=async body=>{setAuth(await api.changePassword(body));await refresh()}
  const handleLogout = async () => {
    refreshSequence.current += 1
    metricsRequest.current?.abort()
    await api.logout()
    refreshSequence.current += 1
    saveCartDraft([]);setCheckoutUser(null);setWorkspaceUser(null);setRegisterSession(null);setRegisterSessions([]); setIssue(null); setToastState(null)
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
    setPointStatus('checking')
    try {
      const terminal = await api.terminal()
      const ready = terminal.ready ?? terminal.connected
      setPointStatus(ready ? 'ready' : 'error')
      setToast({ type: ready ? 'success' : 'error', message: ready ? t('pointReady', { id: terminal.label || '' }) : t('pointNeedsPdv') })
    } catch (error) { setPointStatus('error'); setToast({ type: 'error', message: error.message }) }
  }
  useEffect(() => { setPointStatus('unchecked') }, [posConfig.configured, posConfig.terminalLabel])
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
  const exportDailyReport = async () => {
    setExportingReport(true)
    try {
      const link = document.createElement('a')
      link.href = api.dailyReportUrl(language); link.download = ''; document.body.appendChild(link); link.click(); link.remove()
      setToast({ type: 'success', message: t('reportExported') })
    } catch (error) { setToast({ type: 'error', message: error.message }) }
    finally { setExportingReport(false) }
  }
  const allNav = [
    { id: 'dashboard', label: t('overview'), icon: LayoutDashboard },
    { id: 'pos', label: t('registerTitle'), icon: ShoppingBasket },
    { id: 'inventory', label: t('inventory'), icon: Boxes },
    { id: 'metrics', label: t('metricsNav'), icon: LineChart },
    { id: 'activity', label: t('activity'), icon: History },
    { id: 'settings', label: t('settings'), icon: Settings },
    { id:'users',label:language==='es'?'Usuarios':'Users',icon:LockKeyhole },
  ]
  const isAdmin=auth?.user?.role==='admin'
  const nav=isAdmin?allNav:allNav.filter(n=>n.id==='pos')
  const blockedPage=auth?.authenticated&&!isAdmin&&page!=='pos'
  useEffect(()=>{if(blockedPage&&!auth?.user?.mustChangePassword)router.navigate('/caja',{replace:true})},[blockedPage,auth?.user?.mustChangePassword])
  const pageTitle = nav.find((entry) => entry.id === page)?.label || t('sectionNotFound')
  useEffect(() => { document.title = `${pageTitle} · Bakery POS` }, [pageTitle])
  const followSection = (event, href) => {
    if (isPlainNavigation(event)) { event.preventDefault(); router.navigate(href); setMobileMenu(false) }
  }

  if (!auth) return <main><LoadingSkeleton full />{syncError && <div className="startup-error" role="alert"><AlertTriangle size={18} /><p>{t('serverFailed')}</p><button className="button primary" disabled={syncing} onClick={() => refresh().catch(() => {})}>{t('serverRetry')}</button></div>}</main>
  if (auth?.required && (!auth.authenticated||auth.user?.mustChangePassword)) return <LoginScreen auth={auth} onSetup={handleSetup} onPassword={handlePassword} onLogin={handleLogin} theme={theme} onThemeToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />

  if(blockedPage)return <LoadingSkeleton/>
  const closureSessionId=route.registerSessionId||(!isAdmin?(registerSession?.id||registerSessions[0]?.id||'none'):null)
  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${isCounterPage ? 'is-caja' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><button ref={brandLogoRef} className="brand-logo" onClick={toggleSidebar} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')} title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}><span className="brand-mark"><Croissant size={24} /></span></button><span className="brand-copy"><strong>Bakery POS</strong></span><button className="sidebar-toggle" onClick={toggleSidebar} aria-label={t('collapseSidebar')} title={t('collapseSidebar')}><PanelLeftClose size={17} /></button></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <a key={id} href={sectionHref(id)} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} title={sidebarCollapsed ? label : undefined} onClick={event => followSection(event, sectionHref(id))}><Icon size={20} /><span className="nav-label">{label}</span>{page === id && <i />}</a>)}</nav>
      <div className="sidebar-footer"><div className="drawer-language"><LanguageToggle /></div><ThemeToggle theme={theme} onToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />{auth?.required && <button onClick={handleLogout} aria-label={t('signOut')}><LogOut size={15} /></button>}</div>
    </aside>
    {mobileMenu && <button className="menu-backdrop" onClick={() => setMobileMenu(false)} aria-label={t('close')} />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileMenu(true)} aria-label={t('openMenu')}><Menu size={21} /></button><div className="topbar-context">{!isAdmin&&<span>{auth.user.name}</span>}<h1>{pageTitle}</h1></div><span className="topbar-spacer" />
        <button className={`server-chip ${syncError ? 'offline' : ''}`} onClick={() => refresh().catch(() => {})} disabled={syncing} aria-label={`${t('server')}: ${t(syncError ? 'serverOffline' : syncing ? 'serverSyncing' : 'serverReady')}`} title={`${t('server')} · ${lastSync ? t('syncAt', { time: formatTime(lastSync) }) : t('serverSyncing')}`}>{syncing ? <LoaderCircle size={17} className="spin" /> : syncError ? <CloudOff size={17} /> : <CloudCheck size={17} />}<span>{t(syncError ? 'serverOffline' : syncing ? 'serverSyncing' : 'serverReady')}</span></button>
        {page === 'pos' && <button className={`terminal-chip topbar-terminal ${pointStatus === 'ready' ? 'ready' : ''}`} onClick={checkPoint} disabled={!posConfig.configured || pointStatus === 'checking'} aria-label={`${t('pointStatus')}: ${t(pointStatus === 'ready' ? 'readyToCharge' : pointStatus === 'error' ? 'pointCheckFailed' : pointStatus === 'checking' ? 'pointChecking' : 'pointUnchecked')}`} title={posConfig.configured ? t('pointStatus') : t('pointOffline')}><Wifi size={15} /><span className="terminal-dot" /><span className="topbar-terminal-copy"><strong>{posConfig.mockMode ? t('pointDemoMode') : 'Point'}</strong><small>{t(!posConfig.configured ? 'pointOffline' : pointStatus === 'ready' ? 'readyToCharge' : pointStatus === 'error' ? 'pointCheckFailed' : pointStatus === 'checking' ? 'pointChecking' : 'pointUnchecked')}</small></span></button>}
        <span className="signed-user">{auth.user.name}<small>{isAdmin?'Admin':language==='es'?'Cajero':'Cashier'}</small></span><button className="icon-button topbar-logout" onClick={handleLogout} aria-label={t('signOut')} title={t('signOut')}><LogOut size={17}/></button><ThemeToggle theme={theme} onToggle={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} /><div className="topbar-language"><LanguageToggle /></div>{isAdmin&&['dashboard','inventory'].includes(page) && <button className="button primary mobile-add" onClick={() => setModal({ type: 'add' })}><Plus size={20} /><span>{t('add')}</span></button>}<div className="date-chip"><Clock3 size={17} /><span>{formatDate(new Date().toLocaleDateString('en-CA'))}</span></div></header>
      {syncError && <div className="connection-banner" role="alert"><CloudOff size={17} /><span>{t('serverFailed')}</span><button disabled={syncing} onClick={() => refresh().catch(() => {})}>{t('serverRetry')}</button></div>}
      {issue && <div className={`operation-banner ${issue.type}`} role="alert"><AlertTriangle size={17} /><span>{issue.message}</span><button onClick={() => setIssue(null)} aria-label={t('close')}><X size={18} /></button></div>}
      {loading ? <LoadingSkeleton /> : <Suspense fallback={<LoadingSkeleton />}>
        {page === 'dashboard' && <Dashboard items={items} movements={movements} dailySummary={dailySummary} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onGoInventory={() => setPage('inventory')} onGoPos={() => setPage('pos')} />}
        {page === 'pos' && route.registerView === 'close' && <CashClosurePage user={auth.user} sessionId={closureSessionId} sessions={registerSessions} onSessionChange={id=>router.navigate(id?'/caja/cierre?sesion='+id:'/caja/cierre')} refreshToken={sales} date={route.closureDate} onClosed={refresh} onNavigate={href => router.navigate(href)} setToast={setToast} />}
        {page === 'pos' && route.registerView !== 'close' && <SalesCounter user={auth.user} registerSession={registerSession} onOpenRegister={async amount=>{await api.openRegister(amount);await refresh()}} serverAvailable={!syncError} items={items} sales={sales} posConfig={posConfig} onRefresh={refresh} setToast={setToast} onNavigate={href => router.navigate(href)} registerView={route.registerView} onRegisterViewChange={view => router.navigate(sectionHref('pos', { view }))} />}
        {page === 'inventory' && <Inventory items={items} onBatch={() => setModal({ type: 'batch' })} onAdd={() => setModal({ type: 'add' })} onAdjust={(item) => setModal({ type: 'adjust', item })} onEdit={(item) => setModal({ type: 'edit', item })} />}
        {page === 'metrics' && <MetricsPage metrics={metricsData} range={metricsRange} onRangeChange={setMetricsRange} onRefresh={() => loadMetrics(metricsRange)} onExport={exportDailyReport} loading={metricsLoading} exporting={exportingReport} />}
        {page === 'activity' && <Activity movements={movements} />}
        {page==='users'&&isAdmin&&<UserManagement currentUser={auth.user} setToast={setToast}/>}
        {page === 'settings' && <SettingsPage tab={route.settingsTab} onNavigate={href => router.navigate(href)} setToast={setToast} />}
        {page === 'not-found' && <section className="page empty-state"><h1>{t('sectionNotFound')}</h1><p>{t('sectionNotFoundDescription')}</p><a className="button primary" href={sectionHref('dashboard')} onClick={event => followSection(event, sectionHref('dashboard'))}>{t('backToOverview')}</a></section>}
      </Suspense>}
    </main>
    <nav className={`bottom-nav ${isAdmin?'':'cashier-nav'}`} aria-label={t('openMenu')}>{nav.slice(0,3).map(({ id, label, icon: Icon }) => <a key={id} href={sectionHref(id)} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''} onClick={event => followSection(event, sectionHref(id))}><Icon size={21} /><span>{label}</span></a>)}{isAdmin&&<button className={nav.slice(3).some(n => n.id === page) || mobileMenu ? 'active' : ''} onClick={() => setMobileMenu(v => !v)} aria-expanded={mobileMenu}><Ellipsis size={23} /><span>{t('more')}</span></button>}{!isAdmin&&<button onClick={handleLogout}><LogOut size={20}/><span>{language==='es'?'Salir':'Sign out'}</span></button>}</nav>
    {modal?.type === 'batch' && <Modal title={t('batchInventory')} onClose={() => setModal(null)} wide><Suspense fallback={<LoadingSkeleton />}><InventoryBatch items={items} onClose={() => setModal(null)} onSaved={async () => { await refresh(); setModal(null); setToast({ type: 'success', message: t('batchSaved') }) }} /></Suspense></Modal>}
    {modal?.type === 'add' && <Modal title={t('addProduct')} onClose={() => setModal(null)}><ProductForm onSubmit={addItem} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'edit' && <Modal title={modal.item.name} eyebrow={t('productDetails')} onClose={() => setModal(null)}><ProductForm item={modal.item} onSubmit={(form) => editItem(modal.item, form)} onDelete={() => deleteItem(modal.item)} onClose={() => setModal(null)} busy={busy} theme={theme} /></Modal>}
    {modal?.type === 'adjust' && <Modal title={modal.item.name} eyebrow={t('updateStock')} onClose={() => setModal(null)}><AdjustForm item={modal.item} onSubmit={(form) => adjustItem(modal.item, form)} onClose={() => setModal(null)} busy={busy} /></Modal>}
    {pendingInventoryReview && <RefundInventoryPrompt sale={pendingInventoryReview.sale} refund={pendingInventoryReview.refund} onResolve={resolvePendingRefundInventory} busy={busy} />}
    {toast && <div className={`toast ${toast.type}`} role="status"><div>{toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}</div><span>{toast.message}</span><button onClick={() => setToast(null)} aria-label={t('close')}><X size={16} /></button></div>}
  </div>
}
