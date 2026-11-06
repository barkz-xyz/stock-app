import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function* javaScriptFiles(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* javaScriptFiles(path)
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) yield path
  }
}

const files = ['vite.config.js', ...['server', 'scripts', 'src'].flatMap(directory => [...javaScriptFiles(directory)])]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Checked syntax in ${files.length} JavaScript files.`)
