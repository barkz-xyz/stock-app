// SELECT/EXPLAIN only; never changes application data or database settings permanently.
import pg from 'pg'

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_PUBLIC_URL or DATABASE_URL is required')
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15000, ssl: !connectionString.includes('railway.internal') && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false })
try {
  await client.connect()
  await client.query('BEGIN TRANSACTION READ ONLY')
  await client.query("SET LOCAL statement_timeout = '10s'")
  const { rows: [counts] } = await client.query('SELECT (SELECT COUNT(*) FROM items)::int AS products, (SELECT COUNT(*) FROM sales)::int AS sales, (SELECT COUNT(*) FROM refunds)::int AS refunds')
  const queries = {
    products: 'SELECT * FROM items ORDER BY name ASC',
    recentSales: 'SELECT * FROM sales ORDER BY created_at DESC LIMIT 50',
    recentMovements: 'SELECT * FROM movements ORDER BY created_at DESC LIMIT 100',
    metricsRange: `SELECT s.* FROM sales s WHERE (COALESCE(s.paid_at, s.created_at) >= NOW()-INTERVAL '60 days' AND COALESCE(s.paid_at, s.created_at) < NOW()) OR EXISTS (SELECT 1 FROM refunds r WHERE r.sale_id=s.id AND r.status='processed' AND r.processed_at >= NOW()-INTERVAL '60 days' AND r.processed_at < NOW()) ORDER BY s.created_at DESC`,
  }
  const plans = {}
  for (const [name, query] of Object.entries(queries)) {
    const result = (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query)).rows[0]['QUERY PLAN'][0]
    const nodes = []
    const visit = node => { nodes.push({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'], rows: node['Actual Rows'], loops: node['Actual Loops'] }); node.Plans?.forEach(visit) }
    visit(result.Plan)
    plans[name] = { planningMs: result['Planning Time'], executionMs: result['Execution Time'], nodes }
  }
  const { rows: indexes } = await client.query("SELECT tablename, indexname FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")
  console.log(JSON.stringify({ readOnly: true, counts, plans, indexes }, null, 2))
  await client.query('COMMIT')
} finally {
  await client.query('ROLLBACK').catch(() => {})
  await client.end()
}
