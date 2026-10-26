import { Calculator, ShoppingBasket, Banknote } from 'lucide-react'
import { useI18n } from './i18n.js'
import { isPlainNavigation, sectionHref } from './routes.js'

export default function CajaHeader({ active = 'counter', onNavigate }) {
  const { language, t } = useI18n()
  return <section className="page-heading pos-heading caja-heading">
    <nav className="caja-sections" aria-label={language === 'es' ? 'Secciones de caja' : 'Register sections'}>
      {[["counter", 'cart', ShoppingBasket, t('registerTitle')], ['cash','cash',Banknote,language==='es'?'Retiros':'Cash out'], ['close', 'close', Calculator, language === 'es' ? 'Cierre de caja' : 'Cash close']].map(([id, view, Icon, label]) => {
        const href = sectionHref('pos', { view })
        return <a key={id} href={href} aria-current={active === id ? 'page' : undefined} onClick={event => {
          if (isPlainNavigation(event)) { event.preventDefault(); onNavigate(href) }
        }}><Icon size={16} />{label}</a>
      })}
    </nav>
  </section>
}
