import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import express from 'express'
import { once } from 'node:events'
import { createIntegrationStore } from './integration-store.js'
import { createStockReservationStore, cleanReservation, cleanConfirmation } from './stock-reservations.js'
import { createReservationRouter } from './reservation-api.js'

const key = () => crypto.randomUUID()
const line = (item, amount = '1.00') => ({ itemId: item.id, quantity: amount, unit: item.unit, unitPrice: item.price })
const cart = (items, externalReference = key()) => ({ externalReference, currency: 'CLP',
  expectedTotal: items.reduce((sum, l) => sum + Math.round(Number(l.quantity) * l.unitPrice), 0), items })

test('reservation inputs are strict decimal quotes without customer or provider secrets', () => {
  const valid = cart([{ itemId: key(), quantity: '1.25', unit: 'kg', unitPrice: 1000 }])
  assert.equal(cleanReservation(valid).expectedTotal, 1250)
  for (const quantity of [1, '1', '01.00', '0.00', '1.001', '-1.00', '10000.01']) assert.throws(() => cleanReservation({ ...valid, items: [{ ...valid.items[0], quantity }] }))
  assert.throws(() => cleanReservation({ ...valid, email: 'buyer@example.test' }))
  assert.throws(() => cleanReservation({ ...valid, items: [...valid.items, ...valid.items] }))
  for (const externalReference of [123, null, {}, 'bad reference']) assert.throws(() => cleanReservation({ ...valid, externalReference }))
  assert.throws(() => cleanConfirmation({ paymentAttemptId: key(), paymentReference: 123, amount: 1200, currency: 'CLP' }))
})

