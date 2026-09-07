#!/usr/bin/env node
/**
 * One-time (and re-runnable) migration of every piece of study content out of
 * this repo and into Google Drive, so the repo can go public holding code only.
 *
 * Layout it builds under Drive:
 *
 *   PGHubTechnologies/
 *     PGHubTechnologies Manifest  Google Sheet — module registry + file ids
 *     hub.json                    hub tagline / categories / module metadata
 *     hub-index.json              baked cross-module term/QA/topic index
 *     _assets/<md5>-<name>        doc assets (svg/png/css/js), deduped by content
 *     _extras/<path>              content that belongs to no module (JavaStackPage)
 *     <module>/
 *       terms.json qa.json topics.json notes.json
 *       docs-index.json           baked /docs payload (see build-docs-index.py)
 *       docs-caps.json            which doc types this module's page can render
 *       assets-map.json           "assets/hi/x.svg" -> Drive file id
 *       docs/<file>               the documents themselves
 *       images/<file>             pasted note images
 *       <anything else>           mirrored as-is: Kafka/usecases, Python/drills,
 *                                 MCP's loose notes, AgenticAI's standalone pages
 *
 * Everything is keyed on (parent, name), so re-running adopts what is already
 * in Drive rather than duplicating it, and unchanged files (matching md5) are
 * skipped. Progress is checkpointed to tools/.migration-state.json, so an
 * interrupted run resumes where it stopped.
 *
 * Usage:
 *   node tools/migrate.mjs                 migrate everything
 *   node tools/migrate.mjs --dry-run       report what would happen, touch nothing
 *   node tools/migrate.mjs Java Kafka      migrate just these modules
 *   node tools/migrate.mjs --root NAME     use a different Drive root folder name
 */
import { createHash }                        from 'node:crypto'
import { createReadStream }                  from 'node:fs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative }           from 'node:path'
import { fileURLToPath }                     from 'node:url'

import { authorize } from './lib/auth.mjs'
import {
  driveClient, sheetsClient, ensureFolder, ensureSheet, upsertFile, upsertText, withRetry,
} from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..')
const OUT   = join(__dir, 'out')
const STATE = join(__dir, '.migration-state.json')

const argv     = process.argv.slice(2)
const DRY      = argv.includes('--dry-run')
const rootFlag = argv.indexOf('--root')
const ROOT_NAME = rootFlag >= 0 ? argv[rootFlag + 1] : 'PGHubTechnologies'
const only = argv.filter((a, i) =>
  !a.startsWith('--') && !(rootFlag >= 0 && i === rootFlag + 1))

const DATA_FILES = ['terms.json', 'qa.json', 'topics.json', 'notes.json']

/* Content that belongs to no module. JavaStackPage is a generated single-page
 * export of the Java material (see tools/export_javastack.py) plus its own
 * docs tree; hub.json has never listed it, so it has no module folder to go in.
 * It is still content, and the point of this migration is that no content is
 * left on disk. */
const EXTRA_TREES = ['JavaStackPage']

/* Never uploaded, from anywhere:
 *   - the app itself and its old local server (they stay in the repo)
 *   - editor/OS/Python/Node debris
 *   - a vendored library (mermaid is served from vendor/ at the repo root)
 *   - a checked-in virtualenv: MCP/xplr_mcp/example/.venv is 23 MB of binaries
 *     that pip rebuilds, and is not anybody's study material
 */
