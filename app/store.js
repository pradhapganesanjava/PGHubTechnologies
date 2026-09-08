/* The data layer — a drop-in replacement for each module's local server.py.
 *
 * The seventeen module apps talk to their backend through the same handful of
 * fetch() calls against relative paths (/terms, /qa, /topics, /notes, /docs,
 * /upload). Rather than edit ~3,500 lines of working application code per
 * module, this module patches window.fetch and answers those paths itself, out
 * of Google Drive. Anything else — Drive's own API, CDN scripts, GitHub link
 * previews — passes straight through untouched.
 *
 * Two behaviours differ from the old servers, both deliberate:
 *
 *   Reads are cached. A module's terms/qa/topics/notes JSON is fetched from
 *   Drive once per session and served from memory afterwards, because a Drive
 *   round trip is ~200ms where a localhost one was ~1ms.
 *
 *   Writes are debounced. The app POSTs once per edited item and the whole
 *   file is rewritten each save, so saving on every keystroke would mean
 *   uploading a 100KB file dozens of times a minute. Edits land in the cache
 *   immediately (so the UI is never wrong) and are flushed to Drive shortly
 *   after the typing stops, plus unconditionally when the page is hidden or
 *   closed. Callers see the same {ok:true} they always did.
 */
import { readModuleJson, writeModuleJson, moduleFolderId, ensureFolder, createFile,
         updateFile, findChild, listFolder, readTextById } from './drive.js'
import { ready } from './ready.js'
import { restoreDriveUrls } from './media.js'
import { patchHubIndex } from './hub-index.js'

// The page's shim stashed the real fetch before replacing window.fetch.
// Binding window.fetch here would capture the shim instead and make
// passthrough recurse into this handler until the stack blows.
const nativeFetch = window.__pghubNativeFetch ?? window.fetch.bind(window)

const FILE_OF = {
  terms:  'terms.json',
  qa:     'qa.json',
  topics: 'topics.json',
  notes:  'notes.json',
}
const FLUSH_MS = 900

// The endpoints this module owns. Matched on the last path segment so the app
// works unchanged under a GitHub Pages subpath.
const OURS = new Set(['terms', 'qa', 'topics', 'notes', 'docs', 'upload'])

export const Store = {
  mod: null,
  _cache: new Map(),        // 'terms' -> object
  _dirty: new Set(),        // kinds awaiting upload
  _timer: null,
  _inFlight: null,
  _docs: null,              // baked docs-index.json
  _caps: null,              // doc types this module's page can render
  _assets: null,            // "assets/hi/x.svg" -> Drive id

  get pendingSaves() { return this._dirty.size },
}

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

// ── cache ────────────────────────────────────────────────────────────────────

async function load(kind) {
  if (Store._cache.has(kind)) return Store._cache.get(kind)
  const data = await readModuleJson(Store.mod, FILE_OF[kind], {})
  Store._cache.set(kind, data && typeof data === 'object' ? data : {})
  return Store._cache.get(kind)
}

function markDirty(kind) {
  Store._dirty.add(kind)
  emit('pghub:dirty', { pending: Store._dirty.size })
  clearTimeout(Store._timer)
  Store._timer = setTimeout(() => { flush() }, FLUSH_MS)
}

/** Upload every dirty file. Serialised so two flushes can't race on one file. */
export async function flush() {
  if (Store._inFlight) return Store._inFlight
  if (!Store._dirty.size) return
  clearTimeout(Store._timer)

  Store._inFlight = (async () => {
    while (Store._dirty.size) {
      const kind = [...Store._dirty][0]
      // Clear the flag BEFORE uploading, not after. An edit that lands while
      // the upload is in flight re-adds it and the loop takes another pass;
      // clearing afterwards would erase that flag and strand the edit in the
      // cache, saved nowhere.
      Store._dirty.delete(kind)
      try {
        await writeModuleJson(Store.mod, FILE_OF[kind] ?? `${kind}.json`,
                              Store._cache.get(kind) ?? {})
        emit('pghub:saved', { kind, pending: Store._dirty.size })
      } catch (e) {
        // Put it back and stop; a later edit or the page-hide flush retries.
        Store._dirty.add(kind)
        emit('pghub:error', { kind, message: e.message })
        break
      }
      // The landing page reads a baked cross-module index, not this file, so a
      // term added here would stay invisible there until someone rebuilt it.
      // Patching it in the same breath is what makes a new term show up on the
      // hub by itself; it writes nothing when the index is already correct.
      // Its own try/catch: the module file is saved either way, and failing to
      // touch the index must not re-queue it or lose the edit.
      try {
        await patchHubIndex(Store.mod, kind, Store._cache.get(kind) ?? {})
      } catch (e) {
        console.warn(`[pghub] hub-index not updated for ${kind}: ${e.message}`)
      }
    }
  })().finally(() => { Store._inFlight = null })

  return Store._inFlight
}

