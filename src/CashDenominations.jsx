import { useI18n } from './i18n.js'
import { cashDenominations, cashCountText } from './cashCount.js'

export default function CashDenominations({ values, onChange, disabled = false }) {
  const { language, formatCurrency: money } = useI18n()
  return <div className="closure-denominations">{cashDenominations.map(value => <label key={value}>
    <span>{money(value)}</span><input type="text" inputMode="numeric" pattern="[0-9]{1,6}|1000000" maxLength={7}
      aria-label={`${language === 'es' ? 'Cantidad de' : 'Number of'} ${money(value)}`} placeholder="0" disabled={disabled}
      value={cashCountText(values?.[value]) ?? ''} onFocus={event => event.currentTarget.select()}
      onChange={event => { const count = cashCountText(event.target.value); if (count !== null) onChange({ ...values, [value]: count }) }} />
  </label>)}</div>
}
