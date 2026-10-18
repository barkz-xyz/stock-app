import { useEffect, useState } from 'react'
import { Plus, Pencil, ShieldCheck, UserRound, Check, AlertTriangle } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { Modal, LoadingSkeleton } from './ui.jsx'

export default function UserManagement({ currentUser,setToast }) {
  const {language}=useI18n(),tx=(es,en)=>language==='es'?es:en
  const [users,setUsers]=useState(null),[editing,setEditing]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const load=()=>api.users().then(setUsers).catch(e=>setError(e.message))
  useEffect(()=>{load()},[])
  const save=async e=>{e.preventDefault();setBusy(true);setError('');try{await(editing.id?api.updateUser(editing.id,editing):api.createUser(editing));setEditing(null);await load();setToast({type:'success',message:tx('Usuario guardado','User saved')})}catch(e){setError(e.message)}finally{setBusy(false)}}
  const fresh=()=>{setError('');setEditing({username:'',name:'',role:'cashier',active:true,password:''})}
  return <div className="page users-page"><section className="page-heading compact-heading"><h1>{tx('Usuarios','Users')}</h1><button className="button primary" onClick={fresh}><Plus size={18}/>{tx('Crear usuario','Create user')}</button></section>
    {error&&!editing&&<div className="inline-error" role="alert">{error}</div>}
    {!users?<LoadingSkeleton/>:<section className="card user-list">{users.map(u=><article key={u.id}><div className={`user-role-mark ${u.role}`}>{u.role==='admin'?<ShieldCheck size={20}/>:<UserRound size={20}/>}</div><div><strong>{u.name}</strong><small>@{u.username}{u.id===currentUser.id?tx(' · Tú',' · You'):''}</small></div><span className={`status ${u.active?'success':'neutral'}`}>{u.role==='admin'?tx('Administrador','Administrator'):tx('Cajero','Cashier')}{!u.active?tx(' · Inactivo',' · Inactive'):''}</span><button className="icon-button" onClick={()=>{setError('');setEditing({...u,password:''})}} aria-label={`${tx('Editar','Edit')} ${u.name}`}><Pencil size={17}/></button></article>)}</section>}
    {editing&&<Modal title={tx(editing.id?'Editar usuario':'Crear usuario',editing.id?'Edit user':'Create user')} onClose={()=>!busy&&setEditing(null)} closeable={!busy}><form className="form-stack" onSubmit={save}>
      <label className="field"><span>{tx('Nombre','Name')}</span><input required maxLength={80} value={editing.name} onChange={e=>setEditing(v=>({...v,name:e.target.value}))}/></label>
      <label className="field"><span>{tx('Usuario','Username')}</span><input required pattern="[a-z0-9][a-z0-9._-]{2,39}" autoCapitalize="none" autoComplete="off" value={editing.username} onChange={e=>setEditing(v=>({...v,username:e.target.value.toLowerCase()}))}/></label>
      <label className="field"><span>{tx('Rol','Role')}</span><select value={editing.role} onChange={e=>setEditing(v=>({...v,role:e.target.value}))}><option value="cashier">{tx('Cajero · Solo Caja','Cashier · Register only')}</option><option value="admin">{tx('Administrador · Todo','Administrator · Full access')}</option></select></label>
      <label className="field"><span>{tx('Contraseña temporal','Temporary password')}{editing.id?tx(' · Dejar vacío para mantener',' · Leave blank to keep'):''}</span><input type="password" required={!editing.id} minLength={8} maxLength={128} autoComplete="new-password" value={editing.password} onChange={e=>setEditing(v=>({...v,password:e.target.value}))}/><small>{tx('Se cambia al primer ingreso.','Changed at first sign-in.')}</small></label>
      <label className="switch-field"><input type="checkbox" checked={editing.active} onChange={e=>setEditing(v=>({...v,active:e.target.checked}))}/><i/><span>{tx('Activo','Active')}</span></label>
      {error&&<div className="inline-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>setEditing(null)}>{tx('Cancelar','Cancel')}</button><button className="button primary" disabled={busy}><Check size={17}/>{tx(busy?'Guardando…':'Guardar',busy?'Saving…':'Save')}</button></div>
    </form></Modal>}
  </div>
}
