import crypto from 'node:crypto'
import { cashError, cleanWithdrawal, cleanSettlement, cashFingerprint, isCashId, withCashLedger } from './cash-ledger.js'

const normalize = row => ({ id: row.id, sessionId: row.session_id ?? row.sessionId,
  ownerId: row.owner_id ?? row.ownerId, operator: row.operator, amount: Number(row.amount),
  recipient: row.recipient, purpose: row.purpose, status: row.status,
  spentAmount: row.spent_amount == null && row.spentAmount == null ? null : Number(row.spent_amount ?? row.spentAmount),
  documentType: row.document_type ?? row.documentType ?? null, documentNumber: row.document_number ?? row.documentNumber ?? '',
  supplier: row.supplier || '', detail: row.detail || '',
  settledSessionId: row.settled_session_id ?? row.settledSessionId ?? null,
  createdAt: new Date(row.created_at ?? row.createdAt).toISOString(),
  settledAt: row.settled_at || row.settledAt ? new Date(row.settled_at ?? row.settledAt).toISOString() : null })
const withdrawalSelect = `SELECT w.*,s.user_id AS owner_id,s.operator FROM register_cash_withdrawals w JOIN register_sessions s ON s.id=w.session_id`
const entrySelect = `SELECT e.*,w.recipient,w.purpose,w.spent_amount,w.document_type,w.document_number,w.supplier,w.detail,u.name AS operator
  FROM register_cash_entries e JOIN register_cash_withdrawals w ON w.id=e.withdrawal_id JOIN app_users u ON u.id=e.created_by`
const normalizeEntry = row => ({ id: row.id, sessionId: row.session_id ?? row.sessionId,
  withdrawalId: row.withdrawal_id ?? row.withdrawalId, kind: row.kind, amount: Number(row.amount),
  recipient: row.recipient, purpose: row.purpose, operator: row.operator,
  spentAmount: row.spent_amount == null && row.spentAmount == null ? null : Number(row.spent_amount ?? row.spentAmount),
  documentType: row.document_type ?? row.documentType ?? null, documentNumber: row.document_number ?? row.documentNumber ?? '',
  supplier: row.supplier || '', detail: row.detail || '', createdAt: new Date(row.created_at ?? row.createdAt).toISOString() })

