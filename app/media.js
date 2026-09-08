/* Renders Drive-hosted bytes inside a page that expects ordinary URLs.
 *
 * Two things in the app reference files by URL rather than by fetch(): the
 * <iframe> that displays an HTML or PDF document, and the <img> tags inside
 * saved notes. Both now carry a "drive:<fileId>" URL, which a browser cannot
 * load on its own — Drive needs an Authorization header. This module watches
 * the DOM and swaps those for blob: URLs, which browsers treat as ordinary
 * same-origin content.
 *
 * HTML documents get one extra step. They were authored alongside an assets/
 * folder and still reference it relatively ("assets/hi/x.svg"), but a blob:
 * URL has no directory to resolve against, so every one of those links would
 * break. Before building the blob we rewrite each relative asset reference to
 * the blob: URL of that asset in Drive, using the assets-map.json produced
 * during migration.
 */
import { readBlobById } from './drive.js'
import { assetMap }     from './store.js'

const blobs = new Map()        // driveId | 'html:'+driveId -> blob: URL
const inFlight = new Map()
// The reverse direction, and the reason it exists: the note editor saves
// whatever is in the DOM (serialize() returns innerHTML), and by then this
// module has rewritten every <img src="drive:…"> to a blob: URL. Persisting
// those would store a reference that dies with the page. The store consults
// this map on save to put the drive: URL back. See restoreDriveUrls.
const blobToDrive = new Map()

/** Drive id -> blob: URL, fetched once and reused. */
export async function driveBlobUrl(id) {
  if (blobs.has(id)) return blobs.get(id)
  if (inFlight.has(id)) return inFlight.get(id)
  const p = (async () => {
    const blob = await readBlobById(id)
    const url  = URL.createObjectURL(blob)
    blobs.set(id, url)
    blobToDrive.set(url, `drive:${id}`)
    return url
  })().finally(() => inFlight.delete(id))
  inFlight.set(id, p)
  return p
}

