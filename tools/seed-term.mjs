#!/usr/bin/env node
/**
 * Push BUILTIN_GROUPS terms that are missing from Drive's terms.json.
 *
 * This is the same thing the app's boot() does on first load (seed only the
 * ids the store has never seen, never overwrite an existing one) — done from
 * the terminal so a newly authored term lands in Drive without opening the
 * page. A new term is inserted directly after the term it follows in
 * BUILTIN_GROUPS, so Drive's key order keeps matching the authored order.
 *
 *   node tools/seed-term.mjs Typescript --dry-run
 *   node tools/seed-term.mjs Typescript
 *   node tools/seed-term.mjs Typescript --only tsx
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join }     from 'node:path'
import { fileURLToPath }     from 'node:url'

import { authorize } from './lib/auth.mjs'
import { driveClient, findChild, upsertText, withRetry } from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..')

const argv   = process.argv.slice(2)
const DRY    = argv.includes('--dry-run')
const onlyAt = argv.indexOf('--only')
const ONLY   = onlyAt >= 0 ? argv[onlyAt + 1] : null
const mod    = argv.find(a => !a.startsWith('--') && a !== ONLY)
if (!mod) { console.error('usage: node tools/seed-term.mjs <Module> [--only <id>] [--dry-run]'); process.exit(1) }

/* ── the app's BUILTIN_GROUPS, read straight out of the module's notes page ── */
async function builtinSeed(moduleDir) {
  const dir   = join(REPO, moduleDir)
  const page  = (await readdir(dir)).find(f => f.endsWith('Notes.html'))
  if (!page) throw new Error(`no *Notes.html in ${moduleDir}/`)
  const lines = (await readFile(join(dir, page), 'utf8')).split('\n')
  const start = lines.findIndex(l => l.startsWith('const BUILTIN_GROUPS'))
  const end   = lines.indexOf('];', start)
  if (start < 0 || end < 0) throw new Error(`BUILTIN_GROUPS not found in ${page}`)

  const src = lines.slice(start, end + 1).join('\n') + '\nexport default BUILTIN_GROUPS;\n'
  const groups = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default

  const out = {}
  for (const g of groups) {
    for (const t of g.terms) {
      out[t.id] = {
        id: t.id, title: t.title, group: g.name, tag: g.tag,
        lede: t.lede, what: t.what, why: t.why, apply: t.apply,
        code: t.code, related: t.related, builtin: true,
      }
    }
  }
  return { page, out }
}

/* ── insert `id` into `store` right after whichever seeded term precedes it ── */
function insertInOrder(store, seed, id) {
  const order = Object.keys(seed)
  const prev  = order.slice(0, order.indexOf(id)).reverse().find(k => k in store)
  if (!prev) return { ...store, [id]: seed[id] }          // no anchor — append
  const out = {}
  for (const k of Object.keys(store)) {
    out[k] = store[k]
    if (k === prev) out[id] = seed[id]
  }
  return out
}

const { page, out: seed } = await builtinSeed(mod)
console.log(`  ${page}: ${Object.keys(seed).length} authored terms`)

const auth  = await authorize()
const drive = driveClient(auth)

const root = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')
const folder = await findChild(drive, root.id, mod)
if (!folder) throw new Error(`no ${mod} folder in Drive`)
const file = await findChild(drive, folder.id, 'terms.json')
if (!file) throw new Error(`no ${mod}/terms.json in Drive`)

const r = await withRetry('download', () =>
  drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' }))
let store = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
console.log(`  Drive terms.json: ${Object.keys(store).length} terms (id ${file.id})`)

const missing = Object.keys(seed).filter(id => !(id in store) && (!ONLY || id === ONLY))
if (!missing.length) { console.log('\n  Nothing to seed — Drive already has every authored term.'); process.exit(0) }

for (const id of missing) {
  store = insertInOrder(store, seed, id)
  const at = Object.keys(store).indexOf(id)
  console.log(`  + ${id}  "${seed[id].title}"  [${seed[id].group}] → position ${at + 1}/${Object.keys(store).length}`)
}

if (DRY) { console.log('\n  --dry-run: Drive not written.'); process.exit(0) }

await upsertText(drive, folder.id, 'terms.json', JSON.stringify(store), 'application/json')
console.log(`\n  ✓ terms.json updated in Drive — ${Object.keys(store).length} terms.`)