export function createRegisterCashStore({ pool, readFileData, mutateFileData, normalizeRegister, sessionSales, sessionSummary }) {
  const own = (row, user, open = false) => {
    const session = normalizeRegister(row)
    if (!session || user.role !== 'admin' && session.userId !== user.id) throw cashError('Sesión no encontrada.', 404, 'NOT_FOUND')
    if (open && (session.closedAt || session.userId !== user.id)) throw cashError('Abre tu propia sesión de caja.', 409, 'SESSION_REQUIRED')
    return session
  }
  const fileEntries = (data, sessionId, period) => data.cashEntries.filter(e => (!sessionId || e.sessionId === sessionId)
    && (!period || new Date(e.createdAt) >= period.from && new Date(e.createdAt) < period.to)).map(e => {
      const w = data.cashWithdrawals.find(w => w.id === e.withdrawalId)
      return normalizeEntry({ ...w, ...e })
    }).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const entries = async (sessionId, queryable = pool, period) => {
    if (!pool) return fileEntries(queryable || await readFileData(), sessionId, period)
    const conditions = [], params = []
    if (sessionId) { params.push(sessionId); conditions.push(`e.session_id=$${params.length}`) }
    if (period) { params.push(period.from, period.to); conditions.push(`e.created_at >= $${params.length-1} AND e.created_at < $${params.length}`) }
    return (await queryable.query(entrySelect + (conditions.length ? ' WHERE '+conditions.join(' AND ') : '') + ' ORDER BY e.created_at,e.id', params)).rows.map(normalizeEntry)
  }
  const available = async (session, db, data) => {
    const sales = pool ? await sessionSales(session.id, db) : data.sales.filter(s => s.registerSessionId === session.id)
    const ledger = pool ? await entries(session.id, db) : fileEntries(data, session.id)
    return { balance: session.openingCash + sessionSummary(sales, session).cash.net + withCashLedger({}, ledger).cashLedger.net, entries: ledger }
  }
  const fileWithdrawal = (data, id) => {
    const w = data.cashWithdrawals.find(w => w.id === id)
    if (!w) return null
    const session = data.registerSessions.find(s => s.id === w.sessionId)
    return normalize({ ...w, ownerId: session.userId, operator: session.operator })
  }
  const getWithdrawal = async (id, db = pool, data) => pool
    ? normalize((await db.query(withdrawalSelect+' WHERE w.id=$1', [id])).rows[0])
    : fileWithdrawal(data, id)
  const operate = async (user, key, kind, body, action) => {
    if (!isCashId(key)) throw cashError('Falta la referencia de la operación.', 400, 'IDEMPOTENCY_REQUIRED')
    const fingerprint = cashFingerprint({ kind, body })
    const check = op => {
      if (op.userId !== user.id) throw cashError('Operación no encontrada.', 404, 'NOT_FOUND')
      if (op.fingerprint !== fingerprint) throw cashError('Esta referencia ya se usó con otros datos.', 409, 'IDEMPOTENCY_CONFLICT')
    }
    if (!pool) return mutateFileData(async data => {
      const previous = data.cashOperations.find(op => op.id === key)
      if (previous) { check(previous); return { withdrawal: fileWithdrawal(data, previous.resultId), replayed: true } }
      const id = await action(null, data)
      data.cashOperations.push({ id: key, userId: user.id, fingerprint, resultId: id })
      return { withdrawal: fileWithdrawal(data, id), replayed: false }
    })
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['register-cash:'+key])
      const previous = (await db.query('SELECT user_id AS "userId",fingerprint,result_id AS "resultId" FROM register_cash_operations WHERE id=$1', [key])).rows[0]
      if (previous) {
        check(previous); const withdrawal = await getWithdrawal(previous.resultId, db)
        await db.query('COMMIT'); return { withdrawal, replayed: true }
      }
      const id = await action(db)
      await db.query('INSERT INTO register_cash_operations(id,user_id,kind,fingerprint,result_id) VALUES($1,$2,$3,$4,$5)', [key,user.id,kind,fingerprint,id])
      const withdrawal = await getWithdrawal(id, db)
      await db.query('COMMIT'); return { withdrawal, replayed: false }
    } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  }
  const lockSession = async (db, data, user, id) => own(pool
    ? (await db.query('SELECT * FROM register_sessions WHERE id=$1 FOR UPDATE', [id])).rows[0]
    : data.registerSessions.find(s => s.id === id), user, true)
  const addEntry = async (db, data, user, sessionId, w, kind, amount) => {
    const entry = { id: crypto.randomUUID(), sessionId, withdrawalId: w.id, kind, amount, operator: user.name, createdAt: new Date().toISOString() }
    if (pool) await db.query('INSERT INTO register_cash_entries(id,session_id,withdrawal_id,kind,amount,created_by) VALUES($1,$2,$3,$4,$5,$6)', [entry.id,sessionId,w.id,kind,amount,user.id])
    else data.cashEntries.push(entry)
  }
  return {
    entries,
    balance: (session,db=pool) => available(normalizeRegister(session),db),
    async workspace(user) {
      const reader=pool?await pool.connect():null
      try {
      if(reader)await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      let session, withdrawals, data
      if (pool) {
        session = normalizeRegister((await reader.query('SELECT * FROM register_sessions WHERE user_id=$1 AND closed_at IS NULL', [user.id])).rows[0])
        withdrawals = (await reader.query(withdrawalSelect + ` WHERE ${user.role === 'admin' ? '' : 's.user_id=$1 AND '}(w.status='pending' OR w.created_at>=NOW()-INTERVAL '30 days') ORDER BY w.created_at DESC,w.id`, user.role === 'admin' ? [] : [user.id])).rows.map(normalize)
      } else {
        data = await readFileData(); session = normalizeRegister(data.registerSessions.find(s => s.userId === user.id && !s.closedAt))
        withdrawals = data.cashWithdrawals.map(w => fileWithdrawal(data, w.id)).filter(w => (user.role === 'admin' || w.ownerId === user.id)
          && (w.status === 'pending' || Date.now()-new Date(w.createdAt).getTime() <= 30*86400000)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
      }
      const amounts = session ? await available(session, reader, data) : { balance: 0, entries: [] }
      if(reader)await reader.query('COMMIT')
      return { session, availableCash: Math.max(0,amounts.balance), balance: amounts.balance, withdrawals, entries: amounts.entries }
      }catch(e){if(reader)await reader.query('ROLLBACK');throw e}finally{reader?.release()}
    },
    issue(user, key, input) {
      const body = cleanWithdrawal(input)
      return operate(user,key,'withdrawal',body,async (db,data) => {
        const session = await lockSession(db,data,user,body.sessionId)
        const { balance } = await available(session,db,data)
        if (body.amount > balance) throw cashError('El retiro supera el efectivo disponible.',409,'INSUFFICIENT_CASH')
        const w = { id: crypto.randomUUID(), ...body, status:'pending',createdAt:new Date().toISOString() }
        if (pool) await db.query('INSERT INTO register_cash_withdrawals(id,session_id,amount,recipient,purpose,created_by) VALUES($1,$2,$3,$4,$5,$6)',[w.id,w.sessionId,w.amount,w.recipient,w.purpose,user.id])
        else data.cashWithdrawals.push(w)
        await addEntry(db,data,user,session.id,w,'withdrawal',w.amount)
        return w.id
      })
    },
    settle(user, id, key, input) {
      if (!isCashId(id)) throw cashError('Retiro no encontrado.',404,'NOT_FOUND')
      const body = cleanSettlement(input)
      return operate(user,key,'settlement',{ id,...body },async (db,data) => {
        const session = await lockSession(db,data,user,body.sessionId)
        const row = pool ? (await db.query(withdrawalSelect+' WHERE w.id=$1 FOR UPDATE OF w',[id])).rows[0] : fileWithdrawal(data,id)
        if (!row) throw cashError('Retiro no encontrado.',404,'NOT_FOUND')
        const w = normalize(row)
        if (user.role !== 'admin' && w.ownerId !== user.id) throw cashError('Retiro no encontrado.',404,'NOT_FOUND')
        if (w.status === 'settled') throw cashError('Este retiro ya fue rendido.',409,'WITHDRAWAL_SETTLED')
        if (body.spentAmount > w.amount) throw cashError('El monto usado supera el retiro. Registra otro retiro para el excedente.',409,'SPENT_EXCEEDS_WITHDRAWAL')
        if (pool) await db.query(`UPDATE register_cash_withdrawals SET status='settled',spent_amount=$2,document_type=$3,
          document_number=$4,supplier=$5,detail=$6,settled_session_id=$7,settled_by=$8,settled_at=NOW() WHERE id=$1`,
          [id,body.spentAmount,body.documentType,body.documentNumber,body.supplier,body.detail,session.id,user.id])
        else {
          const { sessionId, ...details } = body
          Object.assign(data.cashWithdrawals.find(w=>w.id===id),details,{status:'settled',settledSessionId:session.id,settledAt:new Date().toISOString()})
        }
        await addEntry(db,data,user,session.id,w,'return',w.amount-body.spentAmount)
        return id
      })
    },
  }
}
