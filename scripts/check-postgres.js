import pg from 'pg'
import { postgresConfig, assertLimitedRuntimeRole } from '../server/postgres.js'
import { assertDatabaseSchema } from '../server/schema.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to verify the production runtime connection.')
const pool = new pg.Pool(postgresConfig(process.env.DATABASE_URL))
try {
  await assertLimitedRuntimeRole(pool)
  await assertDatabaseSchema(pool)
  console.log('Database ready: limited runtime role and current schema verified.')
} finally { await pool.end() }
