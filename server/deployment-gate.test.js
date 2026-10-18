import assert from 'node:assert/strict'
import test from 'node:test'
import { assertAllTestsPassed, deploymentTestEnvironment } from '../scripts/test-deploy.js'

test('deployment gate refuses missing integration credentials and removes live application credentials', () => {
  assert.throws(() => deploymentTestEnvironment({}), /cannot be skipped/)
  const env = deploymentTestEnvironment({ PATH: 'system-path', DATABASE_URL: 'postgresql://isolated-test',
    DATA_PATH: '/production/inventory.json', STAFF_PIN: 'private', APP_USERNAME:'private', APP_PASSWORD:'private', SESSION_SECRET: 'private',
    MERCADOPAGO_ACCESS_TOKEN: 'private', MERCADOPAGO_POINT_TERMINAL_ID: 'private',
    POINT_PILOT_BUSINESS_RUT: 'private', RAILWAY_TOKEN: 'private', RAILWAY_ENVIRONMENT_ID: 'production',
    PGOPTIONS: 'unsafe-search-path', PGSSLMODE: 'disable', NODE_ENV: 'production' })
  assert.equal(env.TEST_DATABASE_URL, 'postgresql://isolated-test')
  assert.equal(env.NODE_ENV, 'test')
  assert.equal(env.PATH, 'system-path')
  assert.equal(env.PGSSLMODE, 'disable')
  for (const key of ['DATABASE_URL', 'DATA_PATH', 'STAFF_PIN', 'APP_USERNAME', 'APP_PASSWORD', 'SESSION_SECRET', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_POINT_TERMINAL_ID', 'POINT_PILOT_BUSINESS_RUT', 'RAILWAY_TOKEN', 'RAILWAY_ENVIRONMENT_ID', 'PGOPTIONS']) assert.equal(key in env, false)
})

test('deployment gate blocks failed, skipped, cancelled, pending, or missing test results', () => {
  const passing = '# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.doesNotThrow(() => assertAllTestsPassed(passing))
  for (const result of ['', passing.replace('# pass 5', '# pass 4'), passing.replace('# fail 0', '# fail 1'), passing.replace('# skipped 0', '# skipped 1'), passing.replace('# cancelled 0', '# cancelled 1'), passing.replace('# todo 0', '# todo 1')]) assert.throws(() => assertAllTestsPassed(result), /Deployment blocked/)
})
