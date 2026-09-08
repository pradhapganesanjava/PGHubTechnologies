/* An Upload control on every module's Documents page.
 *
 * A document reached a module by being copied into its docs/ folder — first on
 * disk, now in Drive. That is still the only route, which means adding a page
 * to a module means leaving the module. This puts the same act on the Documents
 * screen: pick a file, it lands in that module's docs/ folder in Drive, and it
 * comes back as a document the app lists, opens and deep-links like any other.
 *
 * WHY IT LIVES HERE AND NOT IN THE PAGES
 * Eighteen module pages, each with its own copy of the docs view. A button
 * added to all of them is eighteen places to drift. The one thing they do share
 * is the markup renderDocsIndex emits — every page builds a .docs-index-head —
 * so mounting against that reaches all eighteen from one file.
 *
 * WHY IT RELOADS AFTERWARDS
 * The pages latch their document list: `let DOCS = [], docsLoaded = false` in a
 * classic script, so both the array and the latch are script-scope bindings
 * that a module cannot see, let alone reset. Re-rendering would redraw the
 * stale list. Reloading with the hash already pointing at the new document
 * costs one Drive read and lands the reader on what they just uploaded, which
 * is where they were going anyway.
 */
const MOUNT_ID = 'pghub-doc-upload'

// What the store will accept; the pages render all three.
const ACCEPT = '.html,.htm,.md,.markdown,.pdf'

let flushPending = null

export function installDocsUpload({ onFlush } = {}) {
  flushPending = onFlush
  const detail = document.getElementById('detail')
  if (!detail) return

  // renderDocsIndex replaces the whole pane, so the control has to be put back
  // every time the reader returns to the listing.
  const sync = () => { if (location.hash === '#docs') mount(detail) }
  new MutationObserver(sync).observe(detail, { childList: true })
  window.addEventListener('hashchange', sync)
  sync()
}

function mount(detail) {
  if (detail.querySelector('#' + MOUNT_ID)) return

  const bar = document.createElement('div')
  bar.id = MOUNT_ID
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:auto'

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = ACCEPT
  input.hidden = true

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '⬆ Upload document'
  btn.title = 'Add an HTML page, Markdown file or PDF to this module’s docs/ folder in Drive'
  btn.style.cssText = 'border:1px solid var(--border);background:var(--panel-2);color:var(--text);'
    + 'padding:6px 13px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:600'
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--accent)' })
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--border)' })

  const status = document.createElement('span')
  status.style.cssText = 'color:var(--muted);font-size:12px'

  btn.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const file = input.files && input.files[0]
    input.value = ''                       // so the same file can be picked twice
    if (file) upload(file, btn, status)
  })

  bar.append(status, btn, input)

  // The head is a flex row on every page, so the control sits on its right.
  // With no documents yet there is no head — the pane is a single paragraph —
  // and the control goes above it instead.
  const head = detail.querySelector('.docs-index-head')
  if (head) head.appendChild(bar)
  else {
    bar.style.margin = '0 0 14px'
    detail.insertBefore(bar, detail.firstChild)
  }
}

async function upload(file, btn, status) {
  btn.disabled = true
  status.style.color = 'var(--muted)'
  status.textContent = `Uploading ${file.name}…`
  try {
    const r = await fetch('/docs', {
      method: 'POST',
      headers: { 'X-Filename': file.name },
      body: file,
    })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(out.error || `Upload failed (${r.status})`)

    status.textContent = out.replaced ? 'Replaced — reopening…' : 'Uploaded — opening…'
    try { await flushPending?.() } catch { /* a pending note save is not worth blocking on */ }
    location.hash = '#doc/' + encodeURIComponent(out.name)
    location.reload()
  } catch (e) {
    status.style.color = '#ff6b6b'
    status.textContent = e.message
    btn.disabled = false
  }
}
