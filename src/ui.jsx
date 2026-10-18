import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CakeSlice, Coffee, Croissant, PackageOpen, Sparkles, Wheat, X } from 'lucide-react'
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

export function LoadingSkeleton({ full = false }) {
  const { t } = useI18n()
  return <div className={`page section-skeleton ${full ? 'skeleton-full' : ''}`} role="status" aria-label={t('loadingSection')}><span className="sr-only">{t('loadingSection')}</span><i className="skeleton-heading" /><div className="skeleton-cards">{[0,1,2].map(n => <i key={n} />)}</div>{[0,1,2,3].map(n => <i key={n} />)}</div>
}

export function Modal({ title, eyebrow, onClose, children, wide = false, closeable = true }) {
  const { t } = useI18n()
  const dialogRef = useRef(null), titleId = useId()
  useEffect(() => {
    const previous = document.activeElement
    if (!dialogRef.current?.contains(previous)) dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const onKey = (event) => {
      const top = [...document.querySelectorAll('.modal')].at(-1)
      if (top !== dialogRef.current || document.querySelector('dialog[open]')) return
      if (event.key === 'Escape' && closeable) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const focusable = [...top.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length)
        const first = focusable[0], last = focusable.at(-1)
        if (!first) { event.preventDefault(); top.focus() }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === top)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === top)) { event.preventDefault(); first.focus() }
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
    <section ref={dialogRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-handle" />
      <header className="modal-header">
        <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div>
        {closeable && <button className="icon-button" onClick={onClose} aria-label={t('close')}><X size={20} /></button>}
      </header>
      {children}
    </section>
  </div>, document.body)
}