// Never lose an edit to a closed tab. visibilitychange is the reliable one on
// mobile; pagehide covers desktop navigation.
for (const ev of ['pagehide', 'visibilitychange']) {
  window.addEventListener(ev, () => {
    if (document.visibilityState === 'hidden' || ev === 'pagehide') flush()
  })
}
window.addEventListener('beforeunload', e => {
  if (Store._dirty.size) { e.preventDefault(); e.returnValue = '' }
})

// ── documents ────────────────────────────────────────────────────────────────

const EXT_OF = {
  markdown: /\.(md|markdown)$/i,
  pdf:      /\.pdf$/i,
  html:     /\.html?$/i,
}
const typeOf = name =>
  Object.keys(EXT_OF).find(t => EXT_OF[t].test(name)) ?? null

/**
 * Documents added to the Drive folder directly, which the baked index cannot
 * know about.
 *
 * Adding a document used to mean dropping a file into the module's docs/
 * folder. That still works — the folder just lives in Drive now — so the
 * listing is reconciled against the index and anything new is folded in.
 * A new markdown file is read so it can render; a new HTML or PDF is not,
 * since it displays in an iframe from its Drive id alone.
 *
 * `renders` is the module's own list of document types, baked by
 * build-docs-index.py from its old server's load_docs. The seventeen apps are
 * different vintages: Kafka's renderDoc has no iframe branch and draws every
 * entry as markdown, and its docs/ folder holds an .html file its server never
 * listed. Discovery is therefore limited to what this page can actually draw —
 * surfacing that file would hand the app a document it cannot render.
 */
async function discoverNewDocs(known, renders) {
  try {
    const folder = await moduleFolderId(Store.mod)
    const docsId = await findChild(folder, 'docs')
    if (!docsId) return []
    const files = await listFolder(docsId)
    const added = files.filter(f =>
      f.mimeType !== 'application/vnd.google-apps.folder' &&
      renders.includes(typeOf(f.name)) && !known.has(f.name))
    return Promise.all(added.map(async f => {
      const type = typeOf(f.name)
      const base = f.name.replace(EXT_OF[type], '')
      const doc  = { name: f.name, title: base, type, driveId: f.id, markdown: '' }
      if (type === 'markdown') {
        try {
          const md = await readTextById(f.id)
          doc.markdown = md
          const h = md.split('\n').find(l => /^\s*#\s+\S/.test(l))
          if (h) doc.title = h.replace(/^\s*#\s+/, '').trim()
        } catch { /* leave it titled by filename */ }
      }
      return doc
    }))
  } catch { return [] }
}

/**
 * The payload GET /docs used to return, in exactly the shape server.py emitted:
 * {name, title, type, markdown, url}. `url` was "/docs/<file>"; it is now a
 * "drive:<id>" reference that media.js resolves to a blob: URL at render time.
 * Pre-fetching every document to build real URLs up front would be absurd —
 * some modules carry 2 MB PDFs.
 */
async function docsIndex() {
  if (Store._docs) return Store._docs
  const idx  = await readModuleJson(Store.mod, 'docs-index.json', [])
  const caps = await readModuleJson(Store.mod, 'docs-caps.json', {})
  Store._assets = await readModuleJson(Store.mod, 'assets-map.json', {})
  Store._caps = Array.isArray(caps.types) ? caps.types : ['markdown']

  const baked = Array.isArray(idx) ? idx : []
  const all = baked.concat(
    await discoverNewDocs(new Set(baked.map(d => d.name)), Store._caps))

  Store._docs = all.map(d => ({
    ...d,
    markdown: d.markdown ?? '',
    url: d.driveId ? `drive:${d.driveId}` : '',
  // The sidebar shows `title`, so sort by that, as the old server did — it
  // listed the folder with sorted(os.listdir()), which for these libraries is
  // the same order the app then displays.
  })).sort((a, b) => (a.name || '').toLowerCase()
        .localeCompare((b.name || '').toLowerCase()))
  return Store._docs
}

/**
 * POST /docs — put a document into this module's docs/ folder in Drive.
 *
 * Adding a document has always meant putting a file in that folder, and
 * discoverNewDocs folds in whatever it finds there. This is the same act from
 * inside the app, which also lets it do the two things copying a file by hand
 * cannot:
 *
 *   * reuse the file id when the name is already taken, so a document can be
 *     revised without breaking the drive:<id> links already pointing at it, and
 *   * record the type in docs-caps.json — the gate discoverNewDocs consults
 *     before it will surface a file at all. Without that a freshly uploaded
 *     page would sit in Drive and never appear in the listing.
 */
async function handleDocUpload(req) {
  const sent = req.headers.get('X-Filename') || ''
  const name = sent.split(/[\\/]/).pop().trim().replace(/[^A-Za-z0-9._ -]/g, '_')
  const type = typeOf(name)
  if (!type) return json({ error: `Not a document type this hub renders: ${sent}` }, 400)

  const blob = await req.blob()
  if (!blob.size) return json({ error: 'That file is empty' }, 400)

  const docs     = await ensureFolder(await moduleFolderId(Store.mod), 'docs')
  const existing = await findChild(docs, name)
  const driveId  = existing ? await updateFile(existing, blob)
                            : await createFile(docs, name, blob)

  const caps  = await readModuleJson(Store.mod, 'docs-caps.json', {})
  const types = Array.isArray(caps.types) ? caps.types : ['markdown']
  if (!types.includes(type)) {
    await writeModuleJson(Store.mod, 'docs-caps.json', { ...caps, types: [...types, type] })
  }

  // Both are rebuilt by the next GET /docs, which is what the caller triggers.
  Store._docs = null
  Store._caps = null
  return json({ ok: true, name, type, replaced: !!existing, url: `drive:${driveId}` })
}

export function assetMap() { return Store._assets ?? {} }

// ── image upload ─────────────────────────────────────────────────────────────

async function handleUpload(req) {
  const name   = req.headers.get('X-Filename') || `paste-${Date.now()}.png`
  const subdir = req.headers.get('X-Subdir') || ''
  const blob   = await req.blob()

  const modFolder = await moduleFolderId(Store.mod)
  let parent = await ensureFolder(modFolder, 'images')
  if (subdir) parent = await ensureFolder(parent, subdir)

  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
  const id   = await createFile(parent, `${Date.now()}__${safe}`, blob)
  // A drive: URL is stored in the note HTML; media.js swaps it for a blob:
  // URL at render time. Storing the id rather than a signed URL means the
  // reference stays valid forever.
  return json({ url: `drive:${id}` })
}

// ── plumbing ─────────────────────────────────────────────────────────────────

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })

