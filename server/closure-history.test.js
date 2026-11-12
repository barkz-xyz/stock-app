import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { businessDateAt, cleanClosureInput, closureHistoryQuery, createClosure } from './cash-closure.js'
import { postgresConfig } from './postgres.js'

test('monthly close boundaries use Chile time and reject invalid months and pages', () => {
  const september = closureHistoryQuery({ month: '2026-09' })
  assert.equal(september.from.toISOString(), '2026-09-01T04:00:00.000Z')
  assert.equal(september.to.toISOString(), '2026-10-01T03:00:00.000Z')
  assert.equal(closureHistoryQuery({ month: '2024-02' }).nextDate, '2024-03-01')
  for (const month of ['', '2026-00', '2026-13', '2026-9', '1999-12', '9999-01', ['2026-09']]) assert.throws(() => closureHistoryQuery({ month }), { status: 400 })
  for (const input of [{ offset: '-1' }, { offset: '1.5' }, { offset: 1000001 }, { limit: 0 }, { limit: 101 }]) assert.throws(() => closureHistoryQuery(input), { status: 400 })
})

for (const postgres of [false, true]) test(`monthly history and corrections preserve owner access and earlier revisions (${postgres ? 'PostgreSQL' : 'JSON'})`,
  { skip: postgres && !process.env.TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_PATH: process.env.DATA_PATH }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-closure-history-'))
    const schema = 'verify_closures_' + crypto.randomUUID().replaceAll('-', '')
    let db, store
    try {
      if (postgres) {
        db = new pg.Client(postgresConfig(process.env.TEST_DATABASE_URL)); await db.connect()
        await db.query(`CREATE SCHEMA "${schema}"`); await db.query(`SET search_path TO "${schema}"`)
        const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`)
        process.env.DATABASE_URL = url.href
      } else delete process.env.DATABASE_URL
      process.env.DATA_PATH = path.join(temp, 'data.json'); process.env.SEED_DEMO_DATA = 'false'
      store = await import(`./store.js?closure-history=${crypto.randomUUID()}`); await store.initializeStore()
      const user = (username, role = 'cashier') => store.createUser({ username, name: username, role, password: 'Local-Closure-2026' })
      const owner = await user('closure.owner'), other = await user('closure.other'), admin = await user('closure.admin', 'admin')
      const form = async (actor, id, extra = {}) => {
        const work = await store.getRegisterClosure(actor, id)
        return { countedCash: 1000, cashIn: 0, cashOut: 0, note: '', fingerprint: work.live.fingerprint, expectedRevision: work.closure?.revision || 0, ...extra }
      }
      const openAndClose = async actor => {
        const session = await store.openRegisterSession(actor, 1000)
        await store.saveRegisterClosure(actor, session.id, await form(actor, session.id))
        return session
      }
      const shift = await openAndClose(owner), foreign = await openAndClose(other)
      const moveClose = async (session, closedAt, actor) => {
        const latest = await store.getRegisterClosureRevision(actor, session.id, 1)
        const openedAt = new Date(new Date(closedAt).getTime() - 3600000).toISOString()
        const snapshot = { ...latest.snapshot, businessDate: businessDateAt(openedAt), from: openedAt }
        const { fingerprint, ...values } = snapshot
        snapshot.fingerprint = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')
        const closure = { ...latest, businessDate: snapshot.businessDate, openedAt, closedAt, snapshot, history: [] }
        if (db) await db.query('UPDATE register_sessions SET opened_at=$2,closed_at=$3,closure=$4,business_date=$5 WHERE id=$1', [session.id, openedAt, closedAt, JSON.stringify(closure), businessDateAt(openedAt)])
        else {
          const data = JSON.parse(await fs.readFile(process.env.DATA_PATH, 'utf8'))
          Object.assign(data.registerSessions.find(s => s.id === session.id), { openedAt, closedAt, closure, businessDate:businessDateAt(openedAt) })
          await fs.writeFile(process.env.DATA_PATH, JSON.stringify(data))
        }
      }
      await moveClose(shift, '2026-10-01T02:59:59.999Z', owner)
      await moveClose(foreign, '2026-10-01T04:00:00.000Z', other)
      const dailyDate = '2026-09-30'
      const { live } = await store.getCashClosureWorkspace(dailyDate)
      const daily = createClosure(live, cleanClosureInput({
        businessDate: dailyDate, openingCash: 0, cashIn: 0, cashOut: 0, countedCash: 0,
        operator: 'General diario', note: '', expectedRevision: 0, fingerprint: live.fingerprint,
      }), null)
      if (db) {
        await db.query('INSERT INTO cash_closures (id,business_date,closed_at,details) VALUES ($1,$2,$3,$4)',
          [daily.id, daily.businessDate, daily.closedAt, { current: daily, history: [] }])
      } else {
        const data = JSON.parse(await fs.readFile(process.env.DATA_PATH, 'utf8'))
        data.cashClosures.push(daily)
        await fs.writeFile(process.env.DATA_PATH, JSON.stringify(data))
      }
      assert.deepEqual(await store.getCashClosureRevision(dailyDate, 1), JSON.parse(JSON.stringify({ webSales: 0, ...daily })))


      await t.test('cashiers see only their closes; admins also see daily closes and all operators', async () => {
        const own = await store.listClosureHistory(owner, { month: '2026-09' })
        assert.equal(own.total, 1); assert.equal(own.entries[0].id, shift.id)
        assert.equal((await store.listClosureHistory(owner, { month: '2026-10' })).total, 0)
        const oct = await store.listClosureHistory(other, { month: '2026-10' })
        assert.equal(oct.total, 1); assert.equal(oct.entries[0].id, foreign.id)
        assert.equal((await store.listClosureHistory(admin, { month: '2026-09' })).total, 2)
        assert.equal((await store.listClosureHistory(admin, { month: '2026-10' })).total, 1)
        assert.equal(own.entries[0].snapshot, undefined)
        await assert.rejects(store.getRegisterClosure(other, shift.id), { status: 404 })
        await assert.rejects(store.saveRegisterClosure(other, shift.id, {}), { status: 404 })
        await assert.rejects(store.getRegisterClosureRevision(other, shift.id, 1), { status: 404 })
      })
      await t.test('an owner can correct a closed session without reopening it or changing another session opening', async () => {
        const next = await store.openRegisterSession(owner, await store.getRegisterOpening(owner))
        const old = await store.getRegisterClosureRevision(owner, shift.id, 1)
        const input = await form(owner, shift.id, { countedCash: 1100, note: 'Corrección del conteo.' })
        await assert.rejects(store.saveRegisterClosure(owner, shift.id, { ...input, note: '' }), { status: 400 })
        const updated = await store.saveRegisterClosure(owner, shift.id, input)
        assert.equal(updated.revision, 2); assert.equal(updated.closedBy, owner.id); assert.equal(updated.closedByName, owner.name)
        assert.equal(updated.countedCash, 1100); assert.equal(updated.difference, 100)
        assert.deepEqual(await store.getRegisterClosureRevision(owner, shift.id, 1), old)
        assert.deepEqual(updated.snapshot, old.snapshot)
        assert.equal(new Date((await store.getRegisterClosure(owner, shift.id)).session.closedAt).toISOString(), '2026-10-01T02:59:59.999Z')
        assert.equal((await store.getActiveRegisterSession(owner)).id, next.id)
        assert.equal((await store.getActiveRegisterSession(owner)).openingCash, 1000)
        await assert.rejects(store.saveRegisterClosure(owner, shift.id, input), { code: 'CLOSURE_CHANGED' })
        const history = await store.listClosureHistory(owner, { month: '2026-09' })
        assert.equal(history.entries[0].revision, 2); assert.equal(history.entries[0].countedCash, 1100)
        assert.equal((await store.listClosureHistory(owner, { month: '2026-10' })).total, 0, 'Editing does not move the close to the correction month')
        const adminForm = await form(admin, shift.id, { countedCash: 1000 })
        const reviewed = await store.saveRegisterClosure(admin, shift.id, adminForm)
        assert.equal(reviewed.revision, 3); assert.equal(reviewed.closedBy, admin.id)
        assert.equal(reviewed.difference, 0); assert.equal(reviewed.note, '')
        assert.equal((await store.getRegisterClosureRevision(owner, shift.id, 2)).closedBy, owner.id)
      })
      await t.test('monthly pages include closes beyond the latest 100 sessions without duplicates', async () => {
        const template = await store.getRegisterClosureRevision(owner, shift.id, 1)
        const inserted = Array.from({ length: 121 }, (_, index) => {
          const id = crypto.randomUUID(), at = new Date(Date.parse('2026-09-10T15:00:00Z') + index * 1000).toISOString()
          return { id, userId: owner.id, operator: owner.name, businessDate:businessDateAt(at), openingCash: 1000, openedAt: at, closedAt: at,
            closure: { ...template, id: crypto.randomUUID(), registerSessionId: id, closedAt: at, history: [] } }
        })
        if (db) await db.query(`INSERT INTO register_sessions(id,user_id,operator,opening_cash,opened_at,closed_at,closure,business_date)
          SELECT x.id::uuid,x."userId"::uuid,x.operator,x."openingCash",x."openedAt"::timestamptz,x."closedAt"::timestamptz,x.closure,x."businessDate"::date
          FROM jsonb_to_recordset($1::jsonb) AS x(id text,"userId" text,operator text,"openingCash" numeric,"openedAt" text,"closedAt" text,closure jsonb,"businessDate" text)`, [JSON.stringify(inserted)])
        else { const data = JSON.parse(await fs.readFile(process.env.DATA_PATH, 'utf8')); data.registerSessions.push(...inserted); await fs.writeFile(process.env.DATA_PATH, JSON.stringify(data)) }
        const pages = await Promise.all([0, 40, 80, 120].map(offset => store.listClosureHistory(owner, { month: '2026-09', offset })))
        assert.ok(pages.every(p => p.total === 122)); assert.equal(pages[3].hasMore, false)
        const ids = pages.flatMap(p => p.entries.map(e => e.id))
        assert.equal(ids.length, 122); assert.equal(new Set(ids).size, 122)
        assert.equal((await store.listClosureHistory(owner, { month: '2026-09', offset: 1000 })).total, 122)
        assert.ok((await store.getRegisterClosure(owner, inserted[0].id)).closure)
      })
    } finally {
      await store?.closeStore()
      if (db) { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.end() }
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      await fs.rm(temp, { recursive: true, force: true })
    }
  })
