import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Plus, RotateCw, ShieldCheck, Trash2 } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { LoadingSkeleton, Modal } from './ui.jsx'

export default function InventoryApiSettings({ setToast }) {
  const { language } = useI18n()
  const tx = (es, en) => language === 'es' ? es : en
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [days, setDays] = useState(90), [issued, setIssued] = useState(null)
  const load = useCallback(async () => {
    try { setData(await api.integrationClients()); setError('') } catch (next) { setError(next.message) }
  }, [])
  useEffect(() => { load() }, [load])
  const formatDate = value => new Date(value).toLocaleDateString(language === 'es' ? 'es-CL' : 'en-GB')
  const copy = async value => {
    try { await navigator.clipboard.writeText(value); setToast({ type: 'success', message: tx('Copiado', 'Copied') }) }
    catch { setError(tx('No se pudo copiar. Selecciona y copia el texto.', 'Copy failed. Select and copy the text.')) }
  }
  const issue = async (event, client) => {
    event?.preventDefault()
    setBusy(true); setError('')
    try {
      const result = client ? await api.rotateIntegrationKey(client.id, { expiresInDays: 90 }) : await api.createIntegrationClient({ name, expiresInDays: days })
      setCreating(false); setName(''); setIssued({ ...result, name: client?.name || result.client.name }); await load()
    } catch (next) { setError(next.message) } finally { setBusy(false) }
  }
  const revoke = async (client, key) => {
    if (!window.confirm(tx(`¿Revocar la clave ${key.prefix}…?`, `Revoke key ${key.prefix}…?`))) return
    setBusy(true)
    try { await api.revokeIntegrationKey(client.id, key.id); await load(); setToast({ type: 'success', message: tx('Clave revocada', 'Key revoked') }) }
    catch (next) { setError(next.message) } finally { setBusy(false) }
  }
  return <div className="inventory-api-settings">
    <div className="page-actions"><button className="button primary compact" disabled={busy || !data} onClick={() => { setError(''); setCreating(true) }}><Plus size={16}/>{tx('Crear integración', 'Create integration')}</button><button className="icon-button" onClick={load} disabled={busy} aria-label={tx('Actualizar', 'Refresh')}><RotateCw size={17}/></button></div>
    {error && <div className="inline-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
    {!data ? <LoadingSkeleton/> : <>
      <section className="card integration-summary"><div><ShieldCheck size={21}/><strong>{tx('Solo lectura', 'Read only')}</strong><span className={`status-pill ${data.enabled ? 'success' : 'neutral'}`}>{tx(data.enabled ? 'Activa' : 'Desactivada', data.enabled ? 'Enabled' : 'Disabled')}</span></div><small>{tx(data.environment === 'production' ? 'Producción' : 'Pruebas', data.environment === 'production' ? 'Production' : 'Test')} · {data.limits.perMinute} {tx('consultas/min por integración', 'requests/min per integration')}</small><div className="integration-endpoint"><code>GET {data.endpoint}</code><button className="icon-button" aria-label={tx('Copiar URL', 'Copy URL')} onClick={() => copy(new URL(data.endpoint, window.location.origin).href)}><Copy size={16}/></button></div>{!data.enabled && <p>{tx('La consulta externa está desactivada en este servidor.', 'External requests are disabled on this server.')}</p>}</section>
      {data.clients.length === 0 ? <section className="card integration-empty"><KeyRound size={28}/><strong>{tx('Sin integraciones', 'No integrations')}</strong><span>{tx('Crea una clave para conectar otra app.', 'Create a key to connect another app.')}</span></section> : data.clients.map(client => {
        const active = client.keys.filter(key => !key.revokedAt && Date.parse(key.expiresAt) > Date.now())
        return <section className="card integration-client" key={client.id}><header className="card-header"><div><h2>{client.name}</h2><small>inventory:read</small></div><button className="button secondary compact" disabled={busy || active.length >= 2} onClick={() => issue(null, client)} title={active.length >= 2 ? tx('Revoca la clave anterior para rotar.', 'Revoke the previous key to rotate.') : undefined}><RotateCw size={15}/>{tx('Rotar clave', 'Rotate key')}</button></header><div className="integration-keys">{client.keys.map(key => {
          const revoked = Boolean(key.revokedAt), expired = Date.parse(key.expiresAt) <= Date.now()
          return <article className="integration-key" key={key.id}><KeyRound size={18}/><div><code>{key.prefix}…</code><small>{tx('Vence', 'Expires')} {formatDate(key.expiresAt)}{key.lastUsedAt ? ` · ${tx('Último uso', 'Last used')} ${formatDate(key.lastUsedAt)}` : ''}</small></div><span className={`status-pill ${revoked || expired ? 'neutral' : 'success'}`}>{revoked ? tx('Revocada', 'Revoked') : expired ? tx('Vencida', 'Expired') : tx('Activa', 'Active')}</span>{!revoked && !expired && <button className="icon-button danger" disabled={busy} aria-label={`${tx('Revocar clave', 'Revoke key')} ${key.prefix}`} onClick={() => revoke(client, key)}><Trash2 size={16}/></button>}</article>
        })}</div></section>
      })}
    </>}
    {creating && <Modal title={tx('Crear integración', 'Create integration')} onClose={() => !busy && setCreating(false)} closeable={!busy}><form className="form-stack" onSubmit={issue}><label className="field"><span>{tx('Nombre', 'Name')}</span><input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={tx('Tienda online', 'Online store')}/></label><label className="field"><span>{tx('Vigencia de la clave', 'Key lifetime')}</span><select value={days} onChange={event => setDays(Number(event.target.value))}>{[7, 30, 90, 365].map(value => <option value={value} key={value}>{value} {tx('días', 'days')}</option>)}</select></label>{error && <div className="inline-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setCreating(false)}>{tx('Cancelar', 'Cancel')}</button><button className="button primary" disabled={busy}><Plus size={16}/>{tx(busy ? 'Creando…' : 'Crear clave', busy ? 'Creating…' : 'Create key')}</button></div></form></Modal>}
    {issued && <Modal title={tx('Clave de integración', 'Integration key')} onClose={() => setIssued(null)}><div className="form-stack integration-secret"><strong>{issued.name}</strong><p>{tx('Cópiala ahora. No volverá a mostrarse.', 'Copy it now. It will not be shown again.')}</p><textarea readOnly aria-label={tx('Clave secreta', 'Secret key')} value={issued.token} rows={3} spellCheck={false}/><small>{tx('Guárdala en el backend de la otra app.', 'Keep it in the other app’s backend.')}{issued.client ? '' : tx(' La clave anterior vence en un máximo de 24 horas.', ' The previous key expires within 24 hours.')}</small><div className="modal-actions"><button className="button secondary" onClick={() => copy(issued.token)}><Copy size={16}/>{tx('Copiar', 'Copy')}</button><button className="button primary" onClick={() => setIssued(null)}><Check size={16}/>{tx('Listo', 'Done')}</button></div></div></Modal>}
  </div>
}
