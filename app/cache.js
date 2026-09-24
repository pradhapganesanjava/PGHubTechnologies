/* A persistent copy of each module's JSON files, so a page load does not wait
 * on Drive for content it downloaded last time.
 *
 * The store already keeps one copy per session in memory. This keeps one
 * across sessions, in IndexedDB rather than localStorage: a module's qa.json
 * with rich answers runs to a megabyte or more, and localStorage's ~5 MB
 * origin quota is shared with the token and every cached id.
 *
 * Every entry carries the Drive file's `version`, which Drive bumps on any
 * change to the file. The store serves the cached copy at once and then asks
 * Drive for that one number; the file itself is only downloaded again when the
 * number has moved. See revalidate() in store.js.
 *
 * Entries are keyed by the signed-in account as well as the path. The content
 * is private and kept private by the Drive folder's ACL, and a copy on disk
 * sits outside that ACL — so another account signing in on the same browser
 * must never be served it. Signing out wipes the lot.
 *
 * Every call swallows its errors. A browser with IndexedDB blocked (private
 * windows, some embedded views) simply behaves as it did before this existed.
 */
const DB_NAME = 'pghubtechs-cache'
const STORE   = 'files'

let _db = null
function db() {
  return _db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  }).catch(e => { _db = null; throw e })
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(r?.result)
    t.onerror = t.onabort = () => reject(t.error)
  }))
}

const keyOf = (who, mod, name) => `${who}|${mod}/${name}`

/** {data, version, fileId, savedAt} or null. */
export async function cacheGet(who, mod, name) {
  if (!who) return null
  try { return (await tx('readonly', s => s.get(keyOf(who, mod, name)))) ?? null }
  catch { return null }
}

export async function cachePut(who, mod, name, entry) {
  if (!who) return
  try { await tx('readwrite', s => s.put({ ...entry, savedAt: Date.now() }, keyOf(who, mod, name))) }
  catch { /* a missing cache only costs a download */ }
}

/** Drop everything — on sign-out, so private content does not outlive the session. */
export async function cacheClear() {
  try { await tx('readwrite', s => s.clear()) } catch {}
}
