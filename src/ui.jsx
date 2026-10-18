import { useEffect } from 'react'
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

export function Modal({ title, eyebrow, onClose, children, wide = false, closeable = true }) {
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
