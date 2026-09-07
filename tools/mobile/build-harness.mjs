#!/usr/bin/env node
/**
 * Build an offline copy of the site for layout testing.
 *
 * The pages cannot be screenshotted as they ship: everything is behind a
 * Google sign-in and the content lives in a private Drive folder. This copies
 * the real HTML, real CSS and real rendering code and replaces exactly two
 * modules — the gate, so nothing blocks, and the Drive layer, so there is
 * content to lay out. What gets measured is therefore the actual stylesheet
 * rather than an approximation of it.
 *
 * Fixtures deliberately include the awkward cases: a 600-character Q&A label,
 * deep tag nesting, and document titles long enough to strain the sidebar.
 *
 *   node tools/mobile/build-harness.mjs      → tools/mobile/harness/
 */
import { cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, join }                      from 'node:path'
import { fileURLToPath }                      from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..', '..')
const OUT   = join(__dir, 'harness')

// hub.json is content and lives in Drive; once the local content tree is
// deleted the copy under tools/out/ is what keeps this buildable.
const hub  = JSON.parse(await readFile(join(REPO, 'hub.json'), 'utf8')
  .catch(() => readFile(join(__dir, '..', 'out', 'hub.json'), 'utf8')))
// The real search index if one has been baked, so the hub's search can be
// exercised against actual content rather than a fixture.
const search = await readFile(join(__dir, '..', 'out', 'search-index.json'), 'utf8')
  .then(JSON.parse).catch(() => null)
const mods = Object.keys(hub.modules)
const pageOf = d => hub.modules[d].page

const LONG_QA = 'Consumer group rebalancing stalls under a slow consumer — diagnose and fix. ' +
  'A 24-partition topic has twelve consumers; one takes 40s per poll loop while the rest idle. ' +
  'Walk through what the coordinator does, which timeouts fire in what order, and how the ' +
  'partition assignment ends up after the third rebalance in a row.'

const term = (id, title, group) => [id, { id, title, group,
  lede: 'A space-efficient probabilistic set. Answers definitely-not-present or probably-present.',
  what: '<p>A fixed-size bit array plus <code>k</code> hash functions. It never stores the keys.</p>',
  why:  '<p>Cheap pre-checks before expensive work.</p>' }]

const terms = Object.fromEntries([
  term('gc',         'Garbage Collection',  'Memory'),
  term('heap',       'Heap vs Stack',       'Memory'),
  term('vthreads',   'Virtual Threads',     'Concurrency'),
  term('completable','CompletableFuture',   'Concurrency'),
  term('hashmap',    'HashMap internals',   'Collections'),
  term('bloom',      'Bloom Filter',        'Data Structures'),
  term('wal',        'Write-Ahead Log (WAL) with a deliberately long name to test wrapping', 'Reliability'),
])
const qa = {
  q1: { id:'q1', question: LONG_QA, group:'Operations', answer:'<p>Coordinator, timeouts, assignment.</p>' },
  q2: { id:'q2', question:'What does the JIT do that an AOT compiler cannot?', group:'Runtime', answer:'<p>Profile-guided.</p>' },
}
const topics = { t1: { id:'t1', title:'Core Concepts', group:'Overview',
                       summary:'The ideas everything else builds on.', content:'<p>Body.</p>' } }

const docsIndex = [
  { name:'internals.html', title:'JVM Internals — a long document title that should not blow out the sidebar',
    type:'html', driveId:'D1', text:'jvm internals', tag:'Runtime::Compilation' },
  { name:'notes.md', title:'A Markdown Note', type:'markdown', driveId:'D3',
    markdown:'# A Markdown Note\n\nSome body text.', text:'note', tag:'Untagged' },
]

const GATE_STUB = `
import { markReady } from './ready.js'
export function installGate() { markReady() }   // layout harness: nothing blocks
`