const SKIP_NAMES = new Set([
  '.DS_Store', '.gitkeep', 'server.py', 'start.command', 'node_modules',
  '__pycache__', '.venv', 'venv', '.claude', '.git', 'vendor', '.pytest_cache',
  '.ruff_cache', '.mypy_cache', '.idea', '.vscode',
])
const SKIP_EXT = /\.(pyc|pyo|tmp|swp)$/i

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown',
  '.markdown': 'text/markdown', '.pdf': 'application/pdf', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.css': 'text/css',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/plain',
  '.txt': 'text/plain', '.csv': 'text/csv', '.py': 'text/x-python',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.sh': 'text/x-shellscript',
  '.java': 'text/x-java-source', '.sql': 'text/plain', '.proto': 'text/plain',
}
const mimeOf = n => MIME[n.slice(n.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'

async function md5File(p) {
  const h = createHash('md5')
  for await (const c of createReadStream(p)) h.update(c)
  return h.digest('hex')
}

async function walk(dir, base = dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    // .gitkeep only ever existed to keep an empty directory in git; Drive has
    // no such need, and uploading it just litters the folder.
    if (SKIP_NAMES.has(e.name) || e.name.startsWith('._') || SKIP_EXT.test(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p, base))
    else if (e.isFile()) out.push({ abs: p, rel: relative(base, p).split('\\').join('/') })
  }
  return out
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')) }
  catch { return { rootId: null, sheetId: null, assets: {}, modules: {}, extras: {} } }
}
async function saveState(s) {
  if (!DRY) await writeFile(STATE, JSON.stringify(s, null, 2))
}

/**
 * Resolve a nested relative path to its Drive parent folder, creating folders
 * as needed and caching them.
 *
 * Some trees have real subdirectories (JavaStackPage/docs/java/, Kafka/usecases/).
 * Uploading those with their relative path as the *filename* would produce
 * Drive files literally called "java/1. Roadmap.md" — Drive allows a slash in a
 * name, so it silently looks fine and is wrong: the structure is lost and
 * anything listing the folder sees a document with a slash in it.
 */
const folderMemo = new Map()
async function parentFor(drive, rootFolderId, rel) {
  const parts = rel.split('/')
  parts.pop()                                   // drop the filename
  let id = rootFolderId
  for (const part of parts) {
    const key = `${id}/${part}`
    if (!folderMemo.has(key)) folderMemo.set(key, await ensureFolder(drive, id, part))
    id = folderMemo.get(key)
  }
  return id
}
const baseName = rel => rel.split('/').pop()

const bytes = n =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`

/** The one HTML file in a module folder that IS the application, not content. */
async function appHtml(modDir) {
  let names
  try { names = await readdir(modDir) } catch { return null }
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith('.html')) continue
    const text = await readFile(join(modDir, n), 'utf8')
    if (text.includes('BUILTIN_GROUPS')) return n
  }
  return null
}

/**
 * Point a data file's pasted-image URLs at Drive.
 *
 * server.py returned "/images/<subdir>/<name>" for every upload and the app
 * embedded that in the note HTML, so the references are plain root-relative
 * paths keyed exactly on the layout of the images/ folder — which is what
 * `uploaded` maps. Anything under /images/ that has no uploaded counterpart is
 * reported rather than silently left pointing at a path nothing serves.
 */
const IMG_REF = /\/images\/([A-Za-z0-9._\-/]+)/g

function rewriteImageRefs(text, uploaded) {
  if (!text.includes('/images/')) return { out: text, rewrote: 0, unresolved: [] }
  let rewrote = 0
  const unresolved = new Set()
  const out = text.replace(IMG_REF, (whole, rel) => {
    const id = uploaded[rel]
    if (!id) { unresolved.add(whole); return whole }
    rewrote++
    return `drive:${id}`
  })
  return { out, rewrote, unresolved: [...unresolved] }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const hub = JSON.parse(await readFile(join(REPO, 'hub.json'), 'utf8'))
  const modules = only.length ? only : Object.keys(hub.modules)

  console.log(`\n  PG Hub Technologies → Google Drive`)
  console.log(`  root folder: ${ROOT_NAME}`)
  console.log(`  modules:     ${modules.length}${DRY ? '   (DRY RUN — nothing will be written)' : ''}\n`)

  const auth   = await authorize()
  const drive  = driveClient(auth)
  const sheets = sheetsClient(auth)
  const state  = await loadState()

  // ── root + shared asset pool ───────────────────────────────────────────────
  const rootId = DRY ? 'DRY-root' : await ensureFolder(drive, null, ROOT_NAME)
  state.rootId = rootId
  console.log(`  root folder id: ${rootId}`)

  const assetsRootId = DRY ? 'DRY-assets' : await ensureFolder(drive, rootId, '_assets')

  // hub.json describes the hub itself (titles, taglines, categories) — content,
  // so it moves to Drive too and the public landing page fetches it from there.
  if (!DRY) {
    const r = await upsertText(drive, rootId, 'hub.json',
      await readFile(join(REPO, 'hub.json'), 'utf8'))
    state.hubJsonId = r.id
    console.log(`  hub.json → ${r.id}`)

    // The landing page's cross-module content index, baked by
    // build-docs-index.py so the browser doesn't have to read and merge
    // 68 separate data files on every visit.
    try {
      const idx = await readFile(join(OUT, 'hub-index.json'), 'utf8')
      const ri  = await upsertText(drive, rootId, 'hub-index.json', idx)
      state.hubIndexId = ri.id
      console.log(`  hub-index.json → ${ri.id}  (${bytes(Buffer.byteLength(idx))})`)
    } catch {
      console.log(`  hub-index.json ⚠ missing — run: python3 tools/build-docs-index.py`)
    }
  }
  await saveState(state)

  const totals = { files: 0, bytes: 0, skipped: 0 }

  for (const m of modules) {
    const modDir = join(REPO, m)
    try { await stat(modDir) } catch { console.log(`  ${m}: not found — skipped`); continue }

    console.log(`\n  ── ${m} ${'─'.repeat(Math.max(0, 46 - m.length))}`)
    const ms = state.modules[m] ??= { folderId: null, data: {}, docs: {}, images: {}, assets: {}, extras: {} }
    const modId = DRY ? `DRY-${m}` : await ensureFolder(drive, rootId, m)
    ms.folderId = modId

    // ── documents + their assets ─────────────────────────────────────────────
    const docFiles = await walk(join(modDir, 'docs'))
    const plain  = docFiles.filter(f => !f.rel.startsWith('assets/'))
    const assets = docFiles.filter(f =>  f.rel.startsWith('assets/'))

    if (plain.length) {
      const docsId = DRY ? 'DRY-docs' : await ensureFolder(drive, modId, 'docs')
      let n = 0
      for (const f of plain) {
        const size = (await stat(f.abs)).size
        totals.files++; totals.bytes += size
        if (DRY) { n++; continue }
        const md5 = await md5File(f.abs)
        const parent = await parentFor(drive, docsId, f.rel)
        const r = await upsertFile(drive, parent, baseName(f.rel), f.abs, mimeOf(f.rel), md5)
        ms.docs[f.rel] = r.id
        if (r.skipped) totals.skipped++
        if (++n % 25 === 0) { process.stdout.write(`     docs   ${n}/${plain.length}\r`); await saveState(state) }
      }
      console.log(`     docs   ${plain.length} file(s)`)
    }

    // Assets are shared across modules, so they go in one pool keyed by
    // content hash and are uploaded once.
    if (assets.length) {
      let n = 0, reused = 0
      for (const f of assets) {
        const md5  = await md5File(f.abs)
        const size = (await stat(f.abs)).size
        const name = `${md5}-${f.rel.split('/').pop()}`
        if (state.assets[md5]) { ms.assets[f.rel] = state.assets[md5]; reused++; n++; continue }
        totals.files++; totals.bytes += size
        if (DRY) { state.assets[md5] = `DRY-${md5.slice(0, 8)}`; n++; continue }
        const r = await upsertFile(drive, assetsRootId, name, f.abs, mimeOf(name), md5)
        state.assets[md5] = r.id
        ms.assets[f.rel] = r.id
        if (++n % 25 === 0) { process.stdout.write(`     assets ${n}/${assets.length}\r`); await saveState(state) }
      }
      console.log(`     assets ${assets.length} ref(s), ${reused} deduped`)
    }

    // ── note images ──────────────────────────────────────────────────────────
    // Uploaded before the data files, because the data files reference them.
    const imgs = await walk(join(modDir, 'images'))
    if (imgs.length) {
      const imgId = DRY ? 'DRY-img' : await ensureFolder(drive, modId, 'images')
      for (const f of imgs) {
        const size = (await stat(f.abs)).size
        totals.files++; totals.bytes += size
        if (DRY) { ms.images[f.rel] = `DRY-img-${f.rel}`; continue }
        const md5 = await md5File(f.abs)
        const parent = await parentFor(drive, imgId, f.rel)
        const r = await upsertFile(drive, parent, baseName(f.rel), f.abs, mimeOf(f.rel), md5)
        ms.images[f.rel] = r.id
        if (r.skipped) totals.skipped++
      }
      console.log(`     images ${imgs.length} file(s)`)
    }

    // ── data JSON (terms / qa / topics / notes) ──────────────────────────────
    //
    // Pasted images used to be saved to disk by server.py, which answered with
    // the URL it had just created — "/images/qa/qa-a__1782390824744.png" — and
    // the app stored that inside the note's HTML. On a static host nothing
    // serves that path, so every one of those images would render broken.
    //
    // They are rewritten here, on the way up, to the "drive:<id>" reference
    // the app now understands (media.js resolves it to a blob: URL at render
    // time, and store.js writes it back unchanged when the note is saved).
    // Only the uploaded copy is rewritten — the files on disk are untouched,
    // so a re-run reads the same originals and produces the same result.
    for (const f of DATA_FILES) {
      const p = join(modDir, f)
      let text
      try { text = await readFile(p, 'utf8') } catch { continue }
      const { out, rewrote, unresolved } = rewriteImageRefs(text, ms.images)
      text = out
      const size = Buffer.byteLength(text)
      const note = rewrote ? `  ${rewrote} image ref(s) → Drive` : ''
      const warn = unresolved.length
        ? `  ⚠ ${unresolved.length} unresolved: ${unresolved.slice(0, 3).join(', ')}` : ''
      if (DRY) {
        console.log(`     data   ${f.padEnd(14)} ${bytes(size)}${note}${warn}`)
        totals.files++; totals.bytes += size; continue
      }
      const r = await upsertText(drive, modId, f, text)
      ms.data[f] = r.id
      totals.files++; totals.bytes += size
      console.log(`     data   ${f.padEnd(14)} ${bytes(size).padStart(8)}  ${r.id}${note}${warn}`)
    }

    // ── everything else in the folder ────────────────────────────────────────
    // A module is not only terms/qa/topics/docs/images. Kafka carries a
    // usecases/ tree and key_terms.csv, Python has data/ and drills/, MCP two
    // loose analysis notes and an exploratory server, AgenticAI two standalone
    // pages. All of it is study material, none of it fits the four buckets
    // above, and the whole point is that no content stays on disk — so the
    // remainder of the folder is mirrored into Drive with its structure intact.
    const app = await appHtml(modDir)
    const claimed = new Set(DATA_FILES)
    if (app) claimed.add(app)
    const extras = (await walk(modDir)).filter(f =>
      !f.rel.startsWith('docs/') && !f.rel.startsWith('images/') && !claimed.has(f.rel))
    if (extras.length) {
      for (const f of extras) {
        const size = (await stat(f.abs)).size
        totals.files++; totals.bytes += size
        if (DRY) continue
        const md5 = await md5File(f.abs)
        const parent = await parentFor(drive, modId, f.rel)
        const r = await upsertFile(drive, parent, baseName(f.rel), f.abs, mimeOf(f.rel), md5)
        ms.extras[f.rel] = r.id
        if (r.skipped) totals.skipped++
      }
      console.log(`     other  ${extras.length} file(s)`)
    }

    // ── baked docs index, stitched with the Drive ids just assigned ──────────
    let index
    try { index = JSON.parse(await readFile(join(OUT, m, 'docs-index.json'), 'utf8')) }
    catch { index = null }
    if (index) {
      for (const d of index) d.driveId = ms.docs[d.name] ?? null
      const missing = index.filter(d => !d.driveId && !DRY).length
      if (!DRY) {
        const r1 = await upsertText(drive, modId, 'docs-index.json', JSON.stringify(index))
        ms.data['docs-index.json'] = r1.id
        const r2 = await upsertText(drive, modId, 'assets-map.json', JSON.stringify(ms.assets))
        ms.data['assets-map.json'] = r2.id
        try {
          const caps = await readFile(join(OUT, m, 'docs-caps.json'), 'utf8')
          const r3 = await upsertText(drive, modId, 'docs-caps.json', caps)
          ms.data['docs-caps.json'] = r3.id
        } catch { /* store.js falls back to markdown-only discovery */ }
      }
      console.log(`     index  ${index.length} doc(s)${missing ? `  ⚠ ${missing} without a Drive id` : ''}`)
    } else {
      console.log(`     index  ⚠ missing — run: python3 tools/build-docs-index.py ${m}`)
    }

    await saveState(state)
  }

  // ── content outside any module ─────────────────────────────────────────────
  if (!only.length) {
    for (const tree of EXTRA_TREES) {
      const files = await walk(join(REPO, tree))
      if (!files.length) continue
      console.log(`\n  ── _extras/${tree} ${'─'.repeat(Math.max(0, 37 - tree.length))}`)
      const extrasRoot = DRY ? 'DRY-extras' : await ensureFolder(drive, rootId, '_extras')
      const treeId = DRY ? `DRY-${tree}` : await ensureFolder(drive, extrasRoot, tree)
      const es = state.extras[tree] ??= {}
      for (const f of files) {
        const size = (await stat(f.abs)).size
        totals.files++; totals.bytes += size
        if (DRY) continue
        const md5 = await md5File(f.abs)
        const parent = await parentFor(drive, treeId, f.rel)
        const r = await upsertFile(drive, parent, baseName(f.rel), f.abs, mimeOf(f.rel), md5)
        es[f.rel] = r.id
        if (r.skipped) totals.skipped++
      }
      console.log(`     ${files.length} file(s)`)
      await saveState(state)
    }
  }

  // ── manifest spreadsheet ───────────────────────────────────────────────────
  if (!DRY) {
    state.sheetId = await ensureSheet(drive, rootId, 'PGHubTechnologies Manifest')
    await writeManifest(sheets, state.sheetId, hub, state)
    console.log(`\n  manifest sheet: ${state.sheetId}`)
    await saveState(state)
  }

  console.log(`\n  ${totals.files} file(s), ${bytes(totals.bytes)}${totals.skipped ? `, ${totals.skipped} unchanged` : ''}`)
  if (!DRY) {
    console.log(`\n  Drive root id     ${state.rootId}`)
    console.log(`  manifest sheet id ${state.sheetId}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function writeManifest(sheets, sheetId, hub, state) {
  const tabs = {
    Modules: [
      ['dir', 'title', 'emoji', 'sub', 'folder_id', 'terms_id', 'qa_id', 'topics_id',
       'notes_id', 'docs_index_id', 'docs_caps_id', 'assets_map_id',
       'docs', 'images', 'other'],
      ...Object.entries(hub.modules).map(([dir, m]) => {
        const s = state.modules[dir] ?? { data: {} }
        return [dir, m.title ?? dir, m.emoji ?? '', m.sub ?? '', s.folderId ?? '',
          s.data['terms.json'] ?? '', s.data['qa.json'] ?? '', s.data['topics.json'] ?? '',
          s.data['notes.json'] ?? '', s.data['docs-index.json'] ?? '',
          s.data['docs-caps.json'] ?? '', s.data['assets-map.json'] ?? '',
          Object.keys(s.docs ?? {}).length, Object.keys(s.images ?? {}).length,
          Object.keys(s.extras ?? {}).length]
      }),
    ],
    Settings: [
      ['key', 'value'],
      ['root_folder_id', state.rootId ?? ''],
      ['hub_json_id',    state.hubJsonId ?? ''],
      ['hub_index_id',   state.hubIndexId ?? ''],
      ['schema_version', '1'],
      ['migrated_at',    new Date().toISOString()],
    ],
  }

  const meta = await withRetry('sheet get',
    () => sheets.spreadsheets.get({ spreadsheetId: sheetId,
                                    fields: 'sheets.properties(title,sheetId)' }))
  const have = new Set((meta.data.sheets ?? []).map(s => s.properties.title))
  const add  = Object.keys(tabs).filter(t => !have.has(t))
  if (add.length) {
    await withRetry('sheet tabs', () => sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: add.map(title => ({ addSheet: { properties: { title } } })) },
    }))
  }
  // A newly created spreadsheet comes with an empty default sheet. Once our own
  // tabs exist it is just clutter in a file meant to be read by a person.
  // Checked on every run, not only the one that creates the tabs, so a sheet
  // left over from an earlier migration still gets tidied up.
  const defaultTab = (meta.data.sheets ?? []).find(sh => sh.properties.title === 'Sheet1')
  if (defaultTab && !('Sheet1' in tabs)) {
    await withRetry('drop Sheet1', () => sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: defaultTab.properties.sheetId } }] },
    })).catch(() => { /* already gone, or it is the only sheet left */ })
  }

  for (const [title, values] of Object.entries(tabs)) {
    await withRetry(`clear ${title}`,
      () => sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: title }))
    await withRetry(`write ${title}`, () => sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: `${title}!A1`,
      valueInputOption: 'RAW', requestBody: { values },
    }))
  }
}

main().catch(e => { console.error('\n  migration failed:', e.message, '\n'); process.exit(1) })
