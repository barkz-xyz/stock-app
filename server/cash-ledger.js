import crypto from 'node:crypto'
import { cleanCashCount } from '../src/cashCount.js'

export const cashError = (message, status = 400, code = 'INVALID_CASH_OPERATION') => Object.assign(new Error(message), { status, code })
export const isCashId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export function cashAmount(value, label, allowZero = true) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw cashError(`Completa ${label}.`)
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 100000000000) throw cashError(`Revisa ${label}. Usa pesos enteros.`)
  return amount
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) throw cashError(`Revisa ${label}.`)
  return value.trim()
}
export function cleanWithdrawal(body) {
  if (!body || !isCashId(body.sessionId)) throw cashError('Abre una sesión de caja.', 409, 'SESSION_REQUIRED')
  return { sessionId: body.sessionId, amount: cashAmount(body.amount, 'el monto del retiro', false),
    recipient: text(body.recipient, 'a quién se entrega', 120), purpose: text(body.purpose, 'el motivo', 300) }
}
export function cleanSettlement(body) {
  if (!body || !isCashId(body.sessionId)) throw cashError('Abre una sesión para recibir el vuelto.', 409, 'SESSION_REQUIRED')
  const spentAmount = cashAmount(body.spentAmount, 'el monto usado')
  let returnDenominations
  if (body.returnDenominations != null) {
    try { returnDenominations = cleanCashCount(body.returnDenominations) } catch (error) { throw cashError(error.message) }
  }
  if (spentAmount && !['boleta', 'factura'].includes(body.documentType)) throw cashError('Selecciona boleta o factura.')
  return { sessionId: body.sessionId, spentAmount,
    documentType: spentAmount ? body.documentType : 'sin_gasto',
    documentNumber: text(body.documentNumber ?? '', 'el folio', 80, spentAmount > 0),
    supplier: text(body.supplier ?? '', 'el proveedor', 160, spentAmount > 0),
    detail: text(body.detail, 'el detalle de la rendición', 1000),
    ...(returnDenominations ? { returnDenominations } : {}) }
}
export const cashFingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function withCashLedger(summary, entries = [], legacy = {}) {
  const legacyCashIn = Number(legacy.legacyCashIn ?? legacy.cashIn ?? 0), legacyCashOut = Number(legacy.legacyCashOut ?? legacy.cashOut ?? 0)
  const cashIn = legacyCashIn + entries.filter(e => e.kind === 'return').reduce((sum, e) => sum + e.amount, 0)
  const cashOut = legacyCashOut + entries.filter(e => e.kind === 'withdrawal').reduce((sum, e) => sum + e.amount, 0)
  const { fingerprint, ...data } = summary
  const next = { ...data, cashLedger: { cashIn, cashOut, net: cashIn - cashOut, legacyCashIn, legacyCashOut, entries } }
  return { ...next, fingerprint: cashFingerprint(next) }
}

export async function initializeCashLedger(pool) {
  await pool.query(`
    ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS opening_extra_cash NUMERIC(12,0) NOT NULL DEFAULT 0 CHECK(opening_extra_cash>=0);
    ALTER TABLE register_sessions ADD COLUMN IF NOT EXISTS opening_source_session_id UUID REFERENCES register_sessions(id);
    CREATE TABLE IF NOT EXISTS register_cash_withdrawals (
      id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES register_sessions(id),
      amount NUMERIC(12,0) NOT NULL CHECK(amount>0), recipient TEXT NOT NULL, purpose TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES app_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled')),
      spent_amount NUMERIC(12,0) CHECK(spent_amount>=0 AND spent_amount<=amount),
      document_type TEXT, document_number TEXT, supplier TEXT, detail TEXT,
      settled_session_id UUID REFERENCES register_sessions(id), settled_by UUID REFERENCES app_users(id), settled_at TIMESTAMPTZ,
      CHECK((status='pending' AND spent_amount IS NULL AND settled_at IS NULL AND settled_session_id IS NULL)
        OR (status='settled' AND spent_amount IS NOT NULL AND settled_at IS NOT NULL AND settled_session_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS cash_withdrawals_session_idx ON register_cash_withdrawals(session_id,created_at);
    ALTER TABLE register_cash_withdrawals ADD COLUMN IF NOT EXISTS return_denominations JSONB;
    CREATE TABLE IF NOT EXISTS register_cash_entries (
      id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES register_sessions(id),
      withdrawal_id UUID NOT NULL REFERENCES register_cash_withdrawals(id),
      kind TEXT NOT NULL CHECK(kind IN ('withdrawal','return')), amount NUMERIC(12,0) NOT NULL CHECK(amount>=0),
      created_by UUID NOT NULL REFERENCES app_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(withdrawal_id,kind)
    );
    CREATE INDEX IF NOT EXISTS cash_entries_session_idx ON register_cash_entries(session_id,created_at);
    CREATE INDEX IF NOT EXISTS cash_entries_date_idx ON register_cash_entries(created_at);
    CREATE TABLE IF NOT EXISTS register_cash_operations (
      id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id), kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result_id UUID NOT NULL REFERENCES register_cash_withdrawals(id)
    );
    DO $$ DECLARE target TEXT; BEGIN
      FOREACH target IN ARRAY ARRAY['register_sessions','register_cash_withdrawals','register_cash_entries'] LOOP
        IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(target) AND tgname='bakery_changed') THEN
          EXECUTE format('CREATE TRIGGER bakery_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bakery_notify_change()',target);
        END IF;
      END LOOP;
    END $$;
  `)
}