const DRIVE_STUB = `
// Layout harness: fixed content so the pages have something realistic to lay out.
const HUB    = ${JSON.stringify(hub)}
const TERMS  = ${JSON.stringify(terms)}
const QA     = ${JSON.stringify(qa)}
const TOPICS = ${JSON.stringify(topics)}
const DOCS_INDEX = ${JSON.stringify(docsIndex)}
const MODS   = ${JSON.stringify(mods)}
const HUB_INDEX = { modules: MODS.map(dir => ({
  dir, title: HUB.modules[dir].title, emoji: HUB.modules[dir].emoji, page: HUB.modules[dir].page,
  terms:  Object.values(TERMS).map(t => ({ id: t.id, label: t.title, group: t.group })),
  qa:     Object.values(QA).map(q => ({ id: q.id, label: q.question, group: q.group })),
  topics: Object.values(TOPICS).map(t => ({ id: t.id, label: t.title, group: t.group })),
})) }

const SEARCH = ${JSON.stringify(search)}
const ROOT_FILES = {}
export async function readRootJson(name, fb) {
  if (name === 'hub.json')          return HUB
  if (name === 'hub-index.json')    return HUB_INDEX
  if (name === 'search-index.json') return SEARCH
  if (name in ROOT_FILES)        return ROOT_FILES[name]
  return fb
}
export async function readModuleJson(mod, name, fb) {
  if (name === 'terms.json')      return TERMS
  if (name === 'qa.json')         return QA
  if (name === 'topics.json')     return TOPICS
  if (name === 'notes.json')      return {}
  if (name === 'docs-index.json') return DOCS_INDEX
  if (name === 'docs.json')       return Object.fromEntries(DOCS_INDEX.map(d => [d.name, { tag: d.tag, tags: [] }]))
  return fb ?? {}
}
export async function writeModuleJson() { return 'id' }
export async function writeRootJson(name, data) { ROOT_FILES[name] = data; return 'id' }
export async function moduleFolderId() { return 'MOD' }
export async function findChild()   { return null }
export async function listFolder()  { return [] }
export async function readBlobById(){ return new Blob(['<h1>Doc</h1>'], { type: 'text/html' }) }
export async function readTextById(){ return '# Doc' }
export async function readJsonById(id, fb) { return fb ?? {} }
export async function createFile()  { return 'NEW' }
export async function ensureFolder(){ return 'F' }
export async function rootId()      { return 'ROOT' }
export function clearIdCache() {}
`

await rm(OUT, { recursive: true, force: true })
await mkdir(join(OUT, 'app'), { recursive: true })
await cp(join(REPO, 'index.html'), join(OUT, 'index.html'))
await writeFile(join(OUT, 'hub.json'), JSON.stringify(hub))   // may no longer exist on disk
for (const d of mods) {
  await mkdir(join(OUT, d), { recursive: true })
  await cp(join(REPO, pageOf(d)), join(OUT, pageOf(d)))
}
await cp(join(REPO, 'app'),    join(OUT, 'app'),    { recursive: true })
await cp(join(REPO, 'vendor'), join(OUT, 'vendor'), { recursive: true })
await writeFile(join(OUT, 'app', 'gate.js'),  GATE_STUB)
await writeFile(join(OUT, 'app', 'drive.js'), DRIVE_STUB)

// frame.html renders one page in an exactly-390px iframe. Screenshotting the
// frame rather than resizing the browser window guarantees the captured
// viewport is the width being claimed, so pictures and measurements agree.
await writeFile(join(OUT, 'frame.html'), `<!doctype html><meta charset="utf-8"><title>frame</title>
<style>html,body{margin:0;background:#222}iframe{width:390px;height:900px;border:0;display:block}</style>
<iframe id="f"></iframe>
<script>
  const p = new URLSearchParams(location.search);
  const f = document.getElementById('f');
  const w = p.get('w'); if (w) f.style.width = w + 'px';
  const h = p.get('h'); if (h) f.style.height = h + 'px';
  f.src = p.get('t') || 'index.html';
  // Lets a screenshot capture the theme menu, which otherwise needs a click.
  if (p.get('picker')) f.addEventListener('load', () => setTimeout(() => {
    f.contentDocument?.querySelector('#themeSwatches .tp-cur')?.click();
  }, 1200));
  // Drives the hub's search box, so the results view can be measured too — it
  // is rendered after load and so is invisible to diag.html.
  const q = p.get('q');
  if (q) f.addEventListener('load', () => setTimeout(() => {
    const d = f.contentDocument, box = d && d.getElementById('mainSearch');
    if (!box) return;
    box.value = q;
    box.dispatchEvent(new f.contentWindow.Event('input', { bubbles: true }));
  }, 900));
</script>
`)