const ASSET_REF = /(["'(])(?:\.\/)?(assets\/[A-Za-z0-9._\-/]+)(["')])/g

/* Assets that are third-party libraries rather than anyone's content, and are
 * already served from this site. Mermaid is 3.3 MB: pulling it out of Drive on
 * every session added ten seconds to opening any document that draws a diagram,
 * to fetch a public library the repo ships anyway. Served locally it is a
 * normal cached static file. Keyed by the path the documents reference. */
const VENDORED = {
  'assets/js/mermaid.min.js': 'vendor/mermaid.min.js',
}

/**
 * Fetch an HTML document and return a blob: URL for a self-contained copy,
 * with its relative asset references pointed at Drive.
 */
async function htmlDocUrl(id, blob) {
  const key = 'html:' + id
  if (blobs.has(key)) return blobs.get(key)
  // A document is referenced twice — the iframe that displays it and the link
  // that opens it full page — and both resolve at render time. Without this
  // they race and download it twice.
  if (inFlight.has(key)) return inFlight.get(key)
  const p = buildHtmlDoc(id, blob, key).finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

async function buildHtmlDoc(id, blob, key) {

  // The caller already downloaded the document to sniff its type; reuse it
  // rather than fetching the same (sometimes large) file a second time.
  const raw  = await (blob ?? await readBlobById(id)).text()
  const map  = assetMap()

  // Resolve only the assets this document actually mentions, and only those
  // that are not served from this site already.
  const resolved = new Map()
  const wanted = new Set()
  for (const m of raw.matchAll(ASSET_REF)) {
    const rel = m[2]
    if (VENDORED[rel]) resolved.set(rel, new URL(VENDORED[rel], location.href).href)
    else if (map[rel]) wanted.add(rel)
  }
  await Promise.all([...wanted].map(async rel => {
    try { resolved.set(rel, await driveBlobUrl(map[rel])) } catch { /* leave broken */ }
  }))

  const html = raw.replace(ASSET_REF, (whole, open, rel, close) =>
    resolved.has(rel) ? `${open}${resolved.get(rel)}${close}` : whole)

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  blobs.set(key, url)
  blobToDrive.set(url, `drive:${id}`)
  return url
}

// Deliberately plain and theme-neutral: it flashes briefly inside a frame
// whose own stylesheet has not loaded yet.
const LOADING_HTML =
  '<!doctype html><meta charset="utf-8">' +
  '<style>html,body{height:100%;margin:0}' +
  'body{display:flex;align-items:center;justify-content:center;' +
  'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#8b93a1;' +
  'background:#fff}' +
  '@media(prefers-color-scheme:dark){body{background:#161922;color:#8b93a1}}' +
  '</style><div>Loading from Drive…</div>'

/** Swap the placeholder for the real document. srcdoc must go first: while it
 *  is present the browser ignores src entirely. */
function showFrame(el, url) {
  el.removeAttribute('srcdoc')
  el.setAttribute('src', url)
}

/* Elements still resolving, so a click on one can wait for the answer rather
   than falling through to a URL no browser can open. */
const pending = new WeakMap()          // element -> the resolve promise

/* Where each kind of element carries its drive: reference. A frame's is on
   data-src rather than src: written into src the browser would try to load the
   scheme itself, before any observer could swap it, and log an error for a URL
   that was never addressed to it. See tools/build-doc-html.py. */
const REF_ATTR = { A: 'href', IFRAME: 'data-src' }

function resolveElement(el) {
  const attr = REF_ATTR[el.tagName] ?? 'src'
  const ref = el.getAttribute(attr) || ''
  if (!ref.startsWith('drive:')) return
  const id = ref.slice('drive:'.length)
  if (!id) return
  // The observer sees both the added node and the src attribute, so the same
  // element can arrive twice; without this the document is downloaded twice.
  if (el.dataset.driveResolving === id) return pending.get(el)
  el.dataset.driveResolving = id
  el.dataset.driveId = id

  // A drive: href is a live navigation target from the moment it is in the
  // DOM, and the scheme has no handler — clicking one before it resolves fails
  // with "scheme does not have a registered handler" and nothing opens. Take
  // the href off while it resolves; the delegated handler below makes a click
  // in the meantime wait for the real URL instead of being swallowed.
  if (el.tagName === 'A') {
    el.removeAttribute('href')
    el.dataset.drivePending = '1'
    el.style.cursor = 'pointer'
    el.title = 'Loading from Drive…'
  }

  const done = resolveRef(el, id)
  pending.set(el, done)
  return done
}

async function resolveRef(el, id) {
  try {
    if (el.tagName === 'IMG') {
      el.setAttribute('src', await driveBlobUrl(id))
      return
    }
    // An HTML document needs its relative assets rewritten before it can load
    // from a blob: URL; anything else (PDF, PNG) is handed over as-is.
    const isFrame = el.tagName === 'IFRAME'
    const cached = blobs.get('html:' + id) ?? blobs.get(id)
    if (cached) {
      if (isFrame) showFrame(el, cached); else settleLink(el, cached)
      return
    }

    // Downloading a document and its assets takes a beat, and an iframe whose
    // src it cannot load renders as a blank white box — indistinguishable from
    // a broken page. srcdoc takes precedence over src, so a placeholder can be
    // shown in place without touching the surrounding layout.
    if (isFrame) el.srcdoc = LOADING_HTML

    const blob = await readBlobById(id)
    let url
    if (blob.type.includes('html')) {
      url = await htmlDocUrl(id, blob)
    } else {
      url = URL.createObjectURL(blob)
      blobs.set(id, url)
      blobToDrive.set(url, `drive:${id}`)
    }
    if (isFrame) showFrame(el, url); else settleLink(el, url)
  } catch (e) {
    delete el.dataset.driveResolving          // let a later attempt retry
    // A failed <img> shows its alt text, but a failed <iframe> just sits there
    // blank, which is indistinguishable from a slow load and impossible to
    // diagnose. Say what happened, in the frame's place.
    console.warn(`[pghub] could not load drive:${id} —`, e)
    if (el.tagName === 'IMG') {
      el.alt = `[unavailable: ${e.message}]`
    } else if (el.tagName === 'A') {
      el.removeAttribute('href')
      delete el.dataset.drivePending
      el.style.cursor = ''
      el.title = `Unavailable — ${e.message}`
    } else {
      el.removeAttribute('srcdoc')
      const note = document.createElement('div')
      note.className = 'pghub-doc-error'
      note.style.cssText = 'padding:1.25rem;color:var(--muted,#9aa3b2);' +
                           'font:14px/1.6 system-ui,sans-serif'
      note.textContent = `This document could not be loaded from Drive — ${e.message}`
      el.replaceWith(note)
    }
  }
}

/** Hand a link its real URL and let it behave like a link again. */
function settleLink(el, url) {
  el.setAttribute('href', url)
  delete el.dataset.drivePending
  el.style.cursor = ''
  el.removeAttribute('title')
}

const DRIVE_REFS = 'img[src^="drive:"], iframe[data-src^="drive:"], a[href^="drive:"]'

function scan(root) {
  if (!root || root.nodeType !== 1) return
  if (root.matches?.(DRIVE_REFS)) resolveElement(root)
  root.querySelectorAll?.(DRIVE_REFS).forEach(resolveElement)
}

/**
 * Put drive: URLs back wherever this module swapped in a blob: URL.
 * Called by the store on every write, so what is persisted always references
 * Drive rather than a URL that expires with the page.
 */
export function restoreDriveUrls(value) {
  if (typeof value === 'string') {
    if (!value.includes('blob:')) return value
    let out = value
    for (const [blobUrl, driveUrl] of blobToDrive) {
      if (out.includes(blobUrl)) out = out.replaceAll(blobUrl, driveUrl)
    }
    return out
  }
  if (Array.isArray(value)) return value.map(restoreDriveUrls)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k in value) out[k] = restoreDriveUrls(value[k])
    return out
  }
  return value
}

/* Test hook: lets the store's test suite register a mapping without a DOM or a
   real Drive round trip. Harmless in production — nothing calls it there. */
export function __test_register(blobUrl, driveUrl) { blobToDrive.set(blobUrl, driveUrl) }

export function installMedia() {
  scan(document.body)

  // "Open full page" is reachable while its document is still downloading.
  // Capture the click, wait for the URL the frame is already fetching, then
  // follow it — the alternative is a click that silently does nothing.
  document.addEventListener('click', e => {
    const a = e.target?.closest?.('a[data-drive-pending]')
    if (!a) return
    e.preventDefault()
    pending.get(a)?.then(() => {
      const href = a.getAttribute('href')
      if (href) location.href = href
    })
  }, true)

  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') { scan(m.target); continue }
      m.addedNodes.forEach(scan)
    }
  }).observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'href'],
  })
  window.addEventListener('pagehide', () => {
    for (const u of blobs.values()) { try { URL.revokeObjectURL(u) } catch {} }
    blobs.clear()
  })
}
