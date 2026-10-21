import express from 'express'
import { createIntegrationAccessRouter, replyError } from './inventory-api.js'
import { reservationError, reservationId } from './stock-reservations.js'

export function createReservationRouter({ getIntegrations, getReservations, config }) {
  const router = express.Router()
  router.use(createIntegrationAccessRouter({ getStore: getIntegrations, config, scope: 'inventory:reserve' }))
  router.use((req, res, next) => {
    if (!getReservations().persistent) return replyError(reservationError('Reservations unavailable.', 503, 'API_DISABLED'), req, res)
    if (!['GET', 'POST'].includes(req.method)) { res.set('Allow', 'GET, POST'); return replyError(reservationError('Method not supported.', 405, 'METHOD_NOT_ALLOWED'), req, res) }
    next()
  })
  router.use(express.json({ limit: '16kb', strict: true }))
  const actor = req => ({ id: req.integration.id, environment: config.environment })
  const write = action => async (req, res) => {
    // Pausing new checkouts must still allow existing payments to reconcile.
    if (!config.reservationsEnabled && ['create', 'startPayment'].includes(action)) throw reservationError('New reservations are paused.', 503, 'API_DISABLED')
    const key = reservationId(req.headers['idempotency-key'])
    const store = getReservations()
    const result = action === 'create' ? await store.create(actor(req), key, req.body)
      : await store[action](actor(req), reservationId(req.params.id), key, req.body)
    res.set('Idempotency-Replayed', String(result.replayed))
    res.status(action === 'create' && !result.replayed ? 201 : 200).json({ ...result.reservation, replayed: result.replayed })
  }
  router.post('/', write('create'))
  router.get('/:id', async (req, res) => res.json(await getReservations().get(actor(req), reservationId(req.params.id))))
  router.post('/:id/payment-pending', write('startPayment'))
  router.post('/:id/confirm', write('confirm'))
  router.post('/:id/release', write('release'))
  router.use((req, res) => replyError(reservationError('Reservation route not found.', 404, 'NOT_FOUND'), req, res))
  router.use((error, req, res, _next) => replyError(error.type === 'entity.parse.failed' ? reservationError('Invalid JSON.') : error, req, res))
  return router
}

export function createReservationAdminRouter({ getReservations, config }) {
  const router = express.Router()
  router.get('/', async (_req, res) => res.json({ enabled: config.reservationsEnabled, policy: getReservations().policy,
    reservations: await getReservations().list(config.environment) }))
  router.post('/:id/release', async (req, res) => {
    const result = await getReservations().releaseAsAdmin(config.environment, reservationId(req.params.id), reservationId(req.headers['idempotency-key']), req.body)
    res.json({ ...result.reservation, replayed: result.replayed })
  })
  return router
}
