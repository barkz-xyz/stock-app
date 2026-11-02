# Separate PostgreSQL migration and runtime roles

Use an administrative migration connection to apply the schema, then create a separate application login. The runtime login can read and change application records, use sequences, execute application functions, and receive database notifications. It cannot own the database or its objects, create permanent schema objects or databases, manage roles, bypass row security, replicate, or truncate tables. `bakery_schema_migrations` is read-only for this login.

The application uses `DATABASE_URL`. Administrative commands use `MIGRATION_DATABASE_URL`; the provisioning command never falls back to `DATABASE_URL`. Set the connection's `search_path` to the application schema when using a schema other than `public`. Public connections require verified TLS; use `PGSSLROOTCERT` for a private certificate authority when needed.

Apply migrations before provisioning. Supply these environment variables through the environment or a secret manager, without putting a password in process arguments:

| Variable | Purpose |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Separate account that can create roles and grant privileges for all application object owners |
| `RUNTIME_DATABASE_ROLE` | New lowercase role name, 3–63 characters; no `pg_` prefix |
| `RUNTIME_DATABASE_PASSWORD` | Strong random secret, at least 32 characters with at least 12 distinct characters; needed only for a new login |
| `PROVISION_CONFIRM_DATABASE` | Exact connected database name; required because provisioning revokes shared `CREATE` on the application schema |
| `PROVISION_ALLOW_REMOTE=true` | Additional opt-in for every host other than localhost or loopback |

Run `node scripts/provision-postgres.js` after migrations. The command creates a login with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT` and a SCRAM password. It prints only the role, database, and schema. Repeating it reuses an eligible role and refreshes privileges; it never changes an existing password. An existing role with administrative flags, memberships, inheritance, or owned objects is rejected instead of being demoted. Choose a new role in that situation.

Set the application's `DATABASE_URL` to the new login through the deployment environment and keep `DATABASE_AUTO_MIGRATE=false`. Production startup checks the runtime role and the migration marker. A missing or outdated marker requires running the migration command separately. Provisioning does not change the application's connection or deploy anything.

The grants cover existing application tables and defaults for future tables, sequences, and functions created by each current object owner and the migration account. Reapply `grantRuntimePrivileges(client, role)` after migrations to include new owners and keep the migration marker read-only. Migrations remain the responsibility of the separate administrative account. Shared database-level `CREATE` inherited through `PUBLIC` must be removed by the database administrator before provisioning can succeed.

Local verification: `scripts/database-role.test.js` creates disposable schemas and roles against a loopback `TEST_DATABASE_URL`, launches the production-configured app with the limited login, creates a cash sale and refund, verifies database notifications, and checks denied administrative actions. It also verifies future-object grants, migration marker checks, and that provisioning leaves an existing password unchanged. The test removes its generated roles and schemas afterward.
