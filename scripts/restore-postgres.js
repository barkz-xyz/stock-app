import { restorePostgresBackup } from './postgres-backup.js'

restorePostgresBackup({ archive: process.argv[2] }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
