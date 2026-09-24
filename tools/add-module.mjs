#!/usr/bin/env node
/**
 * Register a new module in Drive: its folder, its empty data files, and its
 * entry in hub.json — the manifest the landing page draws its cards from.
 *
 * A module page (<Module>/<Name>.html) is only the renderer. Until Drive has a
 * folder by that name the page stops at "Module has no folder in Drive yet",
 * and until hub.json lists it the hub never links to it. Both used to be done
 * by hand; this does them in one idempotent step.
 *
 *   node tools/add-module.mjs JavaScript --page JavaScript/JavaScriptNotes.html \
 *        --title JavaScript --emoji 🟨 --category Languages \
 *        --sub "Language, async, browser & Node — terms, 250 Q&A, topics" [--dry-run]
 *
 * Existing files are never overwritten; an existing hub.json entry is updated
 * in place and the module is added to the category only if it is not in one.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'

import { authorize } from './lib/auth.mjs'
import { driveClient, ensureFolder, findChild, listChildren, upsertText, withRetry } from './lib/drive.mjs'

// build-search-index.mjs finds each module's files through the migration
// checkpoint, not by listing Drive, so a module missing from it is never
// searchable from the hub.
const STATE = join(dirname(fileURLToPath(import.meta.url)), '.migration-state.json')

const argv = process.argv.slice(2)
const DRY  = argv.includes('--dry-run')
const opt  = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
// The positional argument is the one that is not the value of a --flag.
const VALUED = new Set(['--page', '--title', '--emoji', '--category', '--sub'])
const mod  = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]))
const page = opt('page'), title = opt('title') ?? mod, emoji = opt('emoji') ?? '📘'
const category = opt('category'), sub = opt('sub') ?? ''
if (!mod || !page || !category) {
  console.error('usage: node tools/add-module.mjs <Module> --page <path> --category <name> [--title t] [--emoji e] [--sub s] [--dry-run]')
  process.exit(1)
}

const auth  = await authorize()
const drive = driveClient(auth)

const root = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')

const hubFile = await findChild(drive, root.id, 'hub.json')
if (!hubFile) throw new Error('no hub.json in Drive')
const r = await withRetry('download', () =>
  drive.files.get({ fileId: hubFile.id, alt: 'media' }, { responseType: 'text' }))
const hub = typeof r.data === 'string' ? JSON.parse(r.data) : r.data

const cat = hub.categories.find(c => c.name === category)
if (!cat) throw new Error(`hub.json has no category "${category}" (have: ${hub.categories.map(c => c.name).join(', ')})`)
const listed = hub.categories.some(c => c.modules.includes(mod))
const before = JSON.stringify(hub)
hub.modules[mod] = { ...(hub.modules[mod] ?? {}), title, emoji, sub, page }
if (!listed) cat.modules.push(mod)
const hubChanged = JSON.stringify(hub) !== before

const existing = await findChild(drive, root.id, mod)
console.log(`\n  ${mod}: folder ${existing ? 'exists' : 'will be created'}`)
console.log(`  hub.json: ${hubChanged ? (listed ? 'entry updated' : `added under "${category}"`) : 'already current'}`)

// docs-caps.json names the document types this page can draw (see README,
// "Why seventeen pages"); the Java lineage renders markdown, PDF and HTML.
const SEED = {
  'terms.json': {}, 'qa.json': {}, 'topics.json': {}, 'notes.json': {},
  'docs-index.json': [], 'assets-map.json': {}, 'docs-caps.json': { types: ['markdown', 'pdf', 'html'] },
}

if (DRY) { console.log('\n  --dry-run: Drive not written.\n'); process.exit(0) }

const folder = await ensureFolder(drive, root.id, mod)
for (const [name, body] of Object.entries(SEED)) {
  if (await findChild(drive, folder, name)) continue
  await upsertText(drive, folder, name, JSON.stringify(body))
  console.log(`  + ${mod}/${name}`)
}
await ensureFolder(drive, folder, 'docs')
if (hubChanged) await upsertText(drive, root.id, 'hub.json', JSON.stringify(hub, null, 2))

const state = JSON.parse(await readFile(STATE, 'utf8'))
const data  = Object.fromEntries((await listChildren(drive, folder))
  .filter(f => f.name.endsWith('.json')).map(f => [f.name, f.id]))
state.modules[mod] = { docs: {}, images: {}, assets: {}, extras: {}, ...(state.modules[mod] ?? {}), folderId: folder, data }
await writeFile(STATE, JSON.stringify(state, null, 2))
console.log(`  + ${mod} recorded in tools/.migration-state.json`)
console.log(`\n  ✓ ${mod} registered.\n`)
