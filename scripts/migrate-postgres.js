import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { postgresConfig } from '../server/postgres.js'
import { migrateDatabase, databaseSchemaVersion } from '../server/schema.js'
import { grantRuntimePrivileges } from './provision-postgres.js'

export async function migratePostgres(env = process.env) {
  if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required; migrations never use the runtime DATABASE_URL.')
  const pool = new pg.Pool(postgresConfig(env.MIGRATION_DATABASE_URL, env))
  try {
    await migrateDatabase(pool)
    if (env.RUNTIME_DATABASE_ROLE) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await grantRuntimePrivileges(client, env.RUNTIME_DATABASE_ROLE)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    return { migrated: true, schemaVersion: databaseSchemaVersion }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migratePostgres().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Database migration failed. Check the separate migration connection, TLS certificates, and migration role permissions.')
    process.exitCode = 1
  })
}
