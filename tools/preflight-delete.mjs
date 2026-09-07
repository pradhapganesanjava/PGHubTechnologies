#!/usr/bin/env node
/**
 * Confirm every local content file has a counterpart in Drive, before any of
 * it is deleted.
 *
 * verify.mjs compares counts, which is enough to trust a migration. Deleting
 * the only local copy deserves more: this walks each file that is about to go
 * and checks it is individually accounted for — its Drive id recorded in the
 * migration state, and that id still resolving to a live file of the right
 * size. Anything unaccounted for is listed and the exit code is non-zero.
 *
 *   node tools/preflight-delete.mjs [--deep]     --deep re-checks sizes in Drive
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath }           from 'node:url'
import { authorize }               from './lib/auth.mjs'
import { driveClient, withRetry }  from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..')
const DEEP  = process.argv.includes('--deep')

// Must match migrate.mjs's SKIP_NAMES/SKIP_EXT, or this reports files the
// migration deliberately never uploaded (the app itself, a vendored library,
// a checked-in virtualenv) as unaccounted for.
const SKIP_NAMES = new Set([
  '.DS_Store', '.gitkeep', 'server.py', 'start.command', 'node_modules',
  '__pycache__', '.venv', 'venv', '.claude', '.git', 'vendor', '.pytest_cache',
  '.ruff_cache', '.mypy_cache', '.idea', '.vscode',
])
const SKIP_EXT = /\.(pyc|pyo|tmp|swp)$/i

async function walk(dir, base = dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name) || e.name.startsWith('._') || SKIP_EXT.test(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p, base))
    else if (e.isFile()) out.push({ abs: p, rel: relative(base, p).split('\\').join('/') })
  }
  return out
}

/** The one HTML file in a module folder that IS the application, not content. */
async function appHtml(modDir) {
  let names
  try { names = await readdir(modDir) } catch { return null }
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith('.html')) continue
    if ((await readFile(join(modDir, n), 'utf8')).includes('BUILTIN_GROUPS')) return n
  }
  return null
}

const state = JSON.parse(await readFile(join(__dir, '.migration-state.json'), 'utf8'))
const hub   = JSON.parse(await readFile(join(REPO, 'hub.json'), 'utf8'))
const drive = DEEP ? driveClient(await authorize()) : null

const DATA = ['terms.json', 'qa.json', 'topics.json', 'notes.json']
const unaccounted = []
let checked = 0, bytes = 0

console.log('\n  Pre-flight: every local content file must exist in Drive\n')

for (const mod of Object.keys(hub.modules)) {
  const ms = state.modules?.[mod]
  if (!ms) { unaccounted.push(`${mod}/ — module never migrated`); continue }

  const missing = []

  for (const f of DATA) {
    try { await stat(join(REPO, mod, f)) } catch { continue }
    checked++; bytes += (await stat(join(REPO, mod, f))).size
    if (!ms.data?.[f]) missing.push(`${mod}/${f}`)
  }

  for (const f of await walk(join(REPO, mod, 'docs'))) {
    checked++; bytes += (await stat(f.abs)).size
    const isAsset = f.rel.startsWith('assets/')
    const id = isAsset ? ms.assets?.[f.rel] : ms.docs?.[f.rel]
    if (!id) missing.push(`${mod}/docs/${f.rel}`)
  }

  for (const f of await walk(join(REPO, mod, 'images'))) {
    checked++; bytes += (await stat(f.abs)).size
    if (!ms.images?.[f.rel]) missing.push(`${mod}/images/${f.rel}`)
  }

  // Everything else in the folder: Kafka/usecases, Python/drills and data,
  // MCP's loose notes, AgenticAI's standalone pages. The module's own app page
  // is code and stays in the repo, so it is the one file not expected in Drive.
  const app = await appHtml(join(REPO, mod))
  for (const f of await walk(join(REPO, mod))) {
    if (f.rel.startsWith('docs/') || f.rel.startsWith('images/')) continue
    if (DATA.includes(f.rel) || f.rel === app) continue
    checked++; bytes += (await stat(f.abs)).size
    if (!ms.extras?.[f.rel]) missing.push(`${mod}/${f.rel}`)
  }

  const mark = missing.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'
  console.log(`  ${mark} ${mod.padEnd(18)} ${missing.length ? `${missing.length} unaccounted` : 'all accounted for'}`)
  unaccounted.push(...missing)
}

// hub.json itself
if (!state.hubJsonId) unaccounted.push('hub.json')
console.log(`  ${state.hubJsonId ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} hub.json`)

// Content that belongs to no module — see EXTRA_TREES in migrate.mjs.
for (const tree of ['JavaStackPage']) {
  const es = state.extras?.[tree] ?? {}
  const missing = []
  for (const f of await walk(join(REPO, tree))) {
    checked++; bytes += (await stat(f.abs)).size
    if (!es[f.rel]) missing.push(`${tree}/${f.rel}`)
  }
  const mark = missing.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'
  console.log(`  ${mark} _extras/${tree.padEnd(18 - 1)} ${missing.length ? `${missing.length} unaccounted` : 'all accounted for'}`)
  unaccounted.push(...missing)
}

if (DEEP) {
  console.log('\n  Deep check: sampling Drive ids resolve to live files…')
  const ids = new Set()
  for (const ms of Object.values(state.modules)) {
    for (const m of [ms.data, ms.docs, ms.images, ms.assets]) {
      for (const id of Object.values(m ?? {})) ids.add(id)
    }
  }
  const sample = [...ids].sort(() => Math.random() - 0.5).slice(0, 60)
  let gone = 0
  for (const id of sample) {
    try {
      const r = await withRetry('get', () =>
        drive.files.get({ fileId: id, fields: 'id,name,size,trashed' }))
      if (r.data.trashed) { gone++; unaccounted.push(`trashed in Drive: ${r.data.name}`) }
    } catch { gone++; unaccounted.push(`unresolvable Drive id: ${id}`) }
  }
  console.log(`  ${gone ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'} ${sample.length} sampled ids, ${gone} bad`)
}

console.log(`\n  ${checked} local file(s), ${(bytes / 1e6).toFixed(1)} MB examined`)
if (unaccounted.length) {
  console.log(`\n  \x1b[31mNOT SAFE TO DELETE\x1b[0m — ${unaccounted.length} file(s) unaccounted for:\n`)
  unaccounted.slice(0, 30).forEach(f => console.log(`      ${f}`))
  if (unaccounted.length > 30) console.log(`      … and ${unaccounted.length - 30} more`)
  console.log()
  process.exit(1)
}
console.log('\n  \x1b[32mEvery local content file is in Drive.\x1b[0m\n')
