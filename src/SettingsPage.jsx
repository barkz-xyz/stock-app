import { lazy, Suspense } from 'react'
import { KeyRound, Wifi } from 'lucide-react'
import { useI18n } from './i18n.js'
import { isPlainNavigation } from './routes.js'
import { LoadingSkeleton } from './ui.jsx'

const MercadoPagoSettings = lazy(() => import('./MercadoPagoSettings.jsx'))
const InventoryApiSettings = lazy(() => import('./InventoryApiSettings.jsx'))

export default function SettingsPage({ tab, onNavigate, setToast }) {
  const { language } = useI18n()
  const apiTab = tab === 'inventory-api'
  const tabs = [
    { id: 'point', href: '/configuracion', label: 'Point', icon: Wifi },
    { id: 'inventory-api', href: '/configuracion?tab=inventory-api', label: language === 'es' ? 'API de stock' : 'Inventory API', icon: KeyRound },
  ]
  return <div className="page settings-workspace">
    <nav className="settings-tabs" aria-label={language === 'es' ? 'Configuración' : 'Settings'}>{tabs.map(({ id, href, label, icon: Icon }) => <a key={id} href={href} className={(apiTab ? id === 'inventory-api' : id === 'point') ? 'active' : ''} aria-current={(apiTab ? id === 'inventory-api' : id === 'point') ? 'page' : undefined} onClick={event => { if (isPlainNavigation(event)) { event.preventDefault(); onNavigate(href) } }}><Icon size={17}/>{label}</a>)}</nav>
    <Suspense fallback={<LoadingSkeleton/>}>{apiTab ? <InventoryApiSettings setToast={setToast}/> : <MercadoPagoSettings setToast={setToast}/>}</Suspense>
  </div>
}
