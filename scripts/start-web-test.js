import { randomUUID, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'

const url = new URL(process.env.WEB_TEST_DATABASE_URL || 'postgresql://127.0.0.1/invalid')
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
    url.pathname !== '/bakery_web_test' || url.search || url.hash) {
  throw new Error('Set WEB_TEST_DATABASE_URL to the dedicated loopback database bakery_web_test.')
}
const port = Number(process.env.WEB_TEST_PORT || 4185)
if (![4185, 4175].includes(port)) throw new Error('Use port 4185 or the checkout sandbox port 4175.')
await access(new URL('../dist/index.html', import.meta.url))

const directory = new URL('../tmp/web-sales-test/', import.meta.url)
const credentialsPath = new URL('credentials.json', directory)
await mkdir(directory, { recursive: true, mode: 0o700 })
let credentials
try {
  credentials = JSON.parse(await readFile(credentialsPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  credentials = { username: 'admin-test', password: randomBytes(18).toString('base64url'), sessionSecret: randomBytes(32).toString('hex') }
  await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' })
}

for (const key of Object.keys(process.env)) {
  if (/^(RAILWAY_|MERCADOPAGO_|DATABASE_|MIGRATION_|INVENTORY_|PG|STAFF_PIN$)/.test(key)) delete process.env[key]
}
Object.assign(process.env, {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), PGSSLMODE: 'disable',
  DATABASE_URL: url.href, SESSION_SECRET: credentials.sessionSecret, MERCADOPAGO_MOCK: 'false',
  INVENTORY_API_ENABLED: 'true', INVENTORY_API_ENVIRONMENT: 'test', INVENTORY_RESERVATIONS_ENABLED: 'true',
  SEED_DEMO_DATA: 'false', BAKERY_TIME_ZONE: 'America/Santiago',
})
if (process.env.WEB_TEST_POINT_PRINT_ENV_FILE) {
  const source = parseEnv(await readFile(process.env.WEB_TEST_POINT_PRINT_ENV_FILE, 'utf8'))
  const accessToken = source.MERCADOPAGO_ACCESS_TOKEN
  const terminalId = source.MERCADOPAGO_POINT_TERMINAL_ID
  if (!accessToken || !terminalId) throw new Error('The Point printing file needs an access token and terminal ID.')
  process.env.MERCADOPAGO_WEB_PRINT_ACCESS_TOKEN = accessToken
  process.env.MERCADOPAGO_WEB_PRINT_TERMINAL_ID = terminalId
}

const store = await import('../server/store.js')
await store.initializeStore()
try {
  if (!(await store.countUsers())) await store.createUser({ ...credentials, name: 'Administración de prueba' }, true)
  if (!(await store.listItems()).length) {
    // Match the checkout sandbox allowlist when its local catalog is supplied.
    let ids = [randomUUID(), randomUUID()]
    if (process.env.WEB_TEST_CHECKOUT_CATALOG) {
      const { products } = JSON.parse(await readFile(process.env.WEB_TEST_CHECKOUT_CATALOG, 'utf8'))
      ids = Object.entries(products).filter(([, p]) => p.published && p.unitConfirmed && p.posUnit === 'pieces')
        .slice(0, 2).map(([id]) => id)
      if (ids.length !== 2) throw new Error('The checkout catalog needs two published items sold by piece.')
    }
    const db = new pg.Client(postgresConfig(url.href))
    await db.connect()
    try {
      await db.query(`WITH seeded AS (
        INSERT INTO items(id,name,category,unit,quantity,low_stock_threshold,sku,price,sellable)
        VALUES ($1,'Pan de prueba','Bread','pieces',24,2,'WEB-TEST-1',1500,TRUE),
               ($2,'Galleta de prueba','Pastries','pieces',18,2,'WEB-TEST-2',1000,TRUE)
        ON CONFLICT (id) DO NOTHING RETURNING id,name,quantity
      )
      INSERT INTO movements(id,item_id,item_name,type,quantity,balance_after,note)
      SELECT gen_random_uuid(),id,name,'stock_in',quantity,quantity,'Inventario ficticio web' FROM seeded`, ids)
    } finally { await db.end() }
  }
  if (!credentials.inventoryToken) {
    const { token } = await store.getInventoryIntegrationStore().createClient({
      name: 'Checkout web TEST', environment: 'test', expiresInDays: 90, reservationsEnabled: true,
    })
    credentials.inventoryToken = token
    await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
  }
} finally { await store.closeStore() }

await import('../server/index.js')
console.log(`POS de prueba: http://localhost:${port}/caja/historial`)
console.log(`Credenciales de prueba: ${fileURLToPath(credentialsPath)}`)
