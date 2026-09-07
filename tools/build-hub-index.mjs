#!/usr/bin/env node
/**
 * Rebuild hub-index.json — the landing page's cross-module term/QA/topic index
 * (what GET /__index__.json returns; it feeds the hub tree, its counts and its
 * search box).
 *
 * The original bake, tools/build-docs-index.py, imports serve_hub.py and reads
 * every module's data files FROM DISK. That content has since been deleted, so
 * that path can no longer run — and the copy in Drive has been frozen at
 * migration time ever since, which is why a term added to a module's terms.json
 * never shows up on the landing page.
 *
 * This reads the same data from Drive instead, and reproduces the structure and
 * (group, label) ordering that app/hub.js already falls back to, so the tree
 * reads identically whichever path produced it.
 *
 *   node tools/build-hub-index.mjs --dry-run     report + tools/out/, Drive untouched
 *   node tools/build-hub-index.mjs               upload
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join }    from 'node:path'
import { fileURLToPath }    from 'node:url'

import { authorize } from './lib/auth.mjs'
import { driveClient, findChild, upsertText, withRetry } from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const OUT   = join(__dir, 'out')
const DRY   = process.argv.includes('--dry-run')

const FILE_OF = { terms: 'terms.json', qa: 'qa.json', topics: 'topics.json' }

/* Same label rule as app/hub.js: first non-empty key, tags stripped. */
function label(entry, keys) {
  for (const k of keys) {
    const v = entry[k]
    if (typeof v === 'string' && v.trim()) {
      const t = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (t) return t
    }
  }
  return entry.id ?? ''
}

function list(obj, ...keys) {
  return Object.entries(obj ?? {})
    .flatMap(([k, v]) => v && typeof v === 'object'
      ? [{ id: v.id ?? k, label: label(v, keys), group: v.group ?? '' }] : [])
    .sort((a, b) => a.group.toLowerCase().localeCompare(b.group.toLowerCase())
                 || a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
}

const auth  = await authorize()
const drive = driveClient(auth)

async function getJson(fileId) {
  const r = await withRetry('download', () =>
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' }))
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data
}

const root = await findChild(drive, null, 'PGHubTechnologies')
if (!root) throw new Error('no PGHubTechnologies folder in Drive')

const hubFile = await findChild(drive, root.id, 'hub.json')
if (!hubFile) throw new Error('no hub.json in Drive')
const hub = await getJson(hubFile.id)

const oldFile = await findChild(drive, root.id, 'hub-index.json')
const old     = oldFile ? await getJson(oldFile.id) : null

console.log('\n  Rebuilding hub-index.json from Drive\n')

const modules = []
for (const [dir, m] of Object.entries(hub.modules ?? {})) {
  const folder = await findChild(drive, root.id, dir)
  if (!folder) { console.log(`  ${dir.padEnd(18)} no Drive folder — skipped`); continue }

  const data = {}
  for (const [type, file] of Object.entries(FILE_OF)) {
    const f = await findChild(drive, folder.id, file)
    data[type] = f ? await getJson(f.id) : {}
  }

  const entry = {
    dir, title: m.title ?? dir, emoji: m.emoji ?? '',
    terms:  list(data.terms, 'title'),
    qa:     list(data.qa, 'question', 'title'),
    topics: list(data.topics, 'title', 'summary'),
  }
  modules.push(entry)

  const was = old?.modules?.find(x => x.dir === dir)
  const d   = was
    ? (entry.terms.length - was.terms.length)
      + (entry.qa.length - was.qa.length)
      + (entry.topics.length - was.topics.length)
    : null
  const delta = d === null ? ' (new)' : d === 0 ? '' : `  \x1b[32m${d > 0 ? '+' : ''}${d}\x1b[0m`
  console.log(`  ${dir.padEnd(18)} ${String(entry.terms.length).padStart(4)} terms  `
            + `${String(entry.qa.length).padStart(4)} Q&A  `
            + `${String(entry.topics.length).padStart(3)} topics${delta}`)
}

const index = { modules }
const text  = JSON.stringify(index)
const sum   = k => modules.reduce((n, m) => n + m[k].length, 0)
const osum  = k => (old?.modules ?? []).reduce((n, m) => n + (m[k]?.length ?? 0), 0)

const line = (k, name) => {
  const [a, b] = [osum(k), sum(k)]
  return `${name}: ${b}${old && a !== b ? ` (was ${a})` : ''}`
}
console.log(`\n  ${modules.length} modules · ${line('terms', 'terms')} · `
          + `${line('qa', 'Q&A')} · ${line('topics', 'topics')}`)
console.log(`  ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`)

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'hub-index.json'), text)

if (DRY) { console.log('\n  dry run — written to tools/out/, Drive untouched\n'); process.exit(0) }

const r = await upsertText(drive, root.id, 'hub-index.json', text)
console.log(`\n  uploaded → ${r.id}\n`)