/** Apply one POSTed item to a cached map, mirroring the old server's rules. */
function applyItem(map, item) {
  const id = String(item.id ?? '').trim()
  if (!id) return json({ error: 'Missing id' }, 400)
  delete item._app
  // Any image the media layer resolved is a blob: URL by now; store the
  // durable drive: reference instead.
  if (item._delete) delete map[id]
  else map[id] = restoreDriveUrls(item)
  return json({ ok: true })
}

export function installStore(moduleId) {
  Store.mod = moduleId

  // The page installed a queueing shim before the app's inline script ran
  // (see tools/build-app.py). Hand it the real handler so parked requests
  // replay; fall back to patching fetch directly if the shim isn't present.
  if (typeof window.__pghubInstall === 'function') window.__pghubInstall(handleRequest)
  else window.fetch = handleRequest

  async function handleRequest(input, init = {}) {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url, location.href)

    // Only same-origin app endpoints are ours; everything else is untouched.
    if (url.origin !== location.origin) return nativeFetch(input, init)

    const key = url.pathname.replace(/\/+$/, '').replace(/^.*\//, '')
    if (!OURS.has(key)) return nativeFetch(input, init)

    const method = req.method.toUpperCase()

    // Hold the app's opening requests until there is a token to spend on them.
    await ready

    try {
      if (method === 'GET') {
        if (key in FILE_OF) return json(await load(key))
        if (key === 'docs')  return json(await docsIndex())
      }

      if (method === 'POST') {
        if (key === 'notes') {
          const p  = await req.json()
          const id = String(p.id ?? '').trim()
          if (!id) return json({ error: 'Missing id' }, 400)
          const notes = await load('notes')
          notes[id] = restoreDriveUrls(p.html ?? '')
          markDirty('notes')
          return json({ ok: true })
        }
        if (key === 'terms' || key === 'qa' || key === 'topics') {
          const item = await req.json()
          const map  = await load(key)
          const res  = applyItem(map, item)
          if (res.status === 200) markDirty(key)
          return res
        }
        if (key === 'upload') return await handleUpload(req)
        if (key === 'docs')   return await handleDocUpload(req)
      }
    } catch (e) {
      emit('pghub:error', { message: e.message })
      return json({ error: e.message }, 500)
    }

    return nativeFetch(input, init)
  }
}
