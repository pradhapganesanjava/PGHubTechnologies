#!/usr/bin/env python3
"""Rewrite the landing page for the Drive-backed, statically-hosted hub.

index.html assumed seventeen Python servers on localhost ports 8501+: it linked
to http://127.0.0.1:<port>/, probed each port for a "live" dot, and told the
reader to run ./start.command. None of that exists any more — each module is
served as a static page from its own folder, and the content comes from Drive.

The edits are confined to link construction, the liveness probe, the boot order
and the help copy. Navigation also moves into the same tab throughout — the hub
and the modules are one static site now, and build-app.py gives every module
page a home link back here. The tree, browse, preview and practice logic are untouched.

Run once. It refuses to run twice (it detects its own output).

Usage:  python3 tools/build-hub.py [--file index.html]
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SHIM = '''<script>
/* Parks the page's opening fetches until app/hub-boot.js installs the
   Drive-backed handler — module scripts are deferred, this inline app is not.
   See the same shim in each module page. */
(function () {
  var native = window.fetch.bind(window);
  // Published so the store can pass non-app requests straight to the browser.
  // It cannot capture window.fetch itself: by the time its module is imported
  // this shim has already replaced it, so what it would capture is the shim —
  // and passthrough would call back into the handler forever.
  window.__pghubNativeFetch = native;
  var parked = [];
  var handler = null;
  window.__pghubInstall = function (fn) {
    handler = fn;
    var queued = parked.splice(0);
    for (var i = 0; i < queued.length; i++) queued[i]();
  };
  window.fetch = function (input, init) {
    if (handler) return handler(input, init);
    return new Promise(function (resolve, reject) {
      parked.push(function () { (handler || native)(input, init).then(resolve, reject); });
    });
  };
})();
</script>
'''

HOWTO = '''        <h2>▶ About this hub</h2>
        <p>Every term, answer, topic, note and document lives in a private Google
        Drive folder — nothing is stored in this site. Sign in with the account
        that owns that folder and the hub fills itself in. Click a card to open a
        module, or click any item in the left panel / Browse view to preview it
        right here.</p>
        <p>Edits you make in a module are saved straight back to Drive.</p>'''

# (description, old, new) — every one must match exactly once.
EDITS = [
    # ── where a module page lives ─────────────────────────────────────────────
    # Each module is its own app, not one page parameterised by a query string,
    # so the path comes from hub.json rather than being derived from the id.
    # The manifest therefore has to be loaded before the tree is built, which is
    # why boot() below changed too.
    ("module href helper",
     '''let INDEX = { modules: [] };
const LIVE_PORTS = new Set();          // ports the card probe found up; shared with the tree
''',
     '''let INDEX = { modules: [] };
let MAN = { modules: {}, categories: [] };

/* Where a module's app page lives, from hub.json. The seventeen apps are
   separate pages in separate folders — they were seventeen local servers on
   seventeen ports — so there is no pattern to derive this from. */
function modHref(dir, hash){
  const page = MAN.modules?.[dir]?.page;
  return (page || (dir + "/index.html")) + (hash || "");
}
'''),

    ("tree item link",
     '''  return `<a class="ti" target="_blank" rel="noopener"
             href="http://127.0.0.1:${m.port}/${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"
             data-s="${search}"
             title="${label}">${label}${grp}</a>`;''',
     '''  return `<a class="ti"
             href="${modHref(m.dir, HASH[type](it.id))}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"
             data-s="${search}"
             title="${label}">${label}${grp}</a>`;'''),

    ("browse item link",
     '''  return `<a class="ti" target="_blank" rel="noopener"
             href="http://127.0.0.1:${m.port}/${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"
             data-s="${search}"''',
     '''  return `<a class="ti"
             href="${modHref(m.dir, HASH[type](it.id))}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"
             data-s="${search}"'''),

    ("module open link in tree",
     '''function modOpenLink(m){
  return `<a class="mod-open" href="http://127.0.0.1:${m.port}/" target="_blank" rel="noopener"
     data-port="${m.port}" title="Open ${esc(m.title)} — http://127.0.0.1:${m.port}/"><i></i>:${m.port} ↗</a>`;
}''',
     '''function modOpenLink(m){
  return `<a class="mod-open live" href="${modHref(m.dir, "")}"
     title="Open ${esc(m.title)}"><i></i>Open →</a>`;
}'''),

    ("paintModOpen no longer paints liveness",
     '''/* reuse the card probe results so the tree shows the same live dot, and keep a click
   on the link from also toggling the <details> — the handler sits on the link itself so
   the event still reaches it (the module opens) but never bubbles up to the summary */
function paintModOpen(){
  document.querySelectorAll("#tree a.mod-open").forEach(a => {
    a.classList.toggle("live", LIVE_PORTS.has(+a.dataset.port));
    if (a.dataset.wired) return;''',
     '''/* Every module is always reachable now, so there is no liveness to paint — this
   only stops a click on the link from also toggling the enclosing <details>. The
   handler sits on the link itself, so the event still opens the module but never
   bubbles up to the summary. */
function paintModOpen(){
  document.querySelectorAll("#tree a.mod-open").forEach(a => {
    if (a.dataset.wired) return;'''),

    ("browse pill: drop the undefined port",
     '''        `<button class="pill" data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"''',
     '''        `<button class="pill" data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"'''),

    ("practice pool entry",
     '''        dir: m.dir, port: m.port, id: it.id, type: listKey,''',
     '''        dir: m.dir, id: it.id, type: listKey,'''),

    ("practice open link",
     '''  document.getElementById("practiceOpen").href =
    `http://127.0.0.1:${item.port}/${HASH[item.type](item.id)}`;''',
     '''  document.getElementById("practiceOpen").href =
    modHref(item.dir, HASH[item.type](item.id));'''),

    ("preview overlay open link",
     '''  document.getElementById("mOpen").href = `http://127.0.0.1:${ds.port}/${HASH[ds.type](ds.id)}`;''',
     '''  document.getElementById("mOpen").href = modHref(ds.dir, HASH[ds.type](ds.id));'''),

    # ── no ports to probe ─────────────────────────────────────────────────────
    ("liveness probe",
     '''async function loadManifest(){ return (await fetch("hub.json", {cache:"no-store"})).json(); }
async function probe(port){ try{ await fetch("http://127.0.0.1:"+port+"/favicon.ico",{mode:"no-cors",cache:"no-store"}); return true; }catch(e){ return false; } }''',
     '''async function loadManifest(){
  try { MAN = await (await fetch("hub.json", {cache:"no-store"})).json(); }
  catch(e){ MAN = { modules: {}, categories: [] }; throw e; }
  return MAN;
}'''),

    ("module card",
     '''function cardHTML(dir, m){
  return `<a class="card off" data-port="${m.port}" href="http://127.0.0.1:${m.port}/" target="_blank" rel="noopener">
      <div class="top"><span class="ico">${m.emoji||"📚"}</span><span class="t">${esc(m.title)}</span></div>
      <p class="d">${esc(m.sub||"")}</p>
      <div class="foot"><span class="dot"><i></i><span class="lbl">checking…</span></span><span class="go">Open :${m.port} →</span></div>
    </a>`;
}''',
     '''function cardHTML(dir, m){
  return `<a class="card" href="${modHref(dir, "")}">
      <div class="top"><span class="ico">${m.emoji||"📚"}</span><span class="t">${esc(m.title)}</span></div>
      <p class="d">${esc(m.sub||"")}</p>
      <div class="foot"><span class="dot live"><i></i><span class="lbl">in Drive</span></span><span class="go">Open →</span></div>
    </a>`;
}'''),

    ("card render + status",
     '''  let live = 0; const cards = [...document.querySelectorAll(".card")];
  await Promise.all(cards.map(async card => {
    const up = await probe(card.dataset.port), dot = card.querySelector(".dot"), lbl = card.querySelector(".lbl");
    if(up){ card.classList.remove("off"); dot.classList.add("live"); lbl.textContent="live"; live++;
            LIVE_PORTS.add(+card.dataset.port); }
    else { dot.classList.remove("live"); lbl.textContent="offline"; LIVE_PORTS.delete(+card.dataset.port); }
  }));
  paintModOpen();                                   // the tree links share these results
  status.textContent = `${live}/${cards.length} modules live`;''',
     '''  const cards = [...document.querySelectorAll(".card")];
  status.textContent = `${cards.length} modules`;'''),

    ("manifest already loaded by boot",
     '''  let man;
  try { man = await loadManifest(); } catch(e){ status.textContent = "needs server — run ./start.command"; return; }
  document.getElementById("tagline").textContent = man.tagline || document.getElementById("tagline").textContent;
  cats.innerHTML = man.categories.map(c => `''',
     '''  const man = MAN;
  if (!man.categories?.length){ status.textContent = "sign in to load modules"; return; }
  document.getElementById("tagline").textContent = man.tagline || document.getElementById("tagline").textContent;
  cats.innerHTML = man.categories.map(c => `'''),

    # ── the theme travels further than a cookie now ───────────────────────────
    ("theme handoff to app/settings.js",
     '''function applyTheme(name){
  document.documentElement.setAttribute("data-theme", name);
  themeSel.value = name;
  _setCookie("tech_theme", name);
}''',
     '''function applyTheme(name){
  document.documentElement.setAttribute("data-theme", name);
  themeSel.value = name;
  _setCookie("tech_theme", name);
  // Broadcasts to other open pages and mirrors to Drive, once app/settings.js
  // has loaded. The cookie above is the fast path and stands alone.
  window.__pghubSettings?.setTheme(name);
}'''),

    # Recorded location.origin so the modules could link back. They are the same
    # static site now, and under a GitHub Pages subpath the value is wrong.
    ("hub-url cookie",
     '''_setCookie("tech_hub", location.origin + "/");
''',
     ''''''),

    # ── boot order ────────────────────────────────────────────────────────────
    ("boot: manifest before tree",
     '''/* ---- boot ---- */
(async function(){
  await loadIndex();
  buildTree();
  buildBrowse();
  renderCards();
})();''',
     '''/* ---- boot ---- */
(async function(){
  // The manifest carries each module's page path, which the tree and browse
  // links need, so it is no longer left to renderCards to fetch on its own.
  await Promise.all([loadIndex(), loadManifest().catch(() => {})]);
  buildTree();
  buildBrowse();
  renderCards();
})();'''),

    ("refresh: manifest too",
     '''document.getElementById("refresh").onclick = async () => {
  await loadIndex();''',
     '''document.getElementById("refresh").onclick = async () => {
  await Promise.all([loadIndex(), loadManifest().catch(() => {})]);'''),

    # ── copy that described a local setup ─────────────────────────────────────
    ("copy-command button handler",
     '''document.getElementById("copyCmd").onclick = () => navigator.clipboard.writeText("./start.command");
''',
     ''''''),

    ("howto panel",
     '''        <h2>▶ Starting the hub</h2>
        <p>Double-click <code>start.command</code> — it boots every module on its own port and opens this page. Green dot = the module's server is <b>live</b>. Click a card to open a whole module, or click any item in the left panel / Browse view to preview it right here.</p>
        <div class="cmd"><span>./start.command</span> <button class="mini" id="copyCmd">Copy</button></div>''',
     HOWTO),


    # Internal navigation stays in this window. The cards, the tree and browse
    # links, and these two all pointed at a new tab, which turned browsing the
    # hub into a pile of tabs. The arrow glyph changes with them so the label
    # does not promise a tab it no longer opens. build-app.py gives every
    # module page a home link back here.
    ("practice open-in-module link",
     '''<a class="ghost" id="practiceOpen" target="_blank" rel="noopener">Open in module \u2197</a>''',
     '''<a class="ghost" id="practiceOpen">Open in module \u2192</a>'''),

    ("preview overlay open-in-module link",
     '''<a id="mOpen" target="_blank" rel="noopener">Open in module \u2197</a>''',
     '''<a id="mOpen">Open in module \u2192</a>'''),

    ("footnote",
     '''<p class="footnote" id="hubFootnote">Modules &amp; ports are defined in <code>hub.json</code>. The tree, search and previews are built live from each module's data files.</p>''',
     '''<p class="footnote" id="hubFootnote">Content is read from Google Drive. The tree, search and previews are built live from each module's data.</p>'''),

    ("status placeholder",
     '''      <span class="status" id="status">checking…</span>''',
     '''      <span class="status" id="status">loading…</span>'''),

    ("re-check button label",
     '''<button class="mini" id="refresh">🔄 Re-check</button>''',
     '''<button class="mini" id="refresh">🔄 Reload</button>'''),

    ("empty tree hint",
     '''  if (!INDEX.modules.length){ meta.textContent = "run ./start.command to load contents"; tree.innerHTML=""; return; }''',
     '''  if (!INDEX.modules.length){ meta.textContent = "sign in to load contents"; tree.innerHTML=""; return; }'''),

    ("empty browse hint",
     '''  if (!INDEX.modules.length){ el.innerHTML = '<p class="no-results">Run ./start.command to load contents.</p>'; return; }''',
     '''  if (!INDEX.modules.length){ el.innerHTML = '<p class="no-results">Sign in to load contents.</p>'; return; }'''),

    ("empty practice hint",
     '''      : `No ${label} found — run ./start.command`;''',
     '''      : `No ${label} found`;'''),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=os.path.join(ROOT, 'index.html'))
    a = ap.parse_args()

    with open(a.file, encoding='utf-8') as f:
        html = f.read()

    if '__pghubInstall' in html:
        sys.exit('  index.html already rewritten — nothing to do.')

    for desc, old, new in EDITS:
        n = html.count(old)
        if n != 1:
            sys.exit(f'  aborted: "{desc}" matched {n} times (expected 1)')
        html = html.replace(old, new, 1)
        print(f'  ok  {desc}')

    html = html.replace('<head>', '<head>\n' + SHIM, 1)
    idx = html.rindex('</script>') + len('</script>')
    html = html[:idx] + '\n<script type="module" src="app/hub-boot.js"></script>' + html[idx:]
    print('  ok  shim + boot script')

    with open(a.file, 'w', encoding='utf-8') as f:
        f.write(html)

    leftovers = [l for l in ('127.0.0.1', 'start.command', 'probe(', 'LIVE_PORTS')
                 if l in html]
    print(f"\n  wrote {a.file}")
    if leftovers:
        print(f"  note: still mentions {leftovers} — check these are intentional")


if __name__ == '__main__':
    main()
