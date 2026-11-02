import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { postgresConfig } from '../server/postgres.js'
import { assertDatabaseSchema } from '../server/schema.js'

function roleName(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{2,62}$/.test(value) || value.startsWith('pg_')) {
    throw new Error('RUNTIME_DATABASE_ROLE must be a lowercase PostgreSQL role name of 3–63 characters, without the pg_ prefix.')
  }
  return value
}

async function utility(client, format, ...values) {
  const { rows: [row] } = await client.query('SELECT format($1::text,' + values.map((_, i) => `$${i + 2}::text`).join(',') + ') AS statement', [format, ...values])
  return client.query(row.statement)
}

async function assertExistingRole(client, role) {
  const { rows: [state] } = await client.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,r.rolcanlogin,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS has_memberships,
    EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid) AS owns_objects
    FROM pg_roles r WHERE r.rolname=$1`, [role])
  if (!state) return false
  const { rolcanlogin, ...denied } = state
  if (!rolcanlogin || Object.values(denied).some(Boolean)) throw new Error('The existing runtime role has administrative privileges, memberships, inheritance, ownership, or cannot log in. Choose a new role; provisioning will not demote it or change its password.')
  return true
}

export async function grantRuntimePrivileges(client, inputRole) {
  const role = roleName(inputRole)
  if (!await assertExistingRole(client, role)) throw new Error('The limited runtime role must exist before privileges are granted.')
  await assertDatabaseSchema(client)
  const { rows: [context] } = await client.query('SELECT current_database() AS database,current_schema() AS schema,current_user AS owner')
  if (!context.schema) throw new Error('Select the application schema in the migration connection search_path.')
  await utility(client, 'GRANT CONNECT ON DATABASE %I TO %I', context.database, role)
  await utility(client, 'REVOKE CREATE ON DATABASE %I FROM %I', context.database, role)
  await utility(client, 'REVOKE CREATE ON SCHEMA %I FROM PUBLIC', context.schema)
  await utility(client, 'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', context.schema, role)
  await utility(client, 'GRANT USAGE ON SCHEMA %I TO %I', context.schema, role)

  const tables = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, [context.schema])
  for (const table of tables.rows) {
    await utility(client, 'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I', context.schema, table.relname, role)
    if (table.relname === 'bakery_schema_migrations') {
      await utility(client, 'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC', context.schema, table.relname)
      await utility(client, 'GRANT SELECT ON TABLE %I.%I TO %I', context.schema, table.relname, role)
    } else await utility(client, 'GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.%I TO %I', context.schema, table.relname, role)
  }
  await utility(client, 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', context.schema, role)
  await utility(client, 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO %I', context.schema, role)
  await utility(client, 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', context.schema, role)

  const owners = await client.query(`SELECT DISTINCT name FROM (
    SELECT pg_get_userbyid(c.relowner) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
    UNION SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
    UNION SELECT current_user
  ) owners ORDER BY name`, [context.schema])
  for (const { name } of owners.rows) {
    await utility(client, 'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %I', name, context.schema, role)
    await utility(client, 'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON SEQUENCES TO %I', name, context.schema, role)
    await utility(client, 'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I', name, context.schema, role)
  }
  const { rows: [effective] } = await client.query(`SELECT has_database_privilege($1,current_database(),'CREATE')
    OR has_schema_privilege($1,current_schema(),'CREATE') AS can_create`, [role])
  if (effective.can_create) throw new Error('The runtime role still receives database or schema CREATE through PUBLIC. Remove that shared privilege before provisioning.')
  return { database: context.database, schema: context.schema, role }
}

export async function provisionRuntimeRole(client, { role: inputRole, password } = {}) {
  const role = roleName(inputRole)
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bakery-runtime-role:'||$1,0))", [role])
    const exists = await assertExistingRole(client, role)
    if (!exists) {
      if (typeof password !== 'string' || password.length < 32 || password.length > 1024 || new Set(password).size < 12 || /[\x00-\x1f\x7f]/.test(password)) {
        throw new Error('Set RUNTIME_DATABASE_PASSWORD to a strong random password of at least 32 characters for a new runtime role.')
      }
      // The secret stays in a bound parameter; it is never placed in client SQL
      // text, a process argument, the returned result, or the CLI output.
      await client.query("SET LOCAL password_encryption='scram-sha-256'")
      await client.query(`CREATE OR REPLACE FUNCTION pg_temp.bakery_create_runtime_role(role_name text,role_password text) RETURNS void
        LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',role_name,role_password); END $$`)
      await client.query('SELECT pg_temp.bakery_create_runtime_role($1,$2)', [role, password])
    }
    const result = await grantRuntimePrivileges(client, role)
    await client.query('COMMIT')
    return { ...result, created: !exists }
  } catch (error) { await client.query('ROLLBACK'); throw error }
}

export async function provisionFromEnvironment(env = process.env) {
  if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required; the application DATABASE_URL is not used for provisioning.')
  const url = new URL(env.MIGRATION_DATABASE_URL)
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase()) && env.PROVISION_ALLOW_REMOTE !== 'true') {
    throw new Error('Remote provisioning requires PROVISION_ALLOW_REMOTE=true and exact database confirmation.')
  }
  roleName(env.RUNTIME_DATABASE_ROLE)
  const client = new pg.Client(postgresConfig(env.MIGRATION_DATABASE_URL, env))
  try {
    await client.connect()
    const { rows: [context] } = await client.query('SELECT current_database() AS database')
    if (env.PROVISION_CONFIRM_DATABASE !== context.database) throw new Error('Set PROVISION_CONFIRM_DATABASE to the exact connected database name before provisioning.')
    return await provisionRuntimeRole(client, { role: env.RUNTIME_DATABASE_ROLE, password: env.RUNTIME_DATABASE_PASSWORD })
  } finally { await client.end() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  provisionFromEnvironment().then(result => {
    console.log(`Limited runtime role ${result.role} ${result.created ? 'created' : 'reused'} for ${result.database}/${result.schema}. Existing passwords are unchanged; no credentials are printed.`)
  }).catch(() => {
    // PostgreSQL errors can contain bind values or statement context. Keep CLI
    // failures generic so a provisioning password can never reach log output.
    console.error('Runtime role provisioning failed. Check the migration connection, completed migrations, role eligibility, RUNTIME_DATABASE_PASSWORD for new roles, exact database confirmation, and remote opt-in.')
    process.exitCode = 1
  })
}
