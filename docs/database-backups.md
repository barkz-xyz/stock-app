# Complete PostgreSQL backup and recovery

The database backup now uses a consistent `pg_dump` custom archive of the whole
database. It includes every application table, all schemas, data, sequences,
functions, triggers, indexes, constraints and large objects. New tables are
automatically covered. The former partial `.json.gz` exports remain untouched;
they cannot be treated as complete recovery archives.

## Create a protected local backup

Install PostgreSQL client tools matching the server major version. `pg_dump`
must not be older than the server; use the matching `pg_restore`. Override their
locations with `PG_DUMP_PATH` and `PG_RESTORE_PATH` if needed.

Read `BACKUP_DATABASE_URL` from a secret environment file. It overrides
`DATABASE_URL`; `DATABASE_PUBLIC_URL` is deliberately not selected automatically.
Use an explicit ordinary database name with letters, digits, underscores, dollar
signs, dots or hyphens. Connection-string syntax inside a database name is rejected.
The backup account needs read access to every application table and sequence.
For external connections, configure the trusted root certificate through
`PGSSLROOTCERT` as needed. Certificate and hostname verification remain enabled.
URLs and passwords are passed through child-process environment variables,
never command arguments, and tool errors are redacted.

Set `BACKUP_DIRECTORY` to an absolute persistent location outside the application
checkout, for example `/var/backups/stock-app`, with permissions `0700`. Then run:

```bash
npm run backup:postgres
```

Each run creates a unique `.dump`, a `.dump.sha256` sidecar, and a
`.dump.manifest.json` containing archive size, integrity digest and object counts.
Files use `0600`. Nothing overwrites or prunes older backups. Failed runs remove
only their own incomplete files; an interrupted process may leave an archive
without all metadata, which restore rejects. Monitor disk usage and configure
retention only after recovery has been verified.

The archive includes password hashes, integration key hashes and staff session
hashes. It is sensitive even though raw login passwords and raw issued integration
tokens are not stored. The checksum detects corruption; it does not authenticate
an archive from an untrusted source.

## Restore into a new empty database

Keep the target application offline. Create a separate empty database using an
administrator connection, and supply its credentials in `RESTORE_DATABASE_URL`.
The restore utility never uses `DATABASE_URL` as a fallback. Set
`RESTORE_CONFIRM_DATABASE` to the exact target database name and run:

```bash
npm run restore:postgres -- /var/backups/stock-app/postgres-TIMESTAMP-UUID.dump
```

Both sidecars must be alongside the archive. Integrity and format checks happen
before connecting to the target. Restore rejects the source endpoint/database,
maintenance databases, targets with existing objects, and targets with other
database sessions. A different host or port can use the original database name.
A remote target additionally requires `RESTORE_ALLOW_REMOTE=true` and verified
TLS. Never repoint this command at the live database to bypass these checks.

The archive restores in one transaction with no destructive `--clean` option.
Object ownership and grants are not replayed: the target restore account owns
the restored objects. All restored `auth_sessions` are invalidated before the
utility reports success, preventing old login cookies from becoming valid again.
Staff must sign in again; their passwords are unchanged. Keep the target offline
if session invalidation or table-count validation fails after the archive restore.

Provision the separate migration/runtime/backup roles and grants on the target
before using it with the application. Global PostgreSQL roles, cluster settings,
Railway environment variables, Mercado Pago configuration and application files
are outside a single-database archive. Preserve their secure recovery procedure
separately. Production service credentials belong in a secret manager, not this
repository or a plaintext backup note.

After restoration, compare table counts, financial reports and inventory; test a
cash sale, a refund, a withdrawal and an online reservation in the isolated target.
Disable live payment and external integration access during drills. Reconcile
pending payment/refund operations with their provider before resuming operation,
because an earlier database snapshot cannot reverse transactions already accepted
outside the database. Explicitly review recovered integration credentials and open
register sessions. Deploy only after this review and required migrations succeed.

## Hourly encrypted offsite copies

The reviewable templates in `docs/operations/` are not installed or activated by
the repository. Use a separate backup worker with persistent storage and network
access to the database, plus matching PostgreSQL clients, Node, Bash, `tar`,
[`age`](https://github.com/FiloSottile/age) and
[`rclone`](https://rclone.org/docs/). Run the worker outside the web container so
redeploying the app does not remove its backups.

1. Create an age identity on the recovery machine. Store the private identity
   separately from the application and backup worker; give the worker only its
   public recipient. Verify that a second authorized operator can recover it.
2. Configure an rclone named remote to a separate storage account/bucket with
   encryption in transit, restricted credentials and object retention/versioning.
   Use `backup.env.example` as the protected `/etc/stock-app/backup.env` and protect
   `/etc/stock-app/rclone.conf` with `0600`. Do not put credential URLs in
   `BACKUP_REMOTE`; it accepts named remotes such as `backup:stock-app/database`.
3. Review the service paths/user and make `/var/backups/stock-app` owned by
   `stock-backup` with `0700`. Copy the service and timer to the host's systemd
   configuration. Run the service manually and complete a recovery drill before
   enabling its hourly timer. The timer catches up once after downtime.
4. Connect service failures and missed-success detection to the operator's
   existing monitoring. Alert when no verified copy has completed for two hours.
   This repository does not create an alert destination or send messages.

The executable workflow is `npm run backup:offsite`. It first creates the full
protected backup, packs all three files together, and age-encrypts the stream.
Only ciphertext is uploaded. It uses `rclone copyto --immutable` and then
`rclone check --download` to verify the remote bytes. A run succeeds only after
encryption, upload and verification all succeed. Raw local archives remain
protected on the backup volume; neither local nor remote retention deletes files
automatically. Establish retention appropriate to the business recovery window
and test it before enabling any deletion policy.

On a recovery machine, download the encrypted bundle, decrypt with the protected
age identity into a `0700` directory, unpack all three files, and use the guarded
restore above. Perform this drill monthly and after schema/backup changes. Keep
Railway-native scheduled volume/database backups as an additional recovery layer;
enabling those schedules requires a separate production configuration change.
Hourly logical copies set a nominal one-hour data-loss window only while runs
succeed; provider point-in-time recovery is needed for a smaller window.

## Automated local recovery proof

```bash
BACKUP_TEST_DATABASE_URL=postgresql://local_admin@127.0.0.1:5432/local_test npm run test:backup
```

Use a local loopback PostgreSQL admin with `CREATEDB`. The test creates and drops
only its randomly named fixture databases. It verifies every table's row digest,
integration credentials, stock holds and operations, cash withdrawals and their
ledger, staff-session invalidation, procedural triggers and sequence values. A
future-table fixture ensures the implementation cannot regress to a fixed table
list. It also verifies permissions, corruption rejection, target guards and
preservation of prior backups. It never connects to a production endpoint.

Implementation references: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html),
[rclone copyto](https://rclone.org/commands/rclone_copyto/) and
[rclone check](https://rclone.org/commands/rclone_check/).
