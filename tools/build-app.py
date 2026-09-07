#!/usr/bin/env python3
"""Point each module's app page at Google Drive instead of its local server.

Seventeen module apps, each ~3,200-4,400 lines, each written against its own
`python3 server.py` on its own port and talking to it through six fetch() calls
on relative paths (/terms, /qa, /topics, /notes, /docs, /upload). None of that
application logic is touched here. app/store.js answers those six paths out of
Drive instead, so all this script does is edit the shell around the app:

  * a fetch shim     -> queues the app's opening requests until the Drive-backed
                        store installs; see the comment in the emitted HTML
  * a hub home link  -> the pages are one static site now and navigation stays
                        in the same tab, so every module needs a way back
  * the module id    -> which Drive folder this page reads
  * the boot module  -> ../app/boot.js
  * theme            -> hands changes to app/settings.js as well as the cookie,
                        so other open tabs and other devices follow
  * mermaid          -> vendored relatively instead of an absolute /vendor path
                        that only ever resolved under the local server
  * a docs latch bug -> loadDocs() marked itself loaded BEFORE its request, so
                        one failed load left the tab permanently claiming the
                        folder was empty. Harmless against localhost; not
                        against a network.
  * stale copy       -> three messages telling the reader to run server.py

The seventeen pages are different vintages and do differ, so every substitution
is required to match exactly once in every page unless it is marked optional,
and the script aborts naming the page and pattern if one does not. Running it
twice is refused per page (it detects its own shim).

Usage:  python3 tools/build-app.py [module ...]
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Runs before the application's inline script, which starts fetching immediately.
SHIM = '''<script>
/* Bridge between the app's startup and the Drive-backed store.
 *
 * The application below is a classic (non-module) script, so it executes during
 * parsing — before app/boot.js, which is a module and therefore deferred. Its
 * first act is to fetch('/terms'), and on a static host that would 404 long
 * before the store exists to answer it.
 *
 * So window.fetch is replaced up front with a version that parks every call.
 * Once the store installs it calls __pghubInstall, the parked calls are
 * replayed into it, and fetch behaves normally from then on. The app just
 * experiences a slightly slow first request.
 */
(function () {
  // Which Drive folder this page's content lives in. Stamped in by
  // tools/build-app.py from the folder the page sits in.
  window.__pghubModule = %s;
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

BOOT_TAG = '<script type="module" src="../app/boot.js"></script>\n'

# (description, old, new, required) — each must match exactly once when required.
EDITS = [
    # The cookie is the fast path and stands alone; settings.js adds the
    # BroadcastChannel hop to other open tabs and the mirror to Drive.
    ("hub home button",
     '''  <header>
    <button id="nav-toggle" class="icon-btn nav-toggle" title="Show / hide navigation">''',
     '''  <header>
    <a id="hub-home-btn" class="icon-btn" href="../" title="Back to PG Hub Technologies" aria-label="Back to PG Hub Technologies">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5L8 2.5l6 5"/><path d="M3.5 6.5V13h9V6.5"/></svg>
    </a>
    <button id="nav-toggle" class="icon-btn nav-toggle" title="Show / hide navigation">''',
     True),

    # 2) The link beside an embedded PDF or standalone page. Its href is the
    #    doc's own reference, which media.js resolves to a blob: URL — and a
    #    blob: URL in a new tab is blocked in some browsers, so it opens in
    #    place instead. The hub navigates in the same tab throughout; this is
    #    the same rule applied inside a module.
    ("document open link opens in place",
     '''        `<a href="${doc.url}" target="_blank" rel="noopener">Open in new tab \u2197</a></div>` +''',
     '''        `<a href="${doc.url}">Open full page \u2192</a></div>` +''',
     False),

    ("theme handoff to app/settings.js",
     '''  _setCookie(THEME_COOKIE, name);                 // tell the hub and the other modules''',
     '''  _setCookie(THEME_COOKIE, name);                 // tell the hub and the other modules
  // Broadcasts to other open pages and mirrors to Drive, once the modules that
  // provide it have loaded. Anchored on the cookie line rather than the end of
  // applyTheme, because AgenticAI's also re-renders the open document.
  window.__pghubSettings?.setTheme(name);''',
     True),

    # Latching before the request meant a single transient failure was
    # permanent. Reads come over the network now, so that is a real risk.
    ("docs load latch",
     '''  if (docsLoaded) return DOCS;
  docsLoaded = true;
  if (SERVER) {
    try {
      const r = await fetch("/docs");
      if (r.ok) DOCS = await r.json();
    } catch (e) { DOCS = []; }
  }
  return DOCS;''',
     '''  if (docsLoaded) return DOCS;
  if (SERVER) {
    try {
      const r = await fetch("/docs");
      if (r.ok) { DOCS = await r.json(); docsLoaded = true; }
    } catch (e) { DOCS = []; }
  } else {
    docsLoaded = true;
  }
  return DOCS;''',
     True),

    ("sidebar docs-offline hint",
     '''        : "Docs load via the local server. Run <code>python3 server.py</code>.";''',
     '''        : "Docs live in Google Drive — sign in to load them.";''',
     True),

    ("docs pane offline hint",
     '''        : "Docs load via the local server. Run <code>python3 server.py</code> and open <code>http://127.0.0.1:8000/</code>."}</p></div>`;''',
     '''        : "Docs live in Google Drive — sign in to load them."}</p></div>`;''',
     True),

    ("paste-image hint",
     '''    label = "Pasted images are saved as files in the <b>images/</b> folder via the local server.";''',
     '''    label = "Pasted images are uploaded to this module's <b>images/</b> folder in Google Drive.";''',
     True),

    ("upload comment",
     '''  // 1) Preferred: local server stores the file in ./images/<subdir>/ and returns a URL''',
     '''  // 1) Preferred: the file goes to this module's images/ folder in Drive, and
  //    a durable drive:<id> reference comes back''',
     True),

    # Only ever resolved under a local server rooted at the repo. AgenticAI is
    # the one page that draws mermaid diagrams, hence "optional".
    ("mermaid vendored relatively",
     '''<script src="/vendor/mermaid.min.js"></script>''',
     '''<script src="../vendor/mermaid.min.js"></script>''',
     False),
]


def app_page(module_dir):
    """The one .html in the folder that IS the app — the rest are documents."""
    d = os.path.join(ROOT, module_dir)
    for fn in sorted(os.listdir(d)):
        if not fn.lower().endswith(".html"):
            continue
        with open(os.path.join(d, fn), encoding="utf-8") as f:
            if "BUILTIN_GROUPS" in f.read():
                return fn
    return None


def build(module_dir):
    fn = app_page(module_dir)
    if not fn:
        sys.exit(f"  {module_dir}: no app page found (none declares BUILTIN_GROUPS)")
    path = os.path.join(ROOT, module_dir, fn)
    with open(path, encoding="utf-8") as f:
        html = f.read()

    if "__pghubInstall" in html:
        print(f"  {module_dir}/{fn}  already wired — skipped")
        return False

    for desc, old, new, required in EDITS:
        n = html.count(old)
        if n == 0 and not required:
            continue
        if n != 1:
            sys.exit(f'  {module_dir}/{fn} aborted: "{desc}" matched {n} times (expected 1)')
        html = html.replace(old, new, 1)

    # shim goes as early as possible: immediately after <head>
    shim = SHIM % json.dumps(module_dir)
    if html.count("<head>") != 1:
        sys.exit(f"  {module_dir}/{fn} aborted: expected exactly one <head>")
    html = html.replace("<head>", "<head>\n" + shim, 1)

    # boot module after the app's inline script closes
    idx = html.rindex("</script>") + len("</script>")
    html = html[:idx] + "\n" + BOOT_TAG + html[idx:]

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  {module_dir}/{fn}  wired  ({len(html.splitlines())} lines)")
    return True


def main():
    hub = json.load(open(os.path.join(ROOT, "hub.json"), encoding="utf-8"))
    mods = sys.argv[1:] or list(hub.get("modules", {}))
    done = sum(build(m) for m in mods)
    print(f"\n  {done} of {len(mods)} page(s) rewritten")


if __name__ == "__main__":
    main()
