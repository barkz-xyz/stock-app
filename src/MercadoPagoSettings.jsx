import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, BadgeCheck, Check, ChevronRight, ExternalLink, LockKeyhole, MapPin, Pencil, Plus, RotateCw, Monitor, Settings, Store, Trash2, WalletCards, Wifi } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { Modal } from './ui.jsx'

export default function MercadoPagoSettings({ setToast }) {
  const { t } = useI18n()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await api.posManagement()) } catch (nextError) { setError(nextError.message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (action, successMessage) => {
    setBusy(true)
    try { await action(); await load(); setEditor(null); setToast({ type: 'success', message: successMessage }) }
    catch (nextError) { setToast({ type: 'error', message: nextError.message }) }
    finally { setBusy(false) }
  }
  const remove = (kind, entry) => {
    const name = entry.name || entry.id
    if (!window.confirm(t('deleteMpResourceQuestion', { name }))) return
    const action = kind === 'store' ? () => api.deletePointStore(entry.id) : () => api.deletePointRegister(entry.id)
    run(action, t('mpResourceDeleted', { name }))
  }
  const changeMode = (terminal) => {
    const nextMode = terminal.operating_mode === 'PDV' ? 'STANDALONE' : 'PDV'
    if (!window.confirm(t('changeTerminalModeQuestion', { mode: nextMode }))) return
    run(() => api.setPointTerminalMode(terminal.id, nextMode), t('terminalModeUpdated', { mode: nextMode }))
  }

  const stores = data?.stores || []
  const registers = data?.registers || []
  const terminals = data?.terminals || []
  const activeTerminal = terminals.find((terminal) => terminal.configured) || terminals[0] || null
  const storeDeleteBlocked = (store) => store.assigned || Number(store.register_count || 0) > 0
  const registerDeleteBlocked = (register) => register.assigned

  if (loading && !data) return <div className="page enter"><div className="loading"><div className="loader-mark"><Settings size={26} /></div><span>{t('loadingMpSettings')}</span></div></div>
  return <div className="page enter settings-page">
    <section className="page-heading"><div><span className="eyebrow">{t('mpSettingsEyebrow')}</span><h1>{t('mpSettings')}</h1><p>{t('mpSettingsDescription')}</p></div><button className="button secondary compact" onClick={load} disabled={loading}><RotateCw size={16} />{t('refreshSettings')}</button></section>
    {error && <div className="inline-error settings-error"><AlertTriangle size={16} />{error}</div>}
    {data && <>
      <section className="settings-account card">
        <div className="settings-account-identity"><div className="metric-icon"><WalletCards size={20} /></div><div><span className="eyebrow">{t('mpAccount')}</span><strong>{data.account?.nickname || t('sellerAccount')}</strong><small>{t('sellerId')}: {data.account?.id || '—'} · {t('site')}: {data.account?.site_id || '—'}</small></div></div>
        <div className="settings-health" aria-label={t('serverIntegration')}>
          <span className={`status-pill ${data.configuration?.credentialsCentralized && data.configuration?.credentialsExposedToClient === false ? 'success' : 'danger'}`} title={t('serverCredentialsDescription')}><LockKeyhole size={13} />{t('serverCredentials')}</span>
          <span className={`status-pill ${data.configuration?.webhookConfigured && data.configuration?.webhookTopic === 'order' ? 'success' : 'danger'}`} title={t('webhookConfiguredDescription')}><BadgeCheck size={13} />{t('webhookConfigured')}</span>
        </div>
      </section>
      <div className="settings-grid">
        <section className="card settings-card"><header className="card-header"><div><span className="eyebrow">{t('branches')}</span><h2>{t('branchesTitle')}</h2><p>{t('branchesDescription')}</p></div><button className="button secondary compact settings-create-button" onClick={() => setEditor({ type: 'store' })}><Plus size={16} />{t('newBranch')}</button></header><div className="settings-list">{stores.length ? stores.map((store) => {
          const blocked = storeDeleteBlocked(store)
          return <article className={`settings-row ${store.assigned ? 'is-assigned' : ''}`} key={store.id}>
            <div className="settings-row-icon"><Store size={18} /></div>
            <div className="settings-row-copy"><div><strong>{store.name || store.id}</strong>{store.assigned && <span className="resource-current"><BadgeCheck size={12} />{t('currentBranch')}</span>}</div><small>{store.external_id || store.id}{store.location?.city_name ? ` · ${store.location.city_name}` : ''}</small></div>
            <span className="settings-resource-count">{t('cashRegisterCount', { count: Number(store.register_count || 0) })}</span>
            <div className="settings-resource-actions"><button className="settings-action-button" onClick={() => setEditor({ type: 'store', entry: store })}><Pencil size={15} />{t('edit')}</button>{blocked ? <span className="settings-resource-locked" title={t('resourceInUse')}><LockKeyhole size={14} />{t('inUse')}</span> : <button className="settings-action-button danger" onClick={() => remove('store', store)}><Trash2 size={15} />{t('delete')}</button>}</div>
          </article>
        }) : <div className="settings-empty"><Store size={22} /><span>{t('noBranches')}</span></div>}</div></section>
        <section className="card settings-card"><header className="card-header"><div><span className="eyebrow">{t('cashRegisters')}</span><h2>{t('cashRegistersTitle')}</h2><p>{t('cashRegistersDescription')}</p></div><button className="button secondary compact settings-create-button" onClick={() => setEditor({ type: 'register' })}><Plus size={16} />{t('newCashRegister')}</button></header><div className="settings-list">{registers.length ? registers.map((register) => {
          const blocked = registerDeleteBlocked(register)
          return <article className={`settings-row ${register.assigned ? 'is-assigned' : ''}`} key={register.id}>
            <div className="settings-row-icon"><Monitor size={18} /></div>
            <div className="settings-row-copy"><div><strong>{register.name || register.id}</strong>{register.assigned && <span className="resource-current"><BadgeCheck size={12} />{t('currentCashRegister')}</span>}</div><small>{register.external_id || register.id} · {register.store?.name || t('branchNotFound')}</small></div>
            <div className="settings-resource-actions"><button className="settings-action-button" onClick={() => setEditor({ type: 'register', entry: register })}><Pencil size={15} />{t('edit')}</button>{blocked ? <span className="settings-resource-locked" title={t('resourceInUse')}><LockKeyhole size={14} />{t('inUse')}</span> : <button className="settings-action-button danger" onClick={() => remove('register', register)}><Trash2 size={15} />{t('delete')}</button>}</div>
          </article>
        }) : <div className="settings-empty"><Monitor size={22} /><span>{t('noCashRegisters')}</span></div>}</div></section>
      </div>
      <section className="card settings-card terminal-settings-card"><header className="card-header"><div><span className="eyebrow">{t('terminals')}</span><h2>{t('terminalsTitle')}</h2><p>{t('terminalsDescription')}</p></div></header>{activeTerminal ? <div className="terminal-management">
        <div className="terminal-summary"><div className="terminal-identity"><div className="settings-row-icon"><Wifi size={20} /></div><div><span>{t('pointSmart2')}</span><strong>{activeTerminal.serial || activeTerminal.id}</strong><small>{activeTerminal.configured ? t('bakeryPosTerminal') : activeTerminal.id}</small></div></div><div className="terminal-statuses"><span className={`status-pill ${activeTerminal.operating_mode === 'PDV' ? 'success' : 'neutral'}`}>{activeTerminal.operating_mode || '—'}</span><span className={`status-pill ${activeTerminal.ready ? 'success' : 'warning'}`}>{activeTerminal.ready ? t('readyToCharge') : t('setupIncomplete')}</span>{activeTerminal.online === false && <span className="status-pill danger">{t('notConnected')}</span>}</div></div>
        <div className="terminal-assignment"><div className="terminal-assignment-title"><span className="eyebrow">{t('currentAssignment')}</span><small>{t('assignmentVerifiedFromApi')}</small></div><div className="terminal-assignment-flow"><div className="assignment-node"><span><MapPin size={17} /></span><div><small>{t('branch')}</small><strong>{activeTerminal.store?.name || t('unassigned')}</strong><b>{activeTerminal.store?.external_id || activeTerminal.store_id || '—'}</b></div></div><ChevronRight className="assignment-arrow" size={19} /><div className="assignment-node"><span><Monitor size={17} /></span><div><small>{t('cashRegister')}</small><strong>{activeTerminal.register?.name || t('unassigned')}</strong><b>{activeTerminal.register?.external_id || activeTerminal.pos_id || '—'}</b></div></div></div></div>
        <div className="terminal-management-footer"><div className="terminal-guidance"><AlertTriangle size={17} /><div><strong>{t('assignmentManagedByMercadoPago')}</strong><p>{t('assignmentManagedDescription')}</p></div></div><div className="terminal-actions">{activeTerminal.management_url && <a className="button primary compact" href={activeTerminal.management_url} target="_blank" rel="noreferrer">{t('changeAssignment')}<ExternalLink size={15} /></a>}<button className="button secondary compact" onClick={() => changeMode(activeTerminal)} disabled={busy}>{t('changeMode')}</button></div></div>
      </div> : <div className="settings-empty"><Wifi size={22} /><span>{t('noTerminals')}</span></div>}</section>
    </>}
    {editor && <Modal title={editor.type === 'store' ? (editor.entry ? t('editBranch') : t('newBranch')) : (editor.entry ? t('editCashRegister') : t('newCashRegister'))} eyebrow={t('mpSettingsEyebrow')} onClose={() => setEditor(null)}><PointResourceForm type={editor.type} entry={editor.entry} stores={data?.stores || []} busy={busy} onClose={() => setEditor(null)} onSubmit={(form) => run(() => editor.type === 'store' ? (editor.entry ? api.updatePointStore(editor.entry.id, form) : api.createPointStore(form)) : (editor.entry ? api.updatePointRegister(editor.entry.id, form) : api.createPointRegister(form)), t('mpResourceSaved'))} /></Modal>}
  </div>
}

function PointResourceForm({ type, entry, stores, busy, onClose, onSubmit }) {
  const { t } = useI18n()
  const [form, setForm] = useState(() => type === 'store' ? {
    name: entry?.name || '', external_id: entry?.external_id || '', location: { ...(entry?.location || {}) },
  } : { name: entry?.name || '', external_id: entry?.external_id || '', store_id: entry?.store_id || '', fixed_amount: entry?.fixed_amount ?? false })
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const updateLocation = (key, value) => setForm((current) => ({ ...current, location: { ...current.location, [key]: value } }))
  const submit = (event) => { event.preventDefault(); onSubmit(form) }
  return <form className="form-stack settings-form" onSubmit={submit}>
    <label><span>{t('name')}</span><input required maxLength="120" value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
    <label><span>{t('externalId')}</span><input maxLength="60" value={form.external_id} onChange={(event) => update('external_id', event.target.value)} placeholder={type === 'store' ? 'ATELIER-01' : 'CAJA-01'} /></label>
    {type === 'store' ? <div className="settings-form-grid">
      <label><span>{t('street')}</span><input value={form.location.street_name || ''} onChange={(event) => updateLocation('street_name', event.target.value)} /></label>
      <label><span>{t('number')}</span><input value={form.location.street_number || ''} onChange={(event) => updateLocation('street_number', event.target.value)} /></label>
      <label><span>{t('city')}</span><input value={form.location.city_name || ''} onChange={(event) => updateLocation('city_name', event.target.value)} /></label>
      <label><span>{t('region')}</span><input value={form.location.state_name || ''} onChange={(event) => updateLocation('state_name', event.target.value)} /></label>
      <label><span>{t('latitude')}</span><input required type="number" min="-90" max="90" step="any" value={form.location.latitude ?? ''} onChange={(event) => updateLocation('latitude', event.target.value)} placeholder="-33.0245" /></label>
      <label><span>{t('longitude')}</span><input required type="number" min="-180" max="180" step="any" value={form.location.longitude ?? ''} onChange={(event) => updateLocation('longitude', event.target.value)} placeholder="-71.5518" /></label>
    </div> : <>
      <label><span>{t('branch')}</span><select value={form.store_id} onChange={(event) => update('store_id', event.target.value)}><option value="">{t('selectBranch')}</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name || store.id}</option>)}</select></label>
      <label className="switch-field"><input type="checkbox" checked={Boolean(form.fixed_amount)} onChange={(event) => update('fixed_amount', event.target.checked)} /><i /><span>{t('fixedAmount')}</span></label>
    </>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? t('saving') : t('saveChanges')}<Check size={17} /></button></div>
  </form>
}
