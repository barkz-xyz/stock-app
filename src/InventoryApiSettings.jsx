import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Ban, Check, Copy, KeyRound, Plus, RotateCw, ShieldCheck, Trash2 } from 'lucide-react'
import { api } from './api.js'
import { copyText } from './copyText.js'
import { useI18n } from './i18n.js'
import { LoadingSkeleton, Modal } from './ui.jsx'
import StockReservations from './StockReservations.jsx'

export default function InventoryApiSettings({ setToast }) {
  const { language } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [days, setDays] = useState(90)
  const [issued, setIssued] = useState(null), [copied, setCopied] = useState(false), [secretError, setSecretError] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [newReservationAccess, setNewReservationAccess] = useState(false)
  const secretField = useRef(null)
  const load = useCallback(async () => {
    try { setData(await api.integrationClients()); setError('') } catch (next) { setError(next.message) }
  }, [])
  useEffect(() => { load() }, [load])
  const formatDate = value => new Date(value).toLocaleDateString(language === 'es' ? 'es-CL' : 'en-GB')
  const selectSecret = () => { secretField.current?.focus(); secretField.current?.select() }
  const copy = async (value, secret = false) => {
    const success = await copyText(value, secret ? { field: secretField.current } : undefined)
    if (secret) {
      setCopied(success)
      setSecretError(success ? '' : tx('Texto seleccionado. Usa Ctrl+C, ⌘C o mantén pulsado para copiar.', 'Text selected. Use Ctrl+C, ⌘C or touch and hold to copy.'))
    } else if (success) setToast({ type: 'success', message: tx('Copiado', 'Copied') })
    else setError(tx('No se pudo copiar. Selecciona y copia el texto.', 'Copy failed. Select and copy the text.'))
  }
  const issue = async (event, client) => {
    event?.preventDefault()
    setBusy(true); setError('')
    try {
      const result = client ? await api.rotateIntegrationKey(client.id, { expiresInDays: 90 }) : await api.createIntegrationClient({ name, expiresInDays: days, reservationsEnabled: newReservationAccess })
      setCreating(false); setConfirmation(null); setName(''); setCopied(false); setSecretError('')
      setIssued({ ...result, name: client?.name || result.client.name, renewed: Boolean(client?.keys.some(key => !key.revokedAt && Date.parse(key.expiresAt) > Date.now())) })
      await load()
    } catch (next) { setError(next.message) } finally { setBusy(false) }
  }
  const confirmAction = async () => {
    const { action, client, key } = confirmation
    if (action === 'renew') return issue(null, client)
    setBusy(true); setError('')
    try {
      if (action === 'permissions') await api.setIntegrationReservations(client.id, !client.scopes.includes('inventory:reserve'))
      else if (action === 'revoke') await api.revokeIntegrationKey(client.id, key.id)
      else if (key) await api.deleteIntegrationKey(client.id, key.id)
      else await api.deleteIntegrationClient(client.id)
      setConfirmation(null); await load()
      setToast({ type: 'success', message: action === 'permissions' ? tx('Permisos actualizados', 'Permissions updated') : action === 'revoke' ? tx('Clave revocada', 'Key revoked') : key ? tx('Clave eliminada', 'Key deleted') : tx('Integración eliminada', 'Integration deleted') })
    } catch (next) { setError(next.message) } finally { setBusy(false) }
  }
  const ask = (action, client, key) => { setError(''); setConfirmation({ action, client, key }) }
  return <div className="inventory-api-settings">
    <div className="page-actions">
      <button className="button primary compact" disabled={busy || !data} onClick={() => { setError(''); setNewReservationAccess(false); setCreating(true) }}><Plus size={16}/>{tx('Crear integración', 'Create integration')}</button>
      <button className="icon-button" onClick={load} disabled={busy} aria-label={tx('Actualizar', 'Refresh')}><RotateCw size={17}/></button>
    </div>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {!data ? <LoadingSkeleton/> : <>
      <section className="card integration-summary">
        <div><ShieldCheck size={21}/><strong>{tx(data.reservationsEnabled ? 'Lectura y reservas' : 'Solo lectura', data.reservationsEnabled ? 'Inventory and reservations' : 'Read only')}</strong><span className={`status-pill ${data.enabled ? 'success' : 'neutral'}`}>{tx(data.enabled ? 'Activa' : 'Desactivada', data.enabled ? 'Enabled' : 'Disabled')}</span></div>
        <small>{tx(data.environment === 'production' ? 'Producción' : 'Pruebas', data.environment === 'production' ? 'Production' : 'Test')} · {data.limits.perMinute} {tx('consultas/min por integración', 'requests/min per integration')}</small>
        <div className="integration-endpoint"><code>GET {data.endpoint}</code><button className="icon-button" aria-label={tx('Copiar URL', 'Copy URL')} onClick={() => copy(new URL(data.endpoint, window.location.origin).href)}><Copy size={16}/></button></div>
        {!data.enabled && <p>{tx('La consulta externa está desactivada en este servidor.', 'External requests are disabled on this server.')}</p>}
      </section>
      {data.clients.length === 0 ? <section className="card integration-empty"><KeyRound size={28}/><strong>{tx('Sin integraciones', 'No integrations')}</strong><span>{tx('Crea una clave para conectar otra app.', 'Create a key to connect another app.')}</span></section> : data.clients.map(client => {
        const active = client.keys.filter(key => !key.revokedAt && Date.parse(key.expiresAt) > Date.now())
        return <section className="card integration-client" key={client.id}>
          <header className="card-header">
            <div><h2>{client.name}</h2><small>{tx(client.scopes.includes('inventory:reserve') ? 'Lectura y reservas' : 'Solo lectura', client.scopes.includes('inventory:reserve') ? 'Inventory and reservations' : 'Read only')}</small></div>
            <div className="integration-actions">
              {data.reservationsSupported && <button className="text-button" disabled={busy} onClick={() => ask('permissions', client)}>{tx(client.scopes.includes('inventory:reserve') ? 'Desactivar reservas' : 'Permitir reservas', client.scopes.includes('inventory:reserve') ? 'Disable reservations' : 'Allow reservations')}</button>}
              <button className="button secondary compact" disabled={busy || active.length >= 2} onClick={() => active.length ? ask('renew', client) : issue(null, client)} title={active.length >= 2 ? tx('Revoca o elimina una clave antes de renovarla.', 'Revoke or delete a key before renewing it.') : undefined}>
                {active.length ? <RotateCw size={15}/> : <KeyRound size={15}/>}{tx(active.length ? 'Renovar clave' : 'Generar clave', active.length ? 'Renew key' : 'Generate key')}
              </button>
              <button className="icon-button subtle danger" disabled={busy} aria-label={`${tx('Eliminar integración', 'Delete integration')} ${client.name}`} onClick={() => ask('delete', client)}><Trash2 size={16}/></button>
            </div>
          </header>
          <div className="integration-keys">{client.keys.length === 0 ? <p className="integration-no-keys">{tx('Sin claves. Genera una para conectar tu app.', 'No keys. Generate one to connect your app.')}</p> : client.keys.map(key => {
            const revoked = Boolean(key.revokedAt), expired = Date.parse(key.expiresAt) <= Date.now()
            return <article className="integration-key" key={key.id}>
              <KeyRound size={18}/><div><code>{key.prefix}…</code><small>{tx('Vence', 'Expires')} {formatDate(key.expiresAt)}{key.lastUsedAt ? ` · ${tx('Último uso', 'Last used')} ${formatDate(key.lastUsedAt)}` : ''}</small></div>
              <span className={`status-pill ${revoked || expired ? 'neutral' : 'success'}`}>{revoked ? tx('Revocada', 'Revoked') : expired ? tx('Vencida', 'Expired') : tx('Activa', 'Active')}</span>
              <div className="integration-actions">
                {!revoked && !expired && <button className="icon-button subtle" disabled={busy} aria-label={`${tx('Revocar clave', 'Revoke key')} ${key.prefix}`} title={tx('Desactivar sin borrar', 'Disable without deleting')} onClick={() => ask('revoke', client, key)}><Ban size={16}/></button>}
                <button className="icon-button subtle danger" disabled={busy} aria-label={`${tx('Eliminar clave', 'Delete key')} ${key.prefix}`} onClick={() => ask('delete', client, key)}><Trash2 size={16}/></button>
              </div>
            </article>
          })}</div>
        </section>
      })}
      {data.reservationsSupported && <StockReservations setToast={setToast}/>}
    </>}
    {creating && <Modal title={tx('Crear integración', 'Create integration')} onClose={() => !busy && setCreating(false)} closeable={!busy}>
      <form className="form-stack" onSubmit={event => issue(event)}>
        <label className="field"><span>{tx('Nombre', 'Name')}</span><input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={tx('Tienda online', 'Online store')}/></label>
        <label className="field"><span>{tx('Vigencia de la clave', 'Key lifetime')}</span><select value={days} onChange={event => setDays(Number(event.target.value))}>{[7, 30, 90, 365].map(value => <option value={value} key={value}>{value} {tx('días', 'days')}</option>)}</select></label>
        {data.reservationsSupported && <label className="reservation-checkbox"><input type="checkbox" checked={newReservationAccess} onChange={event => setNewReservationAccess(event.target.checked)}/>{tx('Permitir reservas y confirmación de stock', 'Allow stock reservations and confirmation')}</label>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setCreating(false)}>{tx('Cancelar', 'Cancel')}</button><button className="button primary" disabled={busy}><Plus size={16}/>{tx(busy ? 'Creando…' : 'Crear clave', busy ? 'Creating…' : 'Create key')}</button></div>
      </form>
    </Modal>}
    {issued && <Modal title={tx('Nueva clave', 'New key')} closeable={false} onClose={() => {}}>
      <div className="form-stack integration-secret">
        <strong>{issued.name}</strong><p>{tx('Copia y guarda esta clave. Solo se muestra ahora.', 'Copy and save this key. It is only shown now.')}</p>
        <textarea ref={secretField} readOnly aria-label={tx('Clave secreta', 'Secret key')} value={issued.token} rows={3} spellCheck={false} autoComplete="off" autoCapitalize="off" onClick={selectSecret}/>
        <div className="integration-secret-tools"><button className="text-button" onClick={selectSecret}>{tx('Seleccionar texto', 'Select text')}</button><span role="status" className={copied ? 'integration-copy-success' : ''}>{copied ? tx('Clave copiada', 'Key copied') : tx('Vence', 'Expires') + ' ' + formatDate(issued.key.expiresAt)}</span></div>
        {secretError && <div className="inline-error" role="alert">{secretError}</div>}
        {issued.renewed && <small>{tx('Reemplaza la clave en tu otra app. La anterior vence en un máximo de 24 h.', 'Replace the key in your other app. The previous one expires within 24 h.')}</small>}
        <div className="modal-actions"><button className="button secondary" onClick={() => setIssued(null)}>{tx('Ya la guardé', 'I saved it')}</button><button className="button primary" onClick={() => copy(issued.token, true)}>{copied ? <Check size={16}/> : <Copy size={16}/>}{tx(copied ? 'Copiada' : 'Copiar clave', copied ? 'Copied' : 'Copy key')}</button></div>
      </div>
    </Modal>}
    {confirmation && <Modal title={confirmation.action === 'permissions' ? tx('Permisos de stock', 'Stock permissions') : confirmation.action === 'renew' ? tx('Renovar clave', 'Renew key') : confirmation.action === 'revoke' ? tx('Revocar clave', 'Revoke key') : confirmation.key ? tx('Eliminar clave', 'Delete key') : tx('Eliminar integración', 'Delete integration')} closeable={!busy} onClose={() => !busy && setConfirmation(null)}>
      <div className="form-stack integration-confirmation">
        <strong>{confirmation.client.name}</strong>{confirmation.key && <code>{confirmation.key.prefix}…</code>}
        <p>{confirmation.action === 'permissions' ? (confirmation.client.scopes.includes('inventory:reserve') ? tx('La app conservará acceso de lectura. Primero debe resolver sus reservas pendientes.', 'The app keeps read access. Pending reservations must be resolved first.') : tx('Esta app podrá reservar, confirmar y liberar stock con sus claves actuales.', 'This app can reserve, confirm and release stock using its current keys.')) : confirmation.action === 'renew' ? tx('Genera una clave nueva. La actual seguirá funcionando hasta 24 h para que puedas reemplazarla.', 'Generate a new key. The current key keeps working for up to 24 h so you can replace it.') : confirmation.action === 'revoke' ? tx('Esta clave dejará de funcionar. Su registro se conservará.', 'This key stops working. Its record will remain.') : confirmation.key ? tx('Esta clave se borrará definitivamente y dejará de funcionar.', 'This key will be permanently deleted and stop working.') : tx('Se borrarán esta integración y todas sus claves. No se puede deshacer.', 'This integration and all its keys will be deleted. This cannot be undone.')}</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>{tx('Cancelar', 'Cancel')}</button><button className={`button ${['renew', 'permissions'].includes(confirmation.action) ? 'primary' : 'danger-button'}`} disabled={busy} onClick={confirmAction}>{confirmation.action === 'permissions' ? <ShieldCheck size={16}/> : confirmation.action === 'renew' ? <KeyRound size={16}/> : confirmation.action === 'revoke' ? <Ban size={16}/> : <Trash2 size={16}/>}{busy ? tx('Guardando…', 'Saving…') : confirmation.action === 'permissions' ? tx('Confirmar permiso', 'Confirm permission') : confirmation.action === 'renew' ? tx('Generar nueva clave', 'Generate new key') : confirmation.action === 'revoke' ? tx('Revocar clave', 'Revoke key') : tx('Eliminar definitivamente', 'Delete permanently')}</button></div>
      </div>
    </Modal>}
  </div>
}
