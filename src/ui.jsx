import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CakeSlice, ChevronLeft, ChevronRight, Coffee, Croissant, PackageOpen, Sparkles, Wheat, X } from 'lucide-react'
import { useI18n } from './i18n.js'

const categoryIcons = { Bread: Wheat, Pastries: Croissant, Cakes: CakeSlice, Ingredients: Wheat, Packaging: PackageOpen, Drinks: Coffee, Other: Sparkles }
const quantityFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
export const categories = ['Bread', 'Pastries', 'Cakes', 'Ingredients', 'Packaging', 'Drinks', 'Other']
let openModalCount = 0

export function categoryClass(category = '') {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function CategoryIcon({ category, size = 20, className = '' }) {
  const Icon = categoryIcons[category] || Sparkles
  return <Icon className={className} size={size} aria-hidden="true" />
}

export function formatQuantity(value) {
  return quantityFormatter.format(Number(value))
}

export function NumberedPagination({ label, current, total, onPageChange }) {
  const { t } = useI18n()
  if (total <= 1) return null
  const start = Math.max(1, Math.min(current - 2, total - 4))
  const pages = Array.from({ length: Math.min(total, 5) }, (_, index) => start + index)
  return <nav className="numbered-pagination" aria-label={label}>
    <button type="button" aria-label={t('previousPage')} disabled={current === 1} onClick={() => onPageChange(current - 1)}>
      <ChevronLeft size={18} aria-hidden="true" />
    </button>
    {start > 1 && <span aria-hidden="true">…</span>}
    {pages.map(page => <button type="button" key={page} aria-label={t('pageNumber', { page })}
      aria-current={page === current ? 'page' : undefined} onClick={() => onPageChange(page)}>{page}</button>)}
    {pages.at(-1) < total && <span aria-hidden="true">…</span>}
    <button type="button" aria-label={t('nextPage')} disabled={current === total} onClick={() => onPageChange(current + 1)}>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  </nav>
}

export function LoadingSkeleton({ full = false }) {
  const { t } = useI18n()
  return <div className={`page section-skeleton ${full ? 'skeleton-full' : ''}`} role="status" aria-label={t('loadingSection')}><span className="sr-only">{t('loadingSection')}</span><i className="skeleton-heading" /><div className="skeleton-cards">{[0,1,2].map(n => <i key={n} />)}</div>{[0,1,2,3].map(n => <i key={n} />)}</div>
}

export function Modal({ title, eyebrow, onClose, children, wide = false, closeable = true, role = 'dialog', describedBy, initialFocusRef }) {
  const { t } = useI18n()
  const dialogRef = useRef(null), titleId = useId()
  useEffect(() => {
    const previous = document.activeElement
    if (!dialogRef.current?.contains(previous)) {
      const target = initialFocusRef?.current || dialogRef.current
      target?.focus()
    }
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [initialFocusRef])
  useEffect(() => {
    const onKey = (event) => {
      const top = [...document.querySelectorAll('.modal')].at(-1)
      if (top !== dialogRef.current) return
      if (event.key === 'Escape' && closeable) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const focusable = [...top.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length)
        const first = focusable[0], last = focusable.at(-1)
        const active = document.activeElement
        const atBoundary = active === top || !top.contains(active)
        if (!first) { event.preventDefault(); top.focus() }
        else if (event.shiftKey && (active === first || atBoundary)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (active === last || atBoundary)) { event.preventDefault(); first.focus() }
      }
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
    <section ref={dialogRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy}>
      <div className="modal-handle" />
      <header className="modal-header">
        <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div>
        {closeable && <button className="icon-button" onClick={onClose} aria-label={t('close')}><X size={20} /></button>}
      </header>
      {children}
    </section>
  </div>, document.body)
}
