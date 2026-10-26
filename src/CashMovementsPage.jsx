import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Banknote, Check, Plus, RotateCw } from 'lucide-react'
import { api } from './api.js'
import { useI18n } from './i18n.js'
import { Modal, LoadingSkeleton } from './ui.jsx'
import CajaHeader from './CajaHeader.jsx'

const attemptKey = id => `bakery-cash-attempt:${id}`
function readAttempt(id) {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptKey(id)) || 'null')
    return value?.key && ['withdrawal','settlement'].includes(value.kind) && value.body ? value : null
  } catch { return null }
}
const remember = (id, value) => { try { value ? sessionStorage.setItem(attemptKey(id),JSON.stringify(value)) : sessionStorage.removeItem(attemptKey(id)) } catch { /* Manual retries keep the in-memory key. */ } }

export default function CashMovementsPage({ user, refreshToken, onRefresh, onNavigate, setToast }) {
  const { language, formatCurrency: money } = useI18n(), tx = (es,en) => language === 'es' ? es : en
  const [data,setData] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const [modal,setModal] = useState(null), [pending,setPending] = useState(()=>readAttempt(user.id))
  const [recipient,setRecipient] = useState(''), [purpose,setPurpose] = useState(''), [amount,setAmount] = useState('')
  const [spent,setSpent] = useState(''), [documentType,setDocumentType] = useState('boleta'), [folio,setFolio] = useState(''), [supplier,setSupplier] = useState(''), [detail,setDetail] = useState('')
  const [view,setView] = useState('pending'), generation = useRef(0), sending = useRef(false)
  const closeModal=useCallback(()=>{if(!busy&&!pending)setModal(null)},[busy,pending])
  const load = async () => {
    const current=++generation.current
    try { const next=await api.registerCash(); if(current===generation.current)setData(next) }
    catch(e){if(current===generation.current)setError(e.message)}
  }
  useEffect(()=>{load();return()=>{generation.current++}},[refreshToken,user.id])
  const submit = async operation => {
    if(sending.current)return
    sending.current=true;setBusy(true);setError('')
    const attempt=pending||operation
    setPending(attempt);remember(user.id,attempt)
    try {
      await (attempt.kind==='withdrawal'?api.withdrawCash(attempt.body,attempt.key):api.settleCash(attempt.id,attempt.body,attempt.key))
      setPending(null);remember(user.id,null);setModal(null);setAmount('');setRecipient('');setPurpose('')
      setToast({type:'success',message:tx(attempt.kind==='withdrawal'?'Retiro registrado':'Rendición registrada',attempt.kind==='withdrawal'?'Withdrawal recorded':'Settlement recorded')})
      await Promise.allSettled([load(),onRefresh()])
    }catch(e){
      setError(e.message)
      // Server errors can arrive after commit. Preserve the key and frozen body
      // until the operator explicitly recovers the result.
      if(e.status>=400&&e.status<500&&![401,403,408,429].includes(e.status)){setPending(null);remember(user.id,null)}
    }finally{sending.current=false;setBusy(false)}
  }
  const beginSettlement = w => { setSpent('');setFolio('');setSupplier('');setDetail('');setDocumentType('boleta');setError('');setModal(w) }
  const date = value => new Intl.DateTimeFormat(language==='es'?'es-CL':'en-GB',{dateStyle:'short',timeStyle:'short'}).format(new Date(value))
  const field = (label,value,set,{type='text',min,max,maxLength=300,required=true}={}) => <label className="field"><span>{label}</span><input type={type} inputMode={type==='number'?'numeric':undefined} min={min} max={max} step={type==='number'?'1':undefined} value={value} required={required} maxLength={type==='text'?maxLength:undefined} disabled={busy||Boolean(pending)} onChange={e=>set(e.target.value)}/></label>
  return <div className="page cash-movements-page enter">
    <CajaHeader active="cash" onNavigate={onNavigate}/>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {pending&&<div className="card cash-recovery"><span>{tx('Operación por verificar','Operation awaiting verification')}</span><button className="button primary" disabled={busy} onClick={()=>submit(pending)}><RotateCw size={16}/>{tx('Recuperar operación','Recover operation')}</button></div>}
    {!data?<LoadingSkeleton/>:<>
      <section className="card cash-available"><div><span>{tx('Efectivo disponible','Available cash')}</span><strong>{money(data.availableCash)}</strong></div><button className="button primary" disabled={!data.session||data.availableCash<=0||busy||Boolean(pending)} onClick={()=>{setError('');setModal('new')}}><Plus size={17}/>{tx('Nuevo retiro','New withdrawal')}</button></section>
      {!data.session&&<button className="button secondary" onClick={()=>onNavigate('/caja')}>{tx('Abrir caja','Open register')}</button>}
      <div className="cash-view-tabs" role="tablist" aria-label={tx('Retiros de caja','Cash withdrawals')}>
        {[['pending',tx('Por rendir','Pending')],['settled',tx('Rendidos · 30 días','Settled · 30 days')]].map(([id,label])=><button role="tab" aria-selected={view===id} key={id} className={view===id?'active':''} onClick={()=>setView(id)}>{label}<small>{data.withdrawals.filter(w=>w.status===id).length}</small></button>)}
      </div>
      <div className="cash-withdrawals" role="tabpanel">
        {data.withdrawals.filter(w=>w.status===view).map(w=><article className="card cash-withdrawal" key={w.id}>
          <header><span className="cash-entry-icon"><ArrowUpRight size={20}/></span><div><strong>{w.recipient}</strong><small>{date(w.createdAt)} · {w.operator}</small></div><strong>{money(w.amount)}</strong></header>
          <p>{w.purpose}</p>
          {w.status==='pending'?<button className="button secondary" disabled={!data.session||busy||Boolean(pending)} onClick={()=>beginSettlement(w)}><Check size={16}/>{tx('Rendir retiro','Settle withdrawal')}</button>:<details><summary>{tx('Usado','Spent')} {money(w.spentAmount)} · {tx('Vuelto','Returned')} {money(w.amount-w.spentAmount)}</summary><p>{w.documentType==='sin_gasto'?tx('Sin gasto','No expense'):`${w.documentType==='factura'?'Factura':'Boleta'} ${w.documentNumber} · ${w.supplier}`}</p><p>{w.detail}</p><small>{date(w.settledAt)}</small></details>}
        </article>)}
        {!data.withdrawals.some(w=>w.status===view)&&<div className="card cash-empty"><Banknote size={27}/><strong>{tx(view==='pending'?'Sin retiros pendientes':'Sin rendiciones recientes',view==='pending'?'No pending withdrawals':'No recent settlements')}</strong></div>}
      </div>
    </>}
    {modal&&<Modal title={modal==='new'?tx('Nuevo retiro','New withdrawal'):tx('Rendir retiro','Settle withdrawal')} closeable={!busy&&!pending} onClose={closeModal}>
      <form className="cash-operation-form" onSubmit={e=>{e.preventDefault();submit(modal==='new'?{kind:'withdrawal',key:crypto.randomUUID(),body:{sessionId:data.session.id,amount:Number(amount),recipient,purpose}}:{kind:'settlement',id:modal.id,key:crypto.randomUUID(),body:{sessionId:data.session.id,spentAmount:Number(spent),documentType,documentNumber:folio,supplier,detail}})}}>
        {modal==='new'?<>
          {field(tx('Monto · CLP','Amount · CLP'),amount,setAmount,{type:'number',min:1,max:data.availableCash})}
          {field(tx('Entregado a','Recipient'),recipient,setRecipient,{maxLength:120})}
          {field(tx('Motivo','Purpose'),purpose,setPurpose)}
          <small>{tx('Disponible','Available')}: {money(data.availableCash)}</small>
        </>:<>
          <div className="cash-operation-total"><span>{modal.recipient}</span><strong>{money(modal.amount)}</strong></div>
          {field(tx('Monto usado · CLP','Amount spent · CLP'),spent,setSpent,{type:'number',min:0,max:modal.amount})}
          <div className="cash-operation-total returned"><span><ArrowDownLeft size={16}/>{tx('Vuelve a caja','Returned to register')}</span><strong>{spent===''?'—':money(modal.amount-Number(spent))}</strong></div>
          {Number(spent)>0&&<><label className="field"><span>{tx('Comprobante','Receipt')}</span><select disabled={busy||Boolean(pending)} value={documentType} onChange={e=>setDocumentType(e.target.value)}><option value="boleta">Boleta</option><option value="factura">Factura</option></select></label>{field(tx('Folio','Document number'),folio,setFolio,{maxLength:80})}{field(tx('Proveedor','Supplier'),supplier,setSupplier,{maxLength:160})}</>}
          {field(tx('Detalle','Details'),detail,setDetail,{maxLength:1000})}
        </>}
        {error&&<div className="inline-error" role="alert">{error}</div>}
        {pending?<button className="button primary" disabled={busy} type="button" onClick={()=>submit(pending)}><RotateCw size={16}/>{tx('Recuperar operación','Recover operation')}</button>:<button className="button primary" disabled={busy} type="submit">{busy?tx('Guardando…','Saving…'):tx('Confirmar','Confirm')}<Check size={17}/></button>}
      </form>
    </Modal>}
  </div>
}
