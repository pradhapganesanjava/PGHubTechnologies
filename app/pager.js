/* Previous / Next at the foot of every term, Q&A and topic.
 *
 * WHY THE ORDER COMES FROM THE SIDEBAR
 * "Next" should mean the item below this one in the list the reader is looking
 * at, so the list itself is the source of truth: the #nav .term elements, in
 * document order. That is the tree (groups, nested tags, then items) or the
 * flat A–Z list, whichever is showing, and it already contains every item Drive
 * holds — including one added a moment ago — because renderSidebar builds it
 * from the same data the detail pane does. Nothing here keeps its own list, so
 * nothing here can fall behind a new term, a retag or a rename.
 *
 * WHY IT CLICKS THE SIDEBAR ENTRY
 * Opening an item is the page's job: select / selectQA / selectTopic set the
 * section, mark the entry, render, mount notes and write the hash. Those are
 * script-scope functions in each of the eighteen pages, out of a module's
 * reach, but every sidebar entry is wired to navOpen(id). Clicking the entry
 * goes down exactly the path a reader's click does, so deep links, back and
 * the active highlight all behave as they already do.
 *
 * WHY IT WATCHES THE PANE
 * Each select() replaces #detail wholesale, which removes the bar with it, and
 * writes the hash only after rendering. A MutationObserver's callback runs
 * after that synchronous work, so by then the hash names what is on screen.
 */
const BAR_ID = 'pghub-pager'
const KEEP = Symbol('keep')

const CSS = `
#${BAR_ID} {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  margin: 36px 0 8px; padding-top: 20px; border-top: 1px solid var(--border);
}
#${BAR_ID} button {
  display: flex; flex-direction: column; gap: 4px; min-width: 0;
  padding: 12px 16px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--panel-2); color: var(--text); cursor: pointer;
  font: inherit; text-align: left; transition: border-color .15s, background .15s;
}
#${BAR_ID} button:hover, #${BAR_ID} button:focus-visible {
  border-color: var(--accent); background: var(--accent-soft, var(--panel-2)); outline: none;
}
#${BAR_ID} .next { grid-column: 2; text-align: right; align-items: flex-end; }
#${BAR_ID} .dir {
  font-size: 11.5px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--muted);
}
#${BAR_ID} .ttl {
  max-width: 100%; font-size: 14px; font-weight: 600; line-height: 1.35;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
#${BAR_ID} .pos {
  grid-column: 1 / -1; text-align: center; font-size: 11.5px; color: var(--muted);
}
@media (max-width: 560px) {
  #${BAR_ID} { grid-template-columns: 1fr; }
  #${BAR_ID} .next { grid-column: 1; }
}`

// Which sidebar tab each hash belongs to. A bare "#<id>" is a term.
const KINDS = [
  { prefix: 'qa/',    tab: 'navtab-qa',     noun: 'Q&A' },
  { prefix: 'topic/', tab: 'navtab-topics', noun: 'topic' },
  { prefix: '',       tab: 'navtab-terms',  noun: 'term' },
]

export function installPager() {
  const detail = document.getElementById('detail')
  const nav = document.getElementById('nav')
  if (!detail || !nav) return

  document.head.appendChild(
    Object.assign(document.createElement('style'), { textContent: CSS }))

  let queued = false
  const sync = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; render(detail, nav) })
  }
  // The pane: a new item was opened. The sidebar: an item was added, renamed,
  // retagged or deleted, or the view went tree ⇄ flat, so the neighbours moved.
  new MutationObserver(sync).observe(detail, { childList: true })
  new MutationObserver(sync).observe(nav, { childList: true, subtree: true })
  window.addEventListener('hashchange', sync)
  // Filtering hides entries without touching the tree's children.
  document.getElementById('search')?.addEventListener('input', sync)
  sync()
}

/** What the pane is showing, from the hash the page wrote: { id, kind } or null. */
function current() {
  let h = location.hash.slice(1)
  try { h = decodeURIComponent(h) } catch { /* a stray % — use it as written */ }
  if (!h || h === 'docs' || h.startsWith('doc/')) return null
  const kind = KINDS.find(k => h.startsWith(k.prefix))
  return { id: h.slice(kind.prefix.length), kind }
}

function render(detail, nav) {
  const old = document.getElementById(BAR_ID)
  const bar = build(nav)
  if (bar === KEEP) return
  if (!bar) { old?.remove(); return }

  // Same neighbours as the bar already there: leave it, so the observer on the
  // pane is not fed a mutation of our own making.
  if (old && old.dataset.key === bar.dataset.key && old.parentNode === detail
      && old === detail.lastElementChild) return
  old?.remove()
  detail.appendChild(bar)
}

function build(nav) {
  const cur = current()
  if (!cur) return null
  // The sidebar only holds one section at a time. If the reader has switched
  // it to another tab without opening anything, it is not this item's list,
  // so the bar already under the item — built from its own list — stands.
  if (!document.getElementById(cur.kind.tab)?.classList.contains('active')) return KEEP

  // First occurrence wins, should an item ever be listed twice.
  const all = []
  const seen = new Set()
  for (const el of nav.querySelectorAll('.term[data-id]')) {
    if (seen.has(el.dataset.id)) continue
    seen.add(el.dataset.id)
    all.push(el)
  }
  // With a filter typed, step through what the filter shows — unless the open
  // item is itself filtered out, when the whole list is the only sensible one.
  const shown = all.filter(el => !el.classList.contains('hidden'))
  const list = shown.some(el => el.dataset.id === cur.id) ? shown : all

  const i = list.findIndex(el => el.dataset.id === cur.id)
  if (i < 0) return null
  const prev = list[i - 1]
  const next = list[i + 1]
  if (!prev && !next) return null

  const bar = document.createElement('nav')
  bar.id = BAR_ID
  bar.setAttribute('aria-label', `Previous and next ${cur.kind.noun}`)
  bar.dataset.key = [cur.id, i, list.length, label(prev), label(next)].join('\u0000')
  if (prev) bar.appendChild(button('prev', '← Previous', prev))
  if (next) bar.appendChild(button('next', 'Next →', next))

  const pos = document.createElement('div')
  pos.className = 'pos'
  pos.textContent = `${i + 1} of ${list.length}`
  bar.appendChild(pos)
  return bar
}

const label = el => (el?.textContent || '').trim()

function button(cls, dir, target) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  const title = label(target)
  b.title = title
  b.innerHTML = '<span class="dir"></span><span class="ttl"></span>'
  b.firstChild.textContent = dir
  b.lastChild.textContent = title
  const id = target.dataset.id
  b.addEventListener('click', () => go(id))
  return b
}

/** Open an item by clicking its sidebar entry, looked up afresh at click time. */
function go(id) {
  const el = [...document.querySelectorAll('#nav .term[data-id]')]
    .find(e => e.dataset.id === id)
  if (!el) return
  el.click()
  reveal(el)
}

// Keep the sidebar following along: open the groups around the entry and
// bring it into view, as if the reader had scrolled to it and clicked.
function reveal(el) {
  for (let g = el.closest('.group'); g; g = g.parentElement?.closest('.group')) {
    g.classList.remove('collapsed')
  }
  // Only when the sidebar is actually on screen; on a phone it may be closed,
  // and scrolling a hidden list would move the page instead.
  if (el.offsetParent) el.scrollIntoView({ block: 'nearest' })
}
