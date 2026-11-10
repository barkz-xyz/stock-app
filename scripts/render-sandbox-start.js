import { createServer } from 'node:http'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'
import { migrateDatabase } from '../server/schema.js'
import { provisionRuntimeRole } from './provision-postgres.js'

const runtimeRole = 'bakery_pos_runtime'
const database = 'bakery_pos_sandbox'
const privateHost = process.env.BAKERY_RENDER_DB_HOST
let startupPhase = 'configuration'

function sandboxUrl(value, role) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== privateHost ||
      (url.port && url.port !== '5432') || url.pathname !== '/' + database ||
      url.username !== role || !url.password || url.search || url.hash) {
    throw new Error('Invalid isolated Render database configuration.')
  }
  return url
}

async function bootstrap(admin, runtime) {
  const ids = (process.env.BAKERY_RENDER_SAMPLE_IDS || '').split(',')
  if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)))
    throw new Error('Expected two fixture product IDs.')
  const pool = new pg.Pool(postgresConfig(admin.href))
  try {
    startupPhase = 'schema migration'
    await migrateDatabase(pool)
    const client = await pool.connect()
    try {
      startupPhase = 'runtime role provisioning'
      await provisionRuntimeRole(client, { role: runtimeRole, password: decodeURIComponent(runtime.password) })
      startupPhase = 'fixture seed'
      await client.query(`WITH seeded AS (
        INSERT INTO items(id,name,category,unit,quantity,low_stock_threshold,sku,price,sellable)
        VALUES ($1,'Pan de prueba','Bread','pieces',24,2,'WEB-TEST-1',1500,TRUE),
               ($2,'Galleta de prueba','Pastries','pieces',18,2,'WEB-TEST-2',1000,TRUE)
        ON CONFLICT (id) DO NOTHING RETURNING id,name,quantity
      )
      INSERT INTO movements(id,item_id,item_name,type,quantity,balance_after,note)
      SELECT gen_random_uuid(),id,name,'stock_in',quantity,quantity,'Inventario ficticio web' FROM seeded`, ids)
    } finally { client.release() }
  } finally { await pool.end() }
}

try {
  if (process.env.RENDER !== 'true' || !/^srv-[a-z0-9]+$/.test(process.env.RENDER_SERVICE_ID || '') ||
      !/^dpg-[a-z0-9]+-[a-z]$/.test(privateHost || '') || process.env.NODE_ENV !== 'production') {
    throw new Error('This launcher requires the isolated Render environment.')
  }
  if (Object.keys(process.env).some(key => key.startsWith('MERCADOPAGO_') && process.env[key]))
    throw new Error('The POS sandbox does not accept payment credentials.')
  const runtime = sandboxUrl(process.env.DATABASE_URL, runtimeRole)
  const adminUrl = process.env.BAKERY_RENDER_BOOTSTRAP_URL
  if (adminUrl) {
    // The first deployment provisions the database without exposing the POS.
    // Remove the temporary owner connection and redeploy to start the app.
    await bootstrap(sandboxUrl(adminUrl, 'bakery_pos_admin'), runtime)
    createServer((request, response) => {
      response.writeHead(request.url === '/api/health' && request.method === 'GET' ? 200 : 404,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ status: 'database-prepared' }))
    }).listen(Number(process.env.PORT || 10000), '0.0.0.0')
    console.log('POS sandbox database ready. Remove the bootstrap secret and deploy again.')
  } else {
    if ((process.env.SESSION_SECRET || '').length < 32 || (process.env.STAFF_PIN || '').length < 16)
      throw new Error('Separate POS sandbox session and initial administrator secrets are required.')
    Object.assign(process.env, {
      INVENTORY_API_ENABLED: 'true',
      INVENTORY_API_ENVIRONMENT: 'test',
      INVENTORY_RESERVATIONS_ENABLED: 'true',
      DATABASE_AUTO_MIGRATE: 'false',
      SEED_DEMO_DATA: 'false',
      HOST: '0.0.0.0',
    })
    startupPhase = 'POS startup'
    await import('../server/index.js')
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9]{5,20}$/.test(error.code) ? ` (${error.code})` : ''
  console.error(`Render POS sandbox startup failed during ${startupPhase}${code}.`)
  process.exitCode = 1
}
