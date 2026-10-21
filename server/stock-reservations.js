import crypto from 'node:crypto'
import { dateOnly } from '../src/dates.js'
import { businessDateAt } from './cash-closure.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const maximumMoney = 999999999999n
export const reservationError = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code })
export const activeStockHold = "r.inventory_applied AND r.status IN ('held','payment_pending')"

export function reservationId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw reservationError('Invalid UUID.')
  return value.toLowerCase()
}
function objectInput(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw reservationError('Invalid reservation parameters.')
}
function money(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > Number(maximumMoney)) throw reservationError('Use positive whole CLP amounts.')
  return value
}
function quantity(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,4})\.[0-9]{2}$/.test(value)) throw reservationError('Quantity must be a decimal string with two places.')
  const hundredths = BigInt(value.replace('.', ''))
  if (hundredths < 1n || hundredths > 1000000n) throw reservationError('Quantity must be between 0.01 and 10000.00.')
  return value
}
export function cleanReservation(body) {
  objectInput(body, ['externalReference', 'items', 'currency', 'expectedTotal'])
  if (typeof body.externalReference !== 'string' || !reference.test(body.externalReference) || body.currency !== 'CLP' || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw reservationError('Invalid external reference, currency or cart.')
  const seen = new Set()
  const items = body.items.map(line => {
    objectInput(line, ['itemId', 'quantity', 'unit', 'unitPrice'])
    const itemId = reservationId(line.itemId)
    if (seen.has(itemId) || typeof line.unit !== 'string' || !line.unit || line.unit.length > 80) throw reservationError('Invalid or repeated product.')
    seen.add(itemId)
    return { itemId, quantity: quantity(line.quantity), unit: line.unit, unitPrice: money(line.unitPrice) }
  }).sort((a, b) => a.itemId.localeCompare(b.itemId))
  return { externalReference: body.externalReference, items, currency: 'CLP', expectedTotal: money(body.expectedTotal) }
}
export function cleanPaymentStart(body) {
  objectInput(body, ['paymentAttemptId'])
  return { paymentAttemptId: reservationId(body.paymentAttemptId) }
}
export function cleanConfirmation(body) {
  objectInput(body, ['paymentAttemptId', 'paymentReference', 'amount', 'currency'])
  if (typeof body.paymentReference !== 'string' || !reference.test(body.paymentReference) || body.currency !== 'CLP') throw reservationError('Invalid payment reference or currency.')
  return { paymentAttemptId: reservationId(body.paymentAttemptId), paymentReference: body.paymentReference, amount: money(body.amount), currency: 'CLP' }
}
export function cleanRelease(body) {
  objectInput(body, ['reason', 'paymentAttemptId', 'outcomeVerified'])
  if (!['checkout_cancelled', 'payment_rejected', 'payment_cancelled', 'payment_not_created'].includes(body.reason) ||
      body.outcomeVerified != null && typeof body.outcomeVerified !== 'boolean') throw reservationError('Invalid release outcome.')
  return { reason: body.reason, paymentAttemptId: body.paymentAttemptId == null ? null : reservationId(body.paymentAttemptId), outcomeVerified: body.outcomeVerified === true }
}

export async function heldStock(queryable, itemIds) {
  const { rows } = await queryable.query(`SELECT l.product_id,SUM(l.quantity) AS quantity FROM stock_reservation_lines l
    JOIN stock_reservations r ON r.id=l.reservation_id WHERE l.product_id=ANY($1::uuid[]) AND ${activeStockHold} GROUP BY l.product_id`, [itemIds])
  return new Map(rows.map(row => [row.product_id, Number(row.quantity)]))
}
export async function assertNoStockHolds(queryable, itemIds) {
  if ([...await heldStock(queryable, itemIds)].some(([, amount]) => amount > 0)) throw reservationError('Hay reservas online pendientes. Resuélvelas antes de contar o eliminar el producto.', 409, 'ACTIVE_RESERVATIONS')
}
export async function assertClientHasNoStockHolds(queryable, clientId) {
  // Integration-store also runs independently in setup tools and migration tests.
  if (!(await queryable.query("SELECT to_regclass('stock_reservations') AS relation")).rows[0].relation) return
  const active = await queryable.query(`SELECT 1 FROM stock_reservations r WHERE r.client_id=$1 AND ${activeStockHold} LIMIT 1`, [clientId])
  if (active.rowCount) throw reservationError('Resuelve las reservas pendientes antes de desactivar o eliminar la integración.', 409, 'ACTIVE_RESERVATIONS')
}

export async function initializeStockReservations(pool) {
  if (!pool) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_reservations (
      id UUID PRIMARY KEY, client_id UUID NOT NULL, client_name TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('test','production')), external_reference TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('held','payment_pending','confirmed','released','expired')),
      total NUMERIC(12,0) NOT NULL CHECK(total>0), currency TEXT NOT NULL DEFAULT 'CLP' CHECK(currency='CLP'),
      inventory_applied BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ NOT NULL,
      payment_attempt_id UUID, payment_reference TEXT, release_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payment_started_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ, released_at TIMESTAMPTZ,
      UNIQUE(client_id,external_reference), UNIQUE(client_id,payment_reference),
      CHECK ((status IN ('held','payment_pending','confirmed') AND inventory_applied) OR (status IN ('released','expired') AND NOT inventory_applied))
    );
    CREATE INDEX IF NOT EXISTS stock_reservation_expiry_idx ON stock_reservations(expires_at) WHERE status='held';
    CREATE INDEX IF NOT EXISTS stock_reservation_client_idx ON stock_reservations(client_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS stock_reservation_lines (
      reservation_id UUID NOT NULL REFERENCES stock_reservations(id), product_id UUID NOT NULL,
      item_id UUID REFERENCES items(id) ON DELETE SET NULL, item_name TEXT NOT NULL, unit TEXT NOT NULL,
      quantity NUMERIC(12,2) NOT NULL CHECK(quantity>0), unit_price NUMERIC(12,0) NOT NULL CHECK(unit_price>0),
      line_total NUMERIC(12,0) NOT NULL CHECK(line_total>0), PRIMARY KEY(reservation_id,product_id)
    );
    CREATE INDEX IF NOT EXISTS stock_reservation_product_idx ON stock_reservation_lines(product_id);
    CREATE TABLE IF NOT EXISTS stock_reservation_operations (
      client_id UUID NOT NULL, idempotency_key UUID NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL,
      reservation_id UUID NOT NULL REFERENCES stock_reservations(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(client_id,idempotency_key)
    );
    ALTER TABLE movements ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES stock_reservations(id);
    CREATE OR REPLACE FUNCTION bakery_protect_web_holds() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE held NUMERIC;
    BEGIN
      SELECT COALESCE(SUM(l.quantity),0) INTO held FROM stock_reservation_lines l
        JOIN stock_reservations r ON r.id=l.reservation_id
        WHERE l.product_id=OLD.id AND r.inventory_applied AND r.status IN ('held','payment_pending');
      IF TG_OP='DELETE' THEN
        IF held>0 THEN RAISE EXCEPTION 'Product has active online reservations' USING ERRCODE='23514',CONSTRAINT='active_online_reservations'; END IF;
        RETURN OLD;
      END IF;
      IF held>0 AND NEW.unit<>OLD.unit THEN RAISE EXCEPTION 'Product has active online reservations' USING ERRCODE='23514',CONSTRAINT='active_online_reservations'; END IF;
      IF NEW.quantity+held>9999999999.99 THEN RAISE EXCEPTION 'Stock including online holds exceeds the quantity limit' USING ERRCODE='23514',CONSTRAINT='online_stock_capacity'; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS bakery_protect_web_holds ON items;
    CREATE TRIGGER bakery_protect_web_holds BEFORE DELETE OR UPDATE OF quantity,unit ON items FOR EACH ROW EXECUTE FUNCTION bakery_protect_web_holds();
    CREATE OR REPLACE FUNCTION bakery_protect_web_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM stock_reservations WHERE inventory_applied AND status IN ('held','payment_pending')) THEN
        RAISE EXCEPTION 'Active online reservations prevent inventory replacement' USING ERRCODE='23514',CONSTRAINT='active_online_reservations';
      END IF;
      RETURN NULL;
    END $$;
    DROP TRIGGER IF EXISTS bakery_protect_web_truncate ON items;
    CREATE TRIGGER bakery_protect_web_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION bakery_protect_web_truncate();
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='stock_reservations'::regclass AND tgname='bakery_changed') THEN
        CREATE TRIGGER bakery_changed AFTER INSERT OR UPDATE OR DELETE ON stock_reservations FOR EACH STATEMENT EXECUTE FUNCTION bakery_notify_change();
      END IF;
    END $$;
  `)
}

const selectReservation = `SELECT r.*,COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.product_id)
  FROM stock_reservation_lines l WHERE l.reservation_id=r.id),'[]') AS lines FROM stock_reservations r`
const iso = value => value == null ? null : new Date(value).toISOString()
function representation(row) {
  return { id: row.id, externalReference: row.external_reference, status: row.status,
    total: { amount: Number(row.total), currency: 'CLP' }, inventoryApplied: row.inventory_applied,
    expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    paymentAttemptId: row.payment_attempt_id, paymentReference: row.payment_reference, releaseReason: row.release_reason,
    paymentStartedAt: iso(row.payment_started_at), confirmedAt: iso(row.confirmed_at), releasedAt: iso(row.released_at),
    items: row.lines.map(line => ({ itemId: line.product_id, name: line.item_name, unit: line.unit,
      quantity: Number(line.quantity).toFixed(2), unitPrice: Number(line.unit_price), lineTotal: Number(line.line_total) })) }
}

export function createStockReservationStore({ pool, ttlSeconds = 900, maxActive = 50 }) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 1800 || !Number.isInteger(maxActive) || maxActive < 1 || maxActive > 1000) throw new Error('Invalid reservation policy.')
  const requirePostgres = () => { if (!pool) throw reservationError('Reservations require PostgreSQL.', 503, 'SERVICE_UNAVAILABLE') }
  const transaction = async callback => {
    requirePostgres()
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const read = async (db, id, clientId, lock = false) => {
    const { rows } = await db.query(`${selectReservation} WHERE r.id=$1 ${clientId ? 'AND r.client_id=$2' : ''} ${lock ? 'FOR UPDATE OF r' : ''}`, clientId ? [id, clientId] : [id])
    if (!rows[0]) throw reservationError('Reservation not found.', 404, 'NOT_FOUND')
    return rows[0]
  }
  const operate = (actor, action, id, key, body, callback, admin = false) => {
    key = reservationId(key)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ action, id, body })).digest('hex')
    return transaction(async db => {
      // A stable client lock serializes retries and ownership/permission changes.
      const owner = (await db.query('SELECT * FROM integration_clients WHERE id=$1 AND environment=$2 FOR UPDATE', [actor.id, actor.environment])).rows[0]
      if (!owner || !admin && !owner.scopes.includes('inventory:reserve')) throw reservationError('Reservation permission required.', 403, 'FORBIDDEN')
      const previous = (await db.query('SELECT * FROM stock_reservation_operations WHERE client_id=$1 AND idempotency_key=$2', [actor.id, key])).rows[0]
      if (previous) {
        if (previous.action !== action || previous.fingerprint !== fingerprint) throw reservationError('Idempotency key already used for another operation.', 409, 'IDEMPOTENCY_CONFLICT')
        return { reservation: representation(await read(db, previous.reservation_id, actor.id)), replayed: true }
      }
      const resultId = await callback(db, owner)
      await db.query('INSERT INTO stock_reservation_operations(client_id,idempotency_key,action,fingerprint,reservation_id) VALUES($1,$2,$3,$4,$5)', [actor.id, key, action, fingerprint, resultId])
      return { reservation: representation(await read(db, resultId, actor.id)), replayed: false }
    })
  }
  const lockItems = async (db, lines) => {
    const { rows } = await db.query('SELECT * FROM items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [lines.map(line => line.product_id || line.itemId)])
    if (rows.length !== lines.length) throw reservationError('A reserved product no longer exists.', 409, 'STOCK_CHANGED')
    return rows
  }
  const changeStock = async (db, row, direction, reason) => {
    const updated = await db.query(`UPDATE items i SET quantity=i.quantity+l.quantity*$2,updated_at=clock_timestamp()
      FROM stock_reservation_lines l WHERE l.reservation_id=$1 AND i.id=l.product_id RETURNING i.id,i.quantity`, [row.id, direction])
    const balances = new Map(updated.rows.map(item => [item.id, item.quantity]))
    for (const line of row.lines) await db.query(`INSERT INTO movements(id,item_id,item_name,type,quantity,balance_after,note,reservation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [crypto.randomUUID(), line.product_id, line.item_name,
      direction === 1 ? 'stock_in' : 'stock_out', Number(line.quantity) * direction, balances.get(line.product_id), reason, row.id])
  }
  const releaseInTransaction = async (db, row, status, reason) => {
    await lockItems(db, row.lines)
    // Remove the hold before restoring its units, inside the same transaction.
    await db.query('UPDATE stock_reservations SET status=$2,inventory_applied=FALSE,release_reason=$3,released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1', [row.id, status, reason])
    await changeStock(db, row, 1, `${status === 'expired' ? 'Reserva online vencida' : 'Reserva online liberada'} #${row.external_reference}`)
  }
  const release = (actor, id, key, input, admin = false) => {
    id = reservationId(id)
    const body = cleanRelease(input)
    return operate(actor, 'release', id, key, body, async db => {
      const row = await read(db, id, actor.id, true)
      if (row.status === 'confirmed') throw reservationError('A confirmed reservation cannot be released.', 409, 'ALREADY_CONFIRMED')
      if (['released', 'expired'].includes(row.status)) return id
      if (row.status === 'payment_pending' && (!body.outcomeVerified || body.reason === 'checkout_cancelled' || body.paymentAttemptId !== row.payment_attempt_id)) throw reservationError('Reconcile the payment before releasing its stock.', 409, 'PAYMENT_UNRESOLVED')
      await releaseInTransaction(db, row, 'released', body.reason)
      return id
    }, admin)
  }
  return {
    persistent: Boolean(pool),
    policy: { ttlSeconds, maxActivePerClient: maxActive, paymentPendingExpiresAutomatically: false },
    async get(actor, id) { requirePostgres(); return representation(await read(pool, reservationId(id), actor.id)) },
    async list(environment) {
      if (!pool) return []
      const { rows } = await pool.query(`${selectReservation} WHERE r.environment=$1
        ORDER BY CASE WHEN r.status='payment_pending' THEN 0 WHEN r.status='held' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 100`, [environment])
      return rows.map(row => ({ ...representation(row), clientId: row.client_id, clientName: row.client_name }))
    },
    create(actor, key, input) {
      const body = cleanReservation(input)
      return operate(actor, 'create', null, key, body, async (db, owner) => {
        const existing = await db.query('SELECT id FROM stock_reservations WHERE client_id=$1 AND external_reference=$2', [actor.id, body.externalReference])
        if (existing.rowCount) throw reservationError('External reference already has a reservation. Reuse its original idempotency key.', 409, 'EXTERNAL_REFERENCE_EXISTS')
        const count = (await db.query(`SELECT count(*)::int AS count FROM stock_reservations r WHERE r.client_id=$1 AND ${activeStockHold}`, [actor.id])).rows[0].count
        if (count >= maxActive) throw reservationError('Too many unresolved reservations.', 409, 'RESERVATION_LIMIT')
        const rows = await lockItems(db, body.items)
        const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now
        const today = businessDateAt(new Date(now))
        let total = 0n
        const lines = body.items.map(line => {
          const item = rows.find(row => row.id === line.itemId)
          if (!item.sellable || Number(item.price) <= 0 || dateOnly(item.expiry_date) && dateOnly(item.expiry_date) < today) throw reservationError('Product is not available for online sale.', 409, 'PRODUCT_UNAVAILABLE')
          if (Number(item.price) !== line.unitPrice || item.unit !== line.unit) throw reservationError('Price or unit changed. Ask the buyer to accept the updated cart.', 409, 'QUOTE_CHANGED')
          if (Number(item.quantity) < Number(line.quantity)) throw reservationError('Insufficient stock.', 409, 'INSUFFICIENT_STOCK')
          const cents = BigInt(line.quantity.replace('.', ''))
          const lineTotal = (BigInt(item.price) * cents + 50n) / 100n
          if (lineTotal < 1n || lineTotal > maximumMoney) throw reservationError('Cart amount is outside the supported range.')
          total += lineTotal
          return { ...line, name: item.name, lineTotal: Number(lineTotal) }
        })
        if (total > maximumMoney || total !== BigInt(body.expectedTotal)) throw reservationError('Cart total changed. Ask the buyer to accept the updated cart.', 409, 'QUOTE_CHANGED')
        const id = crypto.randomUUID()
        await db.query(`INSERT INTO stock_reservations(id,client_id,client_name,environment,external_reference,status,total,expires_at)
          VALUES($1,$2,$3,$4,$5,'held',$6,clock_timestamp()+$7*INTERVAL '1 second')`, [id, actor.id, owner.name, owner.environment, body.externalReference, Number(total), ttlSeconds])
        for (const line of lines) {
          await db.query('UPDATE items SET quantity=quantity-$2,updated_at=clock_timestamp() WHERE id=$1', [line.itemId, line.quantity])
          await db.query(`INSERT INTO stock_reservation_lines(reservation_id,product_id,item_id,item_name,unit,quantity,unit_price,line_total)
            VALUES($1,$2,$2,$3,$4,$5,$6,$7)`, [id, line.itemId, line.name, line.unit, line.quantity, line.unitPrice, line.lineTotal])
        }
        const row = await read(db, id, actor.id)
        // Quantities are already deducted; only append their accounting movement.
        const balances = new Map((await db.query('SELECT id,quantity FROM items WHERE id=ANY($1::uuid[])', [lines.map(l => l.itemId)])).rows.map(i => [i.id, i.quantity]))
        for (const line of row.lines) await db.query(`INSERT INTO movements(id,item_id,item_name,type,quantity,balance_after,note,reservation_id)
          VALUES($1,$2,$3,'stock_out',$4,$5,$6,$7)`, [crypto.randomUUID(), line.product_id, line.item_name, -Number(line.quantity), balances.get(line.product_id), `Reserva online #${body.externalReference}`, id])
        return id
      })
    },
    startPayment(actor, id, key, input) {
      id = reservationId(id)
      const body = cleanPaymentStart(input)
      return operate(actor, 'payment_pending', id, key, body, async db => {
        const row = await read(db, id, actor.id, true)
        if (row.status === 'payment_pending' && row.payment_attempt_id === body.paymentAttemptId) return id
        if (row.status !== 'held') throw reservationError('Reservation cannot start another payment.', 409, 'RESERVATION_NOT_HELD')
        if ((await db.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.expires_at])).rows[0].expired) throw reservationError('Reservation expired before payment started.', 409, 'RESERVATION_EXPIRED')
        await db.query("UPDATE stock_reservations SET status='payment_pending',payment_attempt_id=$2,payment_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id, body.paymentAttemptId])
        return id
      })
    },
    confirm(actor, id, key, input) {
      id = reservationId(id)
      const body = cleanConfirmation(input)
      return operate(actor, 'confirm', id, key, body, async db => {
        const row = await read(db, id, actor.id, true)
        if (row.payment_attempt_id !== body.paymentAttemptId || Number(row.total) !== body.amount) throw reservationError('Payment does not match this reservation.', 409, 'PAYMENT_MISMATCH')
        if (row.status === 'confirmed') {
          if (row.payment_reference !== body.paymentReference) throw reservationError('Reservation already confirmed with a different payment.', 409, 'PAYMENT_MISMATCH')
          return id
        }
        if (row.status !== 'payment_pending') throw reservationError('Reservation is not held for this payment. Reconcile or refund the payment in the checkout.', 409, 'RESERVATION_NOT_PAYABLE')
        const used = await db.query('SELECT 1 FROM stock_reservations WHERE client_id=$1 AND payment_reference=$2 AND id<>$3', [actor.id, body.paymentReference, id])
        if (used.rowCount) throw reservationError('Payment already confirmed another reservation.', 409, 'PAYMENT_ALREADY_USED')
        await db.query("UPDATE stock_reservations SET status='confirmed',payment_reference=$2,confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id, body.paymentReference])
        return id
      })
    },
    release,
    async releaseAsAdmin(environment, id, key, input) {
      requirePostgres()
      const row = await read(pool, reservationId(id))
      return release({ id: row.client_id, environment }, id, key, input, true)
    },
    async expire(limit = 50) {
      if (!pool) return 0
      const expired = await pool.query("SELECT id FROM stock_reservations WHERE status='held' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1", [limit])
      let count = 0
      for (const entry of expired.rows) count += await transaction(async db => {
        const row = (await db.query(`${selectReservation} WHERE r.id=$1 AND r.status='held' AND r.expires_at<=clock_timestamp() FOR UPDATE OF r SKIP LOCKED`, [entry.id])).rows[0]
        if (!row) return 0
        await releaseInTransaction(db, row, 'expired', 'reservation_expired')
        return 1
      })
      return count
    },
  }
}
