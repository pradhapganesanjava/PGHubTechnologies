#!/usr/bin/env node
/**
 * Write many terms, Q&As or topics into a module's Drive file in one upload.
 *
 * put-qa.mjs and put-topic.mjs write one item per run, which re-downloads and
 * re-uploads the whole file each time — fine for a correction, not for seeding
 * a module with hundreds of long answers. This takes a JSON array of items of
 * the same shapes those tools (and the app) write, and applies them all in a
 * single read-modify-write.
 *
 *   node tools/put-items.mjs JavaScript qa     items.json [more.json …] --dry-run
 *   node tools/put-items.mjs JavaScript terms  terms.json
 *   node tools/put-items.mjs JavaScript topics topics.json
 *
 * An existing id is replaced in place, keeping its position; new ids are
 * appended in the order given. Nothing else in the file is touched.
 *
 * --fresh writes exactly the items given, in the order given, and drops
 * everything else in the file — for re-seeding a module whose content is
 * authored outside the app. It refuses if that would drop items the input does
 * not carry, unless --force is also passed, since an edit made in the app
 * would be lost with them.
 */
import { readFile } from 'node:fs/promises'

import { authorize } from './lib/auth.mjs'
import { driveClient, findChild, upsertText, withRetry } from './lib/drive.mjs'

const FILE_OF  = { terms: 'terms.json', qa: 'qa.json', topics: 'topics.json' }
const REQUIRED = { terms: ['id', 'group', 'title'], qa: ['id', 'group', 'question'], topics: ['id', 'group', 'title'] }

const argv  = process.argv.slice(2)
const DRY   = argv.includes('--dry-run')
const FRESH = argv.includes('--fresh')
const FORCE = argv.includes('--force')
const [mod, kind, ...files] = argv.filter(a => !a.startsWith('--'))
if (!mod || !FILE_OF[kind] || !files.length) {
  console.error('usage: node tools/put-items.mjs <Module> <terms|qa|topics> <items.json> [...] [--dry-run]')
  process.exit(1)
}

const items = []
for (const f of files) {
  const arr = JSON.parse(await readFile(f, 'utf8'))
  if (!Array.isArray(arr)) throw new Error(`${f}: expected a JSON array`)
  items.push(...arr)
}
for (const it of items) {
  for (const k of REQUIRED[kind]) if (!it[k]) throw new Error(`item ${it.id ?? '?'} is missing "${k}"`)
  if (kind === 'qa') it.qa = true            // the flag the app's own writer stamps on
}

const auth  = await authorize()
const drive = driveClient(auth)
const root  = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')
const folder = await findChild(drive, root.id, mod)
if (!folder) throw new Error(`no ${mod} folder in Drive — run tools/add-module.mjs first`)
const file = await findChild(drive, folder.id, FILE_OF[kind])

const store = file
  ? await withRetry('download', () =>
      drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' })
    ).then(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data))
  : {}

let added = 0, replaced = 0
for (const it of items) if (it.id in store) replaced++; else added++
let out = store
if (FRESH) {
  const given   = new Set(items.map(it => it.id))
  const dropped = Object.keys(store).filter(id => !given.has(id))
  if (dropped.length && !FORCE) {
    throw new Error(`--fresh would drop ${dropped.length} item(s) not in the input (${dropped.slice(0, 5).join(', ')}…); add --force to allow it`)
  }
  out = {}
}
for (const it of items) out[it.id] = it
const body = JSON.stringify(out)
console.log(`\n  ${mod}/${FILE_OF[kind]}: +${added} new, ~${replaced} replaced → ${Object.keys(out).length} items, ${(body.length / 1024).toFixed(0)} KB`)

if (DRY) { console.log('  --dry-run: Drive not written.\n'); process.exit(0) }
await upsertText(drive, folder.id, FILE_OF[kind], body, 'application/json')
console.log(`  ✓ ${FILE_OF[kind]} updated in Drive.\n`)
