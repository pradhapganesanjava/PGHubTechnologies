#!/usr/bin/env python3
"""Give every module page a renderDoc branch that can draw an HTML document.

Documents arrive through the Documents page now (app/docs-upload.js), and the
first thing anyone uploads is a saved HTML page. The pages disagree about what
to do with one:

  * ten already test `doc.type === "pdf" || doc.type === "html"` and frame both
  * four test only for "pdf", so an HTML file falls through to the markdown
    branch and its source is rendered as prose
  * four have no framed branch at all — every document goes to renderMarkdown —
    and they are also missing the viewer's CSS, which their media queries
    already reference

The last two groups are what this fixes, so that a document uploaded into any
module renders the same way in all of them. app/store.js only records a type in
docs-caps.json — the gate that decides whether a file is surfaced at all — when
the page can actually draw it, which is why this has to be true everywhere
before uploading HTML is offered everywhere.

Every substitution must match exactly once in the pages that need it, and a
page that already has the branch is left alone, so this is safe to re-run.

Usage:  python3 tools/build-doc-html.py [page.html ...]
"""
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HAS_IT = 'doc.type === "pdf" || doc.type === "html"'

# Group 1: a pdf-only branch, widened to cover html.
NARROW = '  if (doc.type === "pdf") {'
WIDENED = ('  if (doc.type === "pdf" || doc.type === "html") {\n'
           '    // both embed a whole file (PDF viewer / standalone page) in the same framed chrome')

# Group 2: no framed branch at all.
MD_ONLY = ('  markActive(name);\n'
           '  detail.innerHTML = `<div class="markdown-body">${renderMarkdown(doc.markdown)}</div>`;')
FRAMED = '''  markActive(name);
  if (doc.type === "pdf" || doc.type === "html") {
    // both embed a whole file (PDF viewer / standalone page) in the same framed chrome
    detail.innerHTML =
      `<div class="pdf-view">` +
        `<div class="pdf-bar"><span class="pdf-name">${escapeHtml(doc.title || doc.name)}</span>` +
        `<a href="${doc.url}">Open full page →</a></div>` +
        `<iframe class="pdf-frame" src="${doc.url}" title="${escapeHtml(doc.name)}"></iframe>` +
      `</div>`;
  } else {
    detail.innerHTML = `<div class="markdown-body">${renderMarkdown(doc.markdown)}</div>`;
  }'''

# The viewer's own rules, verbatim from the fourteen pages that have them. Their
# media queries already style .pdf-view and .pdf-frame, so only the main block
# is missing.
CSS_ANCHOR = '  .crumbs {'
CSS = '''  .detail:has(.pdf-view) { max-width: 1100px; }
  .pdf-view { display: flex; flex-direction: column; }
  .pdf-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 12px; font-size: 14px; }
  .pdf-bar .pdf-name { font-weight: 650; color: var(--text); }
  .pdf-bar a { color: var(--accent); text-decoration: none; white-space: nowrap; }
  .pdf-bar a:hover { text-decoration: underline; }
  .pdf-frame { width: 100%; height: calc(100vh - 180px); min-height: 480px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
'''


def once(html, old, page, what):
    n = html.count(old)
    if n != 1:
        sys.exit(f'  {page} aborted: "{what}" matched {n} times (expected 1)')
    return html.replace(old, old, 1)  # validated; caller does the swap


def build(page):
    path = os.path.join(ROOT, page)
    with open(path, encoding="utf-8") as f:
        html = f.read()

    if "BUILTIN_GROUPS" not in html:
        return None                              # a document, not an app page
    if HAS_IT in html:
        print(f"  {page:<42} already frames HTML — skipped")
        return False

    if NARROW in html:
        once(html, NARROW, page, "pdf-only branch")
        html = html.replace(NARROW, WIDENED, 1)
        note = "branch widened"
    elif MD_ONLY in html:
        once(html, MD_ONLY, page, "markdown-only renderDoc")
        html = html.replace(MD_ONLY, FRAMED, 1)
        note = "branch added"
    else:
        sys.exit(f"  {page} aborted: renderDoc matches neither known shape")

    if ".pdf-bar {" not in html:
        once(html, CSS_ANCHOR, page, "css anchor")
        html = html.replace(CSS_ANCHOR, CSS + CSS_ANCHOR, 1)
        note += " + viewer css"

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  {page:<42} {note}")
    return True


def main():
    pages = sys.argv[1:] or sorted(
        p for p in glob.glob("*/*.html", root_dir=ROOT)
        if not p.startswith(("app/", "vendor/")))
    done = [build(p) for p in pages]
    print(f"\n  {sum(1 for d in done if d)} page(s) rewritten, "
          f"{sum(1 for d in done if d is False)} already done")


if __name__ == "__main__":
    main()
