import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function deploymentTestEnvironment(source) {
  const database = source.TEST_DATABASE_URL
  if (!database) throw new Error('Deployment tests require an explicit TEST_DATABASE_URL; integration tests cannot be skipped and never use DATABASE_URL.')
  if ((source.NODE_ENV === 'production' || source.RAILWAY_PROJECT_ID || source.RAILWAY_ENVIRONMENT_ID) && source.DATABASE_URL) {
    const target = value => { const u = new URL(value); return `${u.hostname.toLowerCase()}:${u.port || '5432'}${decodeURIComponent(u.pathname)}` }
    if (target(database) === target(source.DATABASE_URL)) throw new Error('TEST_DATABASE_URL must point to a separate test database, not the production database.')
  }
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(DATABASE_|MIGRATION_|RUNTIME_DATABASE_|PROVISION_|BACKUP_|RESTORE_|TEST_DATABASE_URL$|DATA_PATH$|PORT$|STAFF_PIN$|APP_USERNAME$|APP_PASSWORD$|SESSION_SECRET$|MERCADOPAGO_|INVENTORY_|POINT_|RAILWAY_|PGOPTIONS$|PGSERVICE|PGHOST$|PGPORT$|PGDATABASE$|PGUSER$|PGPASSWORD$|PGPASSFILE$)/.test(key)))
  return { ...env, NODE_ENV: 'test', TEST_DATABASE_URL: database, SEED_DEMO_DATA: 'false' }
}

export function assertAllTestsPassed(report) {
  const count = name => Number(report.match(new RegExp(`^# ${name} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN)
  if (!Number.isFinite(count('tests')) || count('tests') < 1 || count('pass') !== count('tests') ||
    count('fail') !== 0 || count('cancelled') !== 0 || count('skipped') !== 0 || count('todo') !== 0) {
    throw new Error('Deployment blocked: every test must pass with zero skipped, cancelled, or pending tests.')
  }
}

export async function runDeploymentTests() {
  const env = deploymentTestEnvironment(process.env)
  await fs.access(path.join(root, 'dist', 'index.html')) // Test the built artifact, not just the source.
  const files = (await fs.readdir(path.join(root, 'server'))).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, 'server', name))
  let report = ''
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.on('data', chunk => { report += chunk; process.stdout.write(chunk) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error('Deployment blocked: test runner failed.')
  assertAllTestsPassed(report)
  console.log('Deployment gate passed: build present and every test passed, including PostgreSQL integration.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDeploymentTests().catch(error => { console.error(error.message); process.exitCode = 1 })
}