test('PostgreSQL reservations serialize with Caja, survive retries and never release uncertain payments', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `verify_reservations_${key().replaceAll('-', '')}`
  const originalDatabase = process.env.DATABASE_URL
  const connectionString = process.env.TEST_DATABASE_URL
  const ssl = !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false
  const admin = new pg.Client({ connectionString, ssl })
  let store, otherPool, server
  try {
    await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new URL(connectionString); isolated.searchParams.set('options', `-c search_path=${schema}`)
    process.env.DATABASE_URL = isolated.href
    store = await import(`./store.js?reservations=${key()}`)
    await store.initializeStore()
    const integrations = store.getInventoryIntegrationStore(); await integrations.initialize()
    otherPool = new pg.Pool({ connectionString: isolated.href, ssl })
    const otherIntegrations = createIntegrationStore({ pool: otherPool })
    const reservations = store.getStockReservationStore(), other = createStockReservationStore({ pool: otherPool })
    const first = await integrations.createClient({ name: 'Checkout', environment: 'test', expiresInDays: 90, reservationsEnabled: true })
    const second = await integrations.createClient({ name: 'Other checkout', environment: 'test', expiresInDays: 90, reservationsEnabled: true })
    const readonly = await integrations.createClient({ name: 'Read only', environment: 'test', expiresInDays: 90 })
    const actor = { id: first.client.id, environment: 'test' }, actor2 = { id: second.client.id, environment: 'test' }
    const product = async (quantity = 1, name = 'Reserved bread') => store.createItem({ name, category: 'Bread', unit: 'pieces', quantity, lowStockThreshold: 0, price: 1200, sellable: true, expiryDate: null, sku: '' })
    const balance = async id => Number((await otherPool.query('SELECT quantity FROM items WHERE id=$1', [id])).rows[0].quantity)
    const expire = id => otherPool.query("UPDATE stock_reservations SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [id])
    const newHold = async (item, amount = '1.00', instance = reservations, owner = actor) => (await instance.create(owner, key(), cart([line(item, amount)]))).reservation
    const release = (hold, instance = reservations, owner = actor) => instance.release(owner, hold.id, key(), { reason: 'checkout_cancelled' })
    const start = async (hold, instance = reservations, owner = actor) => { const attempt = key(); await instance.startPayment(owner, hold.id, key(), { paymentAttemptId: attempt }); return attempt }
    const paid = (hold, attempt, paymentReference = key()) => ({ paymentAttemptId: attempt, paymentReference, amount: hold.total.amount, currency: 'CLP' })

    await t.test('the last unit can be allocated by only one channel, including pending Point sales', async () => {
      for (let round = 0; round < 5; round++) {
        const item = await product()
        const race = await Promise.allSettled([reservations.create(actor, key(), cart([line(item)])), store.createSale([{ itemId: item.id, quantity: 1 }], 'cash', key())])
        assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
        assert.equal(race.find(result => result.status === 'rejected').reason.status, 409)
        assert.equal(await balance(item.id), 0)
        if (race[0].status === 'fulfilled') await release(race[0].value.reservation)
      }
      const item = await product(), point = await store.createSale([{ itemId: item.id, quantity: 1 }], 'card', key())
      await assert.rejects(newHold(item), { code: 'INSUFFICIENT_STOCK' })
      await store.markCardSaleFailed(point.id)
      const held = await newHold(item)
      await assert.rejects(store.createSale([{ itemId: item.id, quantity: 1 }], 'card', key()), error => error.status === 409)
      await release(held)
    })

    await t.test('independent checkout clients compete on the same product row locks', async () => {
      const item = await product()
      const attempts = await Promise.allSettled([newHold(item), newHold(item, '1.00', other, actor2)])
      assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(await balance(item.id), 0)
      const winner = attempts.findIndex(r => r.status === 'fulfilled')
      await release(attempts[winner].value, winner ? other : reservations, winner ? actor2 : actor)
      assert.equal(await balance(item.id), 1)
    })

    await t.test('idempotent reservation, payment start and approval never deduct twice', async () => {
      const item = await product(2), requestKey = key(), body = cart([line(item)])
      const requests = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? other : reservations).create(actor, requestKey, body)))
      const held = requests[0].reservation
      assert.equal(new Set(requests.map(r => r.reservation.id)).size, 1)
      assert.equal(requests.filter(r => !r.replayed).length, 1)
      assert.equal(await balance(item.id), 1)
      await assert.rejects(reservations.create(actor, requestKey, { ...body, expectedTotal: 2400, items: [line(item, '2.00')] }), { code: 'IDEMPOTENCY_CONFLICT' })
      await assert.rejects(reservations.create(actor, key(), body), { code: 'EXTERNAL_REFERENCE_EXISTS' })
      const attempt = await start(held)
      await expire(held.id)
      await Promise.all([reservations.expire(), other.expire()])
      assert.equal((await reservations.get(actor, held.id)).status, 'payment_pending')
      const payment = paid(held, attempt), confirmKey = key()
      const approvals = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? other : reservations).confirm(actor, held.id, confirmKey, payment)))
      assert.ok(approvals.every(result => result.reservation.status === 'confirmed'))
      await other.confirm(actor, held.id, key(), payment)
      assert.equal(await balance(item.id), 1)
      assert.equal((await otherPool.query('SELECT count(*)::int AS count FROM movements WHERE reservation_id=$1', [held.id])).rows[0].count, 1)
      await assert.rejects(release(held), { code: 'ALREADY_CONFIRMED' })
      await assert.rejects(other.confirm(actor, held.id, key(), paid(held, attempt)), { code: 'PAYMENT_MISMATCH' })
      const next = await newHold(item), nextAttempt = await start(next)
      await assert.rejects(other.confirm(actor, next.id, key(), paid(next, nextAttempt, payment.paymentReference)), { code: 'PAYMENT_ALREADY_USED' })
      await reservations.release(actor, next.id, key(), { reason: 'payment_rejected', paymentAttemptId: nextAttempt, outcomeVerified: true })
    })

    await t.test('cart and quote failures roll back every line; held prices survive later edits', async () => {
      const a = await product(), b = await product()
      await assert.rejects(reservations.create(actor, key(), cart([line(a), line(b, '2.00')])), { code: 'INSUFFICIENT_STOCK' })
      assert.equal(await balance(a.id), 1); assert.equal(await balance(b.id), 1)
      for (const input of [{ ...line(a), unitPrice: 1300 }, { ...line(a), unit: 'kg' }]) await assert.rejects(reservations.create(actor, key(), cart([input])), { code: 'QUOTE_CHANGED' })
      await assert.rejects(reservations.create(actor, key(), { ...cart([line(a)]), expectedTotal: 1300 }), { code: 'QUOTE_CHANGED' })
      const held = await newHold(a)
      await assert.rejects(store.adjustItem(a.id, { type: 'adjustment', quantity: 5 }), { code: 'ACTIVE_RESERVATIONS' })
      await assert.rejects(store.saveInventoryBatch({ type: 'adjustment', items: [{ itemId: a.id, quantity: 5, expectedQuantity: 0 }, { itemId: b.id, quantity: 10, expectedQuantity: 1 }] }, key()), { code: 'ACTIVE_RESERVATIONS' })
      assert.equal(await balance(b.id), 1)
      await assert.rejects(store.deleteItem(a.id), { code: 'ACTIVE_RESERVATIONS' })
      await assert.rejects(otherPool.query('DELETE FROM items WHERE id=$1', [a.id]), error => error.constraint === 'active_online_reservations')
      await assert.rejects(otherPool.query("UPDATE items SET unit='kg' WHERE id=$1", [a.id]), error => error.constraint === 'active_online_reservations')
      await assert.rejects(otherPool.query('UPDATE items SET quantity=9999999999.99 WHERE id=$1', [a.id]), error => error.constraint === 'online_stock_capacity')
      await assert.rejects(otherPool.query('TRUNCATE items CASCADE'), error => error.constraint === 'active_online_reservations')
      await otherPool.query('UPDATE items SET price=1500,sellable=FALSE WHERE id=$1', [a.id])
      await store.adjustItem(a.id, { type: 'stock_in', quantity: 1 })
      const attempt = await start(held)
      await reservations.confirm(actor, held.id, key(), paid(held, attempt))
      assert.equal(await balance(a.id), 1)
      assert.equal((await reservations.get(actor, held.id)).total.amount, 1200)
      await otherPool.query("UPDATE items SET expiry_date='2020-01-01' WHERE id=$1", [b.id])
      await assert.rejects(newHold(b), { code: 'PRODUCT_UNAVAILABLE' })
    })

    await t.test('expiration and release race safely across workers, restoring only once', async () => {
      const item = await product(), held = await newHold(item)
      await expire(held.id)
      await assert.rejects(reservations.startPayment(actor, held.id, key(), { paymentAttemptId: key() }), { code: 'RESERVATION_EXPIRED' })
      await Promise.all([reservations.expire(), other.expire(), release(held)])
      assert.equal(await balance(item.id), 1)
      assert.ok(['expired', 'released'].includes((await reservations.get(actor, held.id)).status))
      await release(held); await other.expire()
      assert.equal(await balance(item.id), 1)
      assert.equal((await otherPool.query('SELECT count(*)::int AS count FROM movements WHERE reservation_id=$1', [held.id])).rows[0].count, 2)
    })

    await t.test('uncertain payments stay held until the owning checkout or administrator reconciles them', async () => {
      const item = await product(), held = await newHold(item), attempt = await start(held)
      await assert.rejects(release(held), { code: 'PAYMENT_UNRESOLVED' })
      await assert.rejects(reservations.release(actor, held.id, key(), { reason: 'payment_rejected', paymentAttemptId: key(), outcomeVerified: true }), { code: 'PAYMENT_UNRESOLVED' })
      await assert.rejects(integrations.setReservationAccess(actor.id, 'test', false), { code: 'ACTIVE_RESERVATIONS' })
      await assert.rejects(integrations.deleteClient(actor.id, 'test'), { code: 'ACTIVE_RESERVATIONS' })
      await assert.rejects(other.get(actor2, held.id), { status: 404 })
      await assert.rejects(other.release(actor2, held.id, key(), { reason: 'checkout_cancelled' }), { status: 404 })
      await assert.rejects(other.create({ ...actor, environment: 'production' }, key(), cart([line(item)])), { status: 403 })
      await reservations.releaseAsAdmin('test', held.id, key(), { reason: 'payment_cancelled', paymentAttemptId: attempt, outcomeVerified: true })
      assert.equal(await balance(item.id), 1)
      await assert.rejects(reservations.confirm(actor, held.id, key(), paid(held, attempt)), { code: 'RESERVATION_NOT_PAYABLE' })
    })

    await t.test('HTTP enforces permissions, ownership, JSON limits, feature flag and revocation', async () => {
      integrations.consumeLimits = async () => 0 // Quota concurrency is tested separately against PostgreSQL.
      const config = { enabled: true, environment: 'test', reservationsEnabled: true }
      const app = express(); app.use('/reservations', createReservationRouter({ getIntegrations: () => integrations, getReservations: () => reservations, config }))
      server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
      const url = `http://127.0.0.1:${server.address().port}/reservations`
      const request = (route = '', { token = first.token, body, method = body ? 'POST' : 'GET', idempotencyKey = key(), headers = {} } = {}) => fetch(url + route, {
        method, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const item = await product(2), input = cart([line(item)])
      assert.equal((await request('', { body: input, token: '' })).status, 401)
      assert.equal((await request('', { body: input, token: readonly.token })).status, 403)
      assert.equal((await request('', { body: input, idempotencyKey: '' })).status, 400)
      const broken = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key() }, body: '{' })
      assert.equal(broken.status, 400)
      assert.equal((await broken.json()).error.code, 'INVALID_REQUEST')
      assert.equal((await request('', { body: { ...input, unsupported: 'x'.repeat(17000) } })).status, 413)
      const response = await request('', { body: input })
      assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.match(response.headers.get('vary'), /Authorization/)
      const hold = await response.json()
      const abandoned = (await reservations.create(actor, key(), cart([line(item)]))).reservation
      const paymentAttemptId = key()
      assert.equal((await request(`/${hold.id}/payment-pending`, { body: { paymentAttemptId } })).status, 200)
      assert.equal((await request(`/${hold.id}`, { token: second.token })).status, 404)
      assert.equal((await request(`/${hold.id}`, { method: 'HEAD' })).status, 405)
      config.reservationsEnabled = false
      assert.equal((await request(`/${hold.id}`)).status, 200)
      assert.equal((await request('', { body: input })).status, 503)
      assert.equal((await request(`/${abandoned.id}/payment-pending`, { body: { paymentAttemptId: key() } })).status, 503)
      assert.equal((await request(`/${hold.id}/confirm`, { body: paid(hold, paymentAttemptId) })).status, 200)
      assert.equal((await request(`/${abandoned.id}/release`, { body: { reason: 'checkout_cancelled' } })).status, 200)
      assert.equal(await balance(item.id), 1)
      config.reservationsEnabled = true
      await otherIntegrations.revokeKey(first.client.id, first.key.id, 'test')
      assert.equal((await request(`/${hold.id}`, { headers: { 'If-None-Match': '*' } })).status, 401)
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null
    })
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    process.env.DATABASE_URL = originalDatabase || ''
    await otherPool?.end(); await store?.closeStore()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
