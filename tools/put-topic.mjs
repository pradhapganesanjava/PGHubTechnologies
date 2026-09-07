#!/usr/bin/env node
/**
 * List, or create/replace, one topic in a module's topics.json in Drive.
 *
 * Topics have no BUILTIN seed the way terms do — they are authored in the app
 * and live only in Drive — so there is otherwise no way to write a long one
 * from the terminal, where the content can be kept in a file and reviewed.
 *
 *   node tools/put-topic.mjs Python --list
 *   node tools/put-topic.mjs Python --file topic.json --dry-run
 *   node tools/put-topic.mjs Python --file topic.json
 *
 * The file is {id, group, title, summary, content} — `content` is the HTML the
 * app drops into div.rich. An existing id is replaced in place, keeping its
 * position in the file; a new one is appended.
 */
import { readFile } from 'node:fs/promises'

import { authorize } from './lib/auth.mjs'
import { driveClient, findChild, upsertText, withRetry } from './lib/drive.mjs'

const argv   = process.argv.slice(2)
const DRY    = argv.includes('--dry-run')
const LIST   = argv.includes('--list')
const fileAt = argv.indexOf('--file')
const FILE   = fileAt >= 0 ? argv[fileAt + 1] : null
const mod    = argv.find(a => !a.startsWith('--') && a !== FILE)
if (!mod || (!LIST && !FILE)) {
  console.error('usage: node tools/put-topic.mjs <Module> (--list | --file <topic.json> [--dry-run])')
  process.exit(1)
}

const auth  = await authorize()
const drive = driveClient(auth)

const root = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')
const folder = await findChild(drive, root.id, mod)
if (!folder) throw new Error(`no ${mod} folder in Drive`)
const file = await findChild(drive, folder.id, 'topics.json')

const store = file
  ? await withRetry('download', () =>
      drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' })
    ).then(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data))
  : {}

if (LIST) {
  const byGroup = new Map()
  for (const [id, t] of Object.entries(store)) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, [])
    byGroup.get(t.group).push(`${id.padEnd(28)} ${t.title}`)
  }
  console.log(`\n  ${mod}/topics.json — ${Object.keys(store).length} topics\n`)
  for (const [g, rows] of byGroup) console.log(`  [${g}]\n    ` + rows.join('\n    '))
  console.log()
  process.exit(0)
}

const topic = JSON.parse(await readFile(FILE, 'utf8'))
for (const k of ['id', 'group', 'title']) {
  if (!topic[k]) throw new Error(`topic file is missing "${k}"`)
}

const existed = topic.id in store
store[topic.id] = topic                      // in place when it existed; appended when new

console.log(`\n  ${existed ? '~ replacing' : '+ adding'} "${topic.id}"  [${topic.group}]  ${topic.title}`)
console.log(`    summary ${(topic.summary ?? '').length} chars, content ${(topic.content ?? '').length} chars`)
console.log(`    topics.json: ${Object.keys(store).length} topics`)

if (DRY) { console.log('\n  --dry-run: Drive not written.\n'); process.exit(0) }

await upsertText(drive, folder.id, 'topics.json', JSON.stringify(store), 'application/json')
console.log('\n  ✓ topics.json updated in Drive.\n')