// diag.html reports horizontal overflow and names the outermost offenders.
const TARGETS = ['index.html', ...mods.map(pageOf)]
await writeFile(join(OUT, 'diag.html'), `<!doctype html><meta charset="utf-8">
<title>overflow diagnostic</title>
<style>
 body{margin:0;font:12px/1.45 ui-monospace,Menlo,monospace;background:#0f1117;color:#e6e8ee}
 #out{padding:10px 12px;white-space:pre-wrap}
 h2{font:600 13px/1.4 system-ui;margin:14px 0 6px;color:#7aa2ff}
 iframe{position:absolute;left:-9999px;width:390px;height:900px;border:0}
 .bad{color:#ff9b9b}.ok{color:#8fe3a6}
</style>
<div id="out">measuring…</div>
<script>
const TARGETS = ${JSON.stringify(TARGETS)};
const W = Number(new URLSearchParams(location.search).get('w')) || 390;
const out = document.getElementById('out');
const lines = [];
let overflowing = 0;
function inspect(doc, label) {
  const de = doc.documentElement, b = doc.body;
  const scrollW = Math.max(de.scrollWidth, b.scrollWidth);
  const over = scrollW > W + 1;
  if (over) overflowing++;
  lines.push('<h2>' + label + '</h2>');
  lines.push('viewport ' + W + 'px · document scrollWidth ' + scrollW + 'px  ' +
    (over ? '<span class="bad">OVERFLOWS by ' + (scrollW - W) + 'px</span>'
          : '<span class="ok">no horizontal overflow</span>'));
  if (!over) return;
  const bad = [];
  for (const el of doc.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= W + 1) continue;
    // A fixed element parked off-screen (the closed drawer) does not make the
    // document scroll; it would only add noise.
    if (doc.defaultView.getComputedStyle(el).position === 'fixed') continue;
    if (bad.some(pp => pp.el.contains(el))) continue;
    bad.push({ el, r });
  }
  for (const { el, r } of bad.slice(0, 14)) {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
    const cs = doc.defaultView.getComputedStyle(el);
    lines.push('  <span class="bad">' + Math.round(r.right) + 'px</span>  ' +
      el.tagName.toLowerCase() + id + cls +
      '   [w ' + Math.round(r.width) + '  min-w ' + cs.minWidth + '  ws ' + cs.whiteSpace + ']');
  }
}
(async () => {
  for (const t of TARGETS) {
    const f = document.createElement('iframe');
    f.style.width = W + 'px';
    f.src = t;
    document.body.appendChild(f);
    await new Promise(r => { f.onload = r; setTimeout(r, 4000); });
    await new Promise(r => setTimeout(r, 900));
    try { inspect(f.contentDocument, t); }
    catch (e) { lines.push('<h2>' + t + '</h2>  could not measure: ' + e.message); }
    f.remove();
  }
  lines.push('');
  lines.push(overflowing
    ? '<span class="bad">' + overflowing + ' of ' + TARGETS.length + ' page(s) overflow at ' + W + 'px</span>'
    : '<span class="ok">all ' + TARGETS.length + ' pages fit ' + W + 'px</span>');
  out.innerHTML = lines.join('\\n');
  document.title = overflowing ? ('OVERFLOW x' + overflowing) : 'clean';
})();
</script>
`)

console.log(`harness built: ${OUT}`)
console.log(`  ${TARGETS.length} page(s) · open diag.html to measure, frame.html?t=<page> to look`)
