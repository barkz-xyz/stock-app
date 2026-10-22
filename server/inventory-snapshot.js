// Read optimization only. Sales, Point and reservations never consult this snapshot.
export async function initializeInventoryRevision(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_read_revision (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      revision UUID NOT NULL DEFAULT gen_random_uuid()
    );
    INSERT INTO inventory_read_revision(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION bakery_inventory_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      EXECUTE format('UPDATE %I.inventory_read_revision SET revision=gen_random_uuid() WHERE singleton', TG_TABLE_SCHEMA);
      RETURN NULL;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='items'::regclass AND tgname='bakery_inventory_revision') THEN
        CREATE TRIGGER bakery_inventory_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON items
          FOR EACH STATEMENT EXECUTE FUNCTION bakery_inventory_revision();
      END IF;
    END $$;
  `)
}

export async function readInventorySnapshot(pool, revision = null, itemId = null) {
  // One MVCC statement binds the revision to its rows, including concurrent commits.
  // CASE skips the items subquery altogether when the caller's snapshot is current.
  const { rows } = await pool.query(`SELECT r.revision,
    CASE WHEN r.revision=$1::uuid THEN NULL ELSE
      COALESCE((SELECT json_agg(i ORDER BY i.id) FROM (
        SELECT id,sku,name,category,unit,quantity,price,sellable,expiry_date,updated_at
        FROM items ${itemId ? 'WHERE id=$2::uuid' : ''}
      ) i), '[]'::json)
    END AS items
    FROM inventory_read_revision r WHERE r.singleton`, itemId ? [revision, itemId] : [revision])
  if (rows.length !== 1) throw new Error('Inventory revision unavailable')
  return { revision: rows[0].revision, rows: rows[0].items }
}
