#!/usr/bin/env node
/**
 * List, or create/replace, one Q&A in a module's qa.json in Drive.
 *
 * Q&A items have no BUILTIN seed the way terms do — they are authored in the
 * app and live only in Drive — so there is otherwise no way to write a long
 * answer from the terminal, where the content can be kept in a file and
 * reviewed.
 *
 *   node tools/put-qa.mjs ProgramLangs --list
 *   node tools/put-qa.mjs ProgramLangs --file qa.json --dry-run
 *   node tools/put-qa.mjs ProgramLangs --file qa.json
 *
 * The file is {id, group, question, answer} — both are the HTML the app drops
 * into div.rich. An existing id is replaced in place, keeping its position in
 * the file; a new one is appended.
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
  console.error('usage: node tools/put-qa.mjs <Module> (--list | --file <qa.json> [--dry-run])')
  process.exit(1)
}

const stripHtml = s => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const auth  = await authorize()
const drive = driveClient(auth)

const root = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')
const folder = await findChild(drive, root.id, mod)
if (!folder) throw new Error(`no ${mod} folder in Drive`)
const file = await findChild(drive, folder.id, 'qa.json')

const store = file
  ? await withRetry('download', () =>
      drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' })
    ).then(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data))
  : {}

if (LIST) {
  const byGroup = new Map()
  for (const [id, q] of Object.entries(store)) {
    if (!byGroup.has(q.group)) byGroup.set(q.group, [])
    byGroup.get(q.group).push(`${id.padEnd(44)} ${stripHtml(q.question).slice(0, 80)}`)
  }
  console.log(`\n  ${mod}/qa.json — ${Object.keys(store).length} questions\n`)
  for (const [g, rows] of byGroup) console.log(`  [${g}]\n    ` + rows.join('\n    '))
  console.log()
  process.exit(0)
}

const item = JSON.parse(await readFile(FILE, 'utf8'))
for (const k of ['id', 'group', 'question']) {
  if (!item[k]) throw new Error(`qa file is missing "${k}"`)
}
item.qa = true                               // the flag the app's own writer stamps on

const existed = item.id in store
store[item.id] = item                        // in place when it existed; appended when new

console.log(`\n  ${existed ? '~ replacing' : '+ adding'} "${item.id}"  [${item.group}]`)
console.log(`    ${stripHtml(item.question).slice(0, 100)}`)
console.log(`    question ${(item.question ?? '').length} chars, answer ${(item.answer ?? '').length} chars`)
console.log(`    qa.json: ${Object.keys(store).length} questions`)

if (DRY) { console.log('\n  --dry-run: Drive not written.\n'); process.exit(0) }

await upsertText(drive, folder.id, 'qa.json', JSON.stringify(store), 'application/json')
console.log('\n  ✓ qa.json updated in Drive.\n')
