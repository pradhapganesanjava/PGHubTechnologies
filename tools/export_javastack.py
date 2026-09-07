#!/usr/bin/env python3
"""
Build JavaStackPage/ — a standalone, server-free consolidation of the
Java, Microservice and SpringFramework note apps.

    python3 tools/export_javastack.py

Needs the module content on disk (terms.json, docs/, images/), which now lives
in Google Drive — see "The tools need a content checkout" in the README.

Output:
    JavaStackPage/index.html      everything (terms, QA, topics, .md docs) inlined
    JavaStackPage/docs/<stack>/   the big standalone .html / .pdf docs, copied verbatim
    JavaStackPage/assets/<stack>/ note images, if any
    JavaStackPage.zip             the shareable archive

The recipient unzips and double-clicks index.html — no Python, no server.
"""

import html
import json
import os
import re
import shutil
import zipfile

# The repo root, one level up: this script lives in tools/ but reads the module
# folders and writes JavaStackPage/ beside them.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "JavaStackPage")

# folder, app html, id, label, short letter, blurb
APPS = [
    ("Java", "JavaNotes.html", "java", "Java", "J",
     "Language & platform — syntax, JVM, collections, concurrency, modern features"),
    ("Microservice", "MicroserviceNotes.html", "microservices", "Microservices", "M",
     "Boundaries, resilience, data consistency, deployment & observability"),
    ("SpringFramework", "SpringNotes.html", "spring", "Spring", "S",
     "IoC container, Boot, Data/JPA, MVC, Security, testing"),
]

CSS_SOURCE = ("Java", "JavaNotes.html")          # base stylesheet
CSS_EXTRA = ("SpringFramework", "SpringNotes.html")  # pull the .variant* rules from here


# ---------------------------------------------------------------- CSS

def style_block(folder, filename):
    src = open(os.path.join(ROOT, folder, filename), encoding="utf-8").read()
    return re.search(r"<style>(.*?)</style>", src, re.S).group(1)


def rules_matching(css, prefix):
    """Return whole rule blocks whose selector starts with `prefix`."""
    out = []
    for m in re.finditer(r"([^{}]*)\{([^{}]*)\}", css):
        sel = m.group(1).strip().split("\n")[-1].strip()
        if sel.startswith(prefix):
            out.append("  %s {%s}" % (sel, m.group(2)))
    return "\n".join(out)


def build_css():
    base = style_block(*CSS_SOURCE)
    extra = rules_matching(style_block(*CSS_EXTRA), ".variant")
    return base + "\n\n  /* ---- pulled in from SpringNotes (variant blocks) ---- */\n" + extra + EXPORT_CSS


# extra styling this consolidated reader needs on top of the app stylesheet
EXPORT_CSS = r"""

  /* ================= JavaStackPage additions ================= */
  .stack-tabs { display: flex; gap: 4px; background: var(--panel-2); padding: 4px;
                border-radius: 10px; border: 1px solid var(--border); }
  .stack-tabs button { border: 0; background: transparent; color: var(--muted); cursor: pointer;
                       padding: 7px 14px; border-radius: 7px; font-size: 13px; font-weight: 600;
                       font-family: inherit; white-space: nowrap; }
  .stack-tabs button:hover { color: var(--text); }
  .stack-tabs button.active { background: var(--accent); color: var(--accent-ink); }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 6px;
         vertical-align: 1px; }
  .st-java { background: #f89820; }
  .st-microservices { background: #16b1a0; }
  .st-spring { background: #6db33f; }
  .stack-chip { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .06em;
                text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
                background: var(--chip); color: var(--muted); margin-right: 8px; }
  .term .stack-chip { margin-right: 6px; flex: 0 0 auto; }

  .home { max-width: 980px; }
  .home h2 { margin: 0 0 6px; font-size: 26px; }
  .home > p.lede { margin-bottom: 30px; }
  .home-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px;
                margin-bottom: 34px; }
  .home-card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px;
               padding: 16px 18px; cursor: pointer; }
  .home-card:hover { border-color: var(--accent); }
  .home-card h3 { margin: 0 0 6px; font-size: 16px; color: var(--text);
                  text-transform: none; letter-spacing: 0; }
  .home-card p { margin: 0 0 12px; font-size: 13px; color: var(--muted); line-height: 1.55; }
  .home-stats { display: flex; flex-wrap: wrap; gap: 6px; }
  .home-stats span { font-size: 11px; color: var(--muted); background: var(--chip);
                     padding: 2px 8px; border-radius: 999px; }
  .home-note { border: 1px solid var(--border); border-left: 3px solid var(--accent);
               background: var(--panel); border-radius: 8px; padding: 14px 16px;
               font-size: 13.5px; line-height: 1.65; color: var(--muted); }
  .home-note b { color: var(--text); }

  .ov-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .ov-item { border: 1px solid var(--border); background: var(--panel); border-radius: 9px;
             padding: 10px 12px; cursor: pointer; }
  .ov-item:hover { border-color: var(--accent); }
  .ov-item .t { font-size: 13.5px; font-weight: 600; margin-bottom: 3px; }
  .ov-item .d { font-size: 12px; color: var(--muted); line-height: 1.5;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                overflow: hidden; }

  .doc-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  .doc-head h2 { margin: 0; font-size: 22px; }
  .doc-open { border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
              padding: 7px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
              text-decoration: none; }
  .doc-open:hover { border-color: var(--accent); color: var(--accent); }
  .doc-frame { width: 100%; height: calc(100vh - 210px); min-height: 460px;
               border: 1px solid var(--border); border-radius: 10px; background: #fff; }
  .doc-hint { font-size: 12.5px; color: var(--muted); margin: 10px 0 0; line-height: 1.6; }
  .md-body { max-width: 860px; }
  .md-body h1 { font-size: 26px; margin: 26px 0 10px; }
  .md-body h2 { font-size: 20px; margin: 24px 0 10px; }
  .md-body h3 { font-size: 16px; margin: 20px 0 8px; color: var(--text);
                text-transform: none; letter-spacing: 0; }
  .md-body p, .md-body li { font-size: 15px; line-height: 1.7; }
  .md-body code { font-size: 13px; }
  .md-body table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13.5px; }
  .md-body th, .md-body td { border: 1px solid var(--border); padding: 7px 10px;
                             text-align: left; vertical-align: top; }
  .md-body th { background: var(--panel-2); font-weight: 650; }
  .md-body blockquote { border-left: 3px solid var(--accent); margin: 12px 0; padding: 2px 0 2px 14px;
                        color: var(--muted); }
  .md-body hr { border: 0; border-top: 1px solid var(--border); margin: 22px 0; }
  .md-body a { color: var(--accent); }

  .search-box { flex: 1; min-width: 180px; }
  .sv-head input { width: 100%; background: var(--panel); border: 1px solid var(--border);
                   color: var(--text); border-radius: 9px; padding: 11px 14px; font-size: 15px;
                   font-family: inherit; outline: none; }
  .sv-head input:focus { border-color: var(--accent); }
  .sr-hit { cursor: pointer; }
  .nav-empty { color: var(--muted); font-size: 12.5px; padding: 10px; line-height: 1.55; }
  .print-only { display: none; }
  @media print {
    header, aside, .doc-frame { display: none !important; }
    main { padding: 0; overflow: visible; }
    .print-only { display: block; }
  }
"""


# ---------------------------------------------------------------- data

def read_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def doc_title(name, text=None):
    if text:
        m = re.search(r"^\s*#\s+(.+)$", text, re.M)
        if m:
            return m.group(1).strip()
        m = re.search(r"<title>(.*?)</title>", text, re.S | re.I)
        if m:
            return html.unescape(m.group(1)).strip()
    stem = os.path.splitext(name)[0]
    return re.sub(r"[-_]+", " ", stem).strip().title()


def collect_docs(folder, stack_id, out_dir):
    """Inline .md docs; copy .html/.pdf next to index.html and link them."""
    src_dir = os.path.join(ROOT, folder, "docs")
    docs = []
    if not os.path.isdir(src_dir):
        return docs
    for name in sorted(os.listdir(src_dir)):
        path = os.path.join(src_dir, name)
        if name.startswith(".") or not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        doc_id = re.sub(r"[^a-z0-9]+", "-", os.path.splitext(name)[0].lower()).strip("-")
        if ext in (".md", ".markdown", ".txt"):
            text = open(path, encoding="utf-8", errors="replace").read()
            docs.append({"id": doc_id, "name": name, "kind": "md",
                         "title": doc_title(name, text), "md": text})
        elif ext in (".html", ".htm", ".pdf"):
            dest_dir = os.path.join(out_dir, "docs", stack_id)
            os.makedirs(dest_dir, exist_ok=True)
            shutil.copy2(path, os.path.join(dest_dir, name))
            head = ""
            if ext != ".pdf":
                with open(path, encoding="utf-8", errors="replace") as fh:
                    head = fh.read(8000)
            docs.append({"id": doc_id, "name": name,
                         "kind": "pdf" if ext == ".pdf" else "html",
                         "title": doc_title(name, head),
                         "file": "docs/%s/%s" % (stack_id, name),
                         "size": os.path.getsize(path)})
    return docs


def copy_images(folder, stack_id, out_dir):
    """Copy note images if the app stored any; returns True when something moved."""
    src = os.path.join(ROOT, folder, "images")
    if not os.path.isdir(src):
        return False
    has_files = any(
        os.path.isfile(os.path.join(dp, f))
        for dp, _, fs in os.walk(src) for f in fs
    )
    if not has_files:
        return False
    dest = os.path.join(out_dir, "assets", stack_id)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    return True


def retarget_images(obj, stack_id):
    """Rewrite `images/...` note-image srcs to the exported assets/<stack>/... path."""
    if isinstance(obj, str):
        return obj.replace('src="images/', 'src="assets/%s/' % stack_id) \
                  .replace("src='images/", "src='assets/%s/" % stack_id)
    if isinstance(obj, list):
        return [retarget_images(v, stack_id) for v in obj]
    if isinstance(obj, dict):
        return {k: retarget_images(v, stack_id) for k, v in obj.items()}
    return obj


def build_data(out_dir):
    stacks = []
    for folder, app_html, sid, label, letter, blurb in APPS:
        base = os.path.join(ROOT, folder)
        copy_images(folder, sid, out_dir)
        stack = {
            "id": sid, "label": label, "letter": letter, "blurb": blurb, "source": folder,
            "terms": read_json(os.path.join(base, "terms.json")),
            "qa": read_json(os.path.join(base, "qa.json")),
            "topics": read_json(os.path.join(base, "topics.json")),
            "notes": read_json(os.path.join(base, "notes.json")),
            "docs": collect_docs(folder, sid, out_dir),
        }
        stacks.append(retarget_images(stack, sid))
    return {"stacks": stacks}


def js_literal(data):
    """JSON safe to drop straight into a <script> tag."""
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028") \
            .replace("\u2029", "\\u2029")


# ---------------------------------------------------------------- page

BODY = r"""
<header>
  <button id="nav-toggle" class="icon-btn nav-toggle" title="Show / hide navigation">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
  </button>
  <div class="logo" id="brand-logo">JS</div>
  <div>
    <h1 id="brand-title">Java Stack</h1>
    <div class="sub" id="brand-sub">Java &middot; Microservices &middot; Spring &mdash; offline reference</div>
  </div>
  <div class="header-right">
    <div class="stack-tabs" id="stack-tabs"></div>
    <div class="tabs">
      <button class="tab-btn" data-view="home">Home</button>
      <button class="tab-btn" data-view="search">Search</button>
    </div>
    <select id="theme" class="theme-select" aria-label="Theme">
      <option value="dark">&#127769; Dark</option>
      <option value="moonlight">&#127756; Moonlight</option>
      <option value="gray">&#127787; Gray</option>
      <option value="soft">&#129718; Soft</option>
      <option value="white">&#9728; White</option>
      <option value="colorful">&#127912; Colorful</option>
      <option value="cartoon">&#129412; Cartoon</option>
    </select>
  </div>
</header>

<div class="layout" id="layout">
  <aside>
    <div class="nav-head">
      <div class="nav-tabs">
        <button data-section="terms" class="active">Terms</button>
        <button data-section="qa">QA</button>
        <button data-section="topics">Topic</button>
        <button data-section="docs">Docs</button>
      </div>
      <div class="search-row">
        <input id="filter" class="search" type="text" placeholder="Filter&hellip;" autocomplete="off" />
        <button id="btn-collapse" class="icon-btn" title="Collapse / expand all">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 9l4-4 4 4M4 13l4-4 4 4"/></svg>
        </button>
      </div>
    </div>
    <nav id="nav"></nav>
  </aside>

  <main id="main"><div id="detail" class="detail"></div></main>

  <div id="search-view">
    <div class="sv-head">
      <input id="search-input" type="text"
             placeholder="Search every term, question, topic and doc&hellip;" autocomplete="off" />
      <div id="search-summary" class="sv-summary"></div>
    </div>
    <div id="search-results"></div>
  </div>
</div>
"""


APP_JS = r"""
/* ============================================================
   JavaStackPage — read-only consolidated reader.
   No fetch(), no localStorage requirement, no server: every term,
   question, topic and markdown doc is inlined in DATA above.
   ============================================================ */

const SEP = "::";
const STACKS = DATA.stacks;
const STACK_BY_ID = {};
STACKS.forEach(s => { STACK_BY_ID[s.id] = s; });

const SECTIONS = ["terms", "qa", "topics", "docs"];
const SECTION_LABEL = { terms: "Term", qa: "Q&A", topics: "Topic", docs: "Doc" };

const $ = sel => document.querySelector(sel);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const tagParts = g => (g || "").split(SEP).map(s => s.trim()).filter(Boolean);
const tagLeaf = g => { const p = tagParts(g); return p[p.length - 1] || g || "Other"; };
const escapeHtml = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const stripCache = new Map();
function stripHtml(h) {
  if (!h) return "";
  if (stripCache.has(h)) return stripCache.get(h);
  const d = document.createElement("div");
  d.innerHTML = h;
  const t = (d.textContent || "").replace(/\s+/g, " ").trim();
  if (stripCache.size < 5000) stripCache.set(h, t);
  return t;
}

/* ---------- Java syntax highlighting (ported from the note apps) ---------- */
const JAVA_KW = new Set(("abstract assert boolean break byte case catch char class const continue " +
  "default do double else enum extends final finally float for goto if implements import instanceof " +
  "int interface long native new package private protected public return short static strictfp super " +
  "switch synchronized this throw throws transient try void volatile while var yield record sealed " +
  "permits when true false null").split(" "));
function highlightJava(src) {
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("{3}[\s\S]*?"{3}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(@[A-Za-z_$][\w$]*)|(\b\d[\d_]*\.?[\d_]*[dDfFlL]?\b)|([A-Za-z_$][\w$]*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += '<span class="tok-com">' + escapeHtml(m[1]) + "</span>";
    else if (m[2]) out += '<span class="tok-str">' + escapeHtml(m[2]) + "</span>";
    else if (m[3]) out += '<span class="tok-ann">' + escapeHtml(m[3]) + "</span>";
    else if (m[4]) out += '<span class="tok-num">' + escapeHtml(m[4]) + "</span>";
    else {
      const w = m[5];
      if (JAVA_KW.has(w)) out += '<span class="tok-kw">' + escapeHtml(w) + "</span>";
      else if (/^[A-Z]/.test(w)) out += '<span class="tok-cls">' + escapeHtml(w) + "</span>";
      else out += escapeHtml(w);
    }
  }
  return out + escapeHtml(src.slice(last));
}
function highlightBlocks(root) {
  if (!root) return;
  root.querySelectorAll("pre code").forEach(c => {
    if (c.dataset.hl) return;
    c.innerHTML = highlightJava(c.textContent);
    c.dataset.hl = "1";
  });
}

/* ---------- markdown (ported from the note apps) ---------- */
function mdInline(s) {
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (m, alt, src) => '<img alt="' + alt + '" src="' + src + '">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (m, t, h) => '<a href="' + h + '" target="_blank" rel="noopener">' + t + "</a>");
  s = s.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s;
}
function renderMarkdown(md) {
  const lines = (md || "").replace(/\r\n?/g, "\n").split("\n");
  const listRe = /^\s*([-*+]|\d+\.)\s+/;
  let out = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out += "<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>";
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { out += "<h" + h[1].length + ">" + mdInline(h[2].trim()) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out += "<hr>"; i++; continue; }
    if (line.includes("|") && i + 1 < lines.length &&
        /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const row = r => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
      const heads = row(line); i += 2;
      let body = "";
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        body += "<tr>" + row(lines[i]).map(c => "<td>" + mdInline(c) + "</td>").join("") + "</tr>"; i++;
      }
      out += "<table><thead><tr>" + heads.map(c => "<th>" + mdInline(c) + "</th>").join("") +
             "</tr></thead><tbody>" + body + "</tbody></table>";
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out += "<blockquote>" + mdInline(buf.join(" ")) + "</blockquote>";
      continue;
    }
    if (listRe.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      let items = "";
      while (i < lines.length && listRe.test(lines[i])) {
        items += "<li>" + mdInline(lines[i].replace(listRe, "")) + "</li>"; i++;
      }
      out += "<" + (ordered ? "ol" : "ul") + ">" + items + "</" + (ordered ? "ol" : "ul") + ">";
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6})\s/.test(lines[i]) &&
           !/^\s*```/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !listRe.test(lines[i]) &&
           !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
    out += "<p>" + mdInline(buf.join(" ")) + "</p>";
  }
  return out;
}

/* ---------- flatten every stack into one addressable index ---------- */
const INDEX = {};        // "stack/section/id" -> entry
const ALL = [];          // every entry, in stack then group order

function entryKey(stack, section, id) { return stack + "/" + section + "/" + id; }

STACKS.forEach(s => {
  Object.keys(s.terms || {}).forEach(id => {
    const t = s.terms[id];
    add({ stack: s.id, section: "terms", id: id, obj: t,
          title: t.title || id, group: t.group || "Other",
          lede: t.lede || stripHtml(t.what).slice(0, 160) });
  });
  Object.keys(s.qa || {}).forEach(id => {
    const q = s.qa[id];
    const qtext = stripHtml(q.question);
    add({ stack: s.id, section: "qa", id: id, obj: q,
          title: qtext.slice(0, 90) || "Untitled question", group: q.group || "Other",
          lede: stripHtml(q.answer).slice(0, 160) || qtext });
  });
  Object.keys(s.topics || {}).forEach(id => {
    const t = s.topics[id];
    add({ stack: s.id, section: "topics", id: id, obj: t,
          title: t.title || id, group: t.group || "Other",
          lede: t.summary || stripHtml(t.content).slice(0, 160) });
  });
  (s.docs || []).forEach(d => {
    add({ stack: s.id, section: "docs", id: d.id, obj: d,
          title: d.title, group: d.kind === "md" ? "Markdown" : (d.kind === "pdf" ? "PDF" : "Standalone pages"),
          lede: d.kind === "md" ? stripHtml(renderMarkdown(d.md)).slice(0, 160)
                                : d.name + (d.size ? " \u00b7 " + Math.round(d.size / 1024) + " KB" : "") });
  });
});

function add(e) {
  e.key = entryKey(e.stack, e.section, e.id);
  e.stackLabel = STACK_BY_ID[e.stack].label;
  INDEX[e.key] = e;
  ALL.push(e);
}

/* full-text blob, built lazily per entry (search only) */
function searchText(e) {
  if (e._text != null) return e._text;
  const o = e.obj;
  const bits = [e.title, e.group];
  if (e.section === "terms") {
    bits.push(o.lede, stripHtml(o.what), stripHtml(o.why), stripHtml(o.flow), o.code,
      (o.apply || []).map(stripHtml).join(" "), (o.gotcha || []).map(stripHtml).join(" "),
      (o.ask || []).map(a => stripHtml(a.q) + " " + stripHtml(a.a)).join(" "),
      (o.variants || []).map(v => [v.name, stripHtml(v.note), v.bad, v.good, v.fix].join(" ")).join(" "));
  } else if (e.section === "qa") {
    bits.push(stripHtml(o.question), stripHtml(o.answer));
  } else if (e.section === "topics") {
    bits.push(o.summary, stripHtml(o.content));
  } else if (e.section === "docs") {
    bits.push(o.name, o.kind === "md" ? o.md : "");
  }
  e._text = bits.filter(Boolean).join(" \u00b7 ").replace(/\s+/g, " ");
  return e._text;
}

/* ---------- state ---------- */
let curStack = "all";
let curSection = "terms";
let curKey = null;
let view = "home";           // "home" | "detail" | "search"
let collapsed = false;

/* ---------- header: stack tabs ---------- */
const stackTabs = $("#stack-tabs");
function renderStackTabs() {
  stackTabs.innerHTML = "";
  const mk = (id, label, dotCls) => {
    const b = el("button");
    b.dataset.stack = id;
    b.innerHTML = (dotCls ? '<span class="dot ' + dotCls + '"></span>' : "") + label;
    b.classList.toggle("active", curStack === id);
    b.addEventListener("click", () => setStack(id));
    stackTabs.appendChild(b);
  };
  mk("all", "All");
  STACKS.forEach(s => mk(s.id, s.label, "st-" + s.id));
}
function setStack(id) {
  curStack = id;
  renderStackTabs();
  if (curKey && INDEX[curKey] && id !== "all" && INDEX[curKey].stack !== id) curKey = null;
  renderNav();
  if (view === "home") renderHome();
  else if (view === "detail" && !curKey) showHome();
  if (view === "search") runSearch();
  syncHash();
}

/* ---------- sidebar ---------- */
const navEl = $("#nav");
const filterInput = $("#filter");

document.querySelectorAll(".nav-tabs button").forEach(b => {
  b.addEventListener("click", () => {
    curSection = b.dataset.section;
    document.querySelectorAll(".nav-tabs button")
      .forEach(x => x.classList.toggle("active", x === b));
    filterInput.placeholder = "Filter " + (curSection === "qa" ? "questions" : curSection) + "\u2026";
    renderNav();
  });
});

function visibleEntries() {
  const q = filterInput.value.trim().toLowerCase();
  return ALL.filter(e => e.section === curSection &&
    (curStack === "all" || e.stack === curStack) &&
    (!q || e.title.toLowerCase().includes(q) || e.group.toLowerCase().includes(q) ||
     (e.lede || "").toLowerCase().includes(q)));
}

function buildTree(entries) {
  const root = { name: "", children: {}, order: [], items: [] };
  entries.forEach(e => {
    const parts = (curStack === "all" ? [e.stackLabel] : []).concat(tagParts(e.group));
    let node = root;
    parts.forEach(p => {
      if (!node.children[p]) {
        node.children[p] = { name: p, children: {}, order: [], items: [] };
        node.order.push(p);
      }
      node = node.children[p];
    });
    node.items.push(e);
  });
  return root;
}
function countTree(n) {
  let c = n.items.length;
  n.order.forEach(k => (c += countTree(n.children[k])));
  return c;
}
function itemEl(e, depth) {
  const d = el("div", "term");
  d.dataset.key = e.key;
  d.textContent = e.title;
  d.title = e.lede || e.title;
  d.style.paddingLeft = (22 + Math.max(0, depth - 1) * 12) + "px";
  if (e.key === curKey) d.classList.add("active");
  d.addEventListener("click", () => openKey(e.key));
  return d;
}
/* Sub-groups first, then this node's own leaves. Each node emits its own
   leaves exactly once \u2014 the caller never re-appends them. */
function renderTreeNode(node, container, depth) {
  node.order.forEach(k => {
    const child = node.children[k];
    const g = el("div", "group");
    if (collapsed) g.classList.add("collapsed");
    const head = el("div", "group-head");
    head.style.paddingLeft = (10 + depth * 12) + "px";
    head.innerHTML = '<span class="caret">\u25BC</span><span>' + escapeHtml(child.name) +
                     '</span><span class="count">' + countTree(child) + "</span>";
    head.addEventListener("click", () => g.classList.toggle("collapsed"));
    g.appendChild(head);
    const items = el("div", "group-items");
    renderTreeNode(child, items, depth + 1);
    g.appendChild(items);
    container.appendChild(g);
  });
  node.items.forEach(e => container.appendChild(itemEl(e, depth)));
}
function renderNav() {
  const entries = visibleEntries();
  navEl.innerHTML = "";
  if (!entries.length) {
    const p = el("div", "nav-empty");
    p.textContent = "Nothing here for this filter.";
    navEl.appendChild(p);
    return;
  }
  renderTreeNode(buildTree(entries), navEl, 0);
}
filterInput.addEventListener("input", renderNav);
$("#btn-collapse").addEventListener("click", () => { collapsed = !collapsed; renderNav(); });
$("#nav-toggle").addEventListener("click", () => $("#layout").classList.toggle("nav-closed"));

function markActive() {
  navEl.querySelectorAll(".term").forEach(e =>
    e.classList.toggle("active", e.dataset.key === curKey));
}

/* ---------- views ---------- */
const detail = $("#detail");
const searchView = $("#search-view");
const main = $("#main");

function showView(v) {
  view = v;
  main.style.display = v === "search" ? "none" : "";
  searchView.classList.toggle("show", v === "search");
  document.querySelectorAll(".tabs .tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === v));
}
document.querySelectorAll(".tabs .tab-btn").forEach(b => {
  b.addEventListener("click", () => (b.dataset.view === "home" ? showHome() : showSearch()));
});

/* ---------- home ---------- */
function statsFor(s) {
  return [
    Object.keys(s.terms || {}).length + " terms",
    Object.keys(s.qa || {}).length + " Q&A",
    Object.keys(s.topics || {}).length + " topics",
    (s.docs || []).length + " docs",
  ];
}
function renderHome() {
  const shown = curStack === "all" ? STACKS : [STACK_BY_ID[curStack]];
  let cards = "";
  shown.forEach(s => {
    cards += '<div class="home-card" data-stack="' + s.id + '">' +
      "<h3><span class=\"dot st-" + s.id + '"></span>' + escapeHtml(s.label) + "</h3>" +
      "<p>" + escapeHtml(s.blurb) + "</p>" +
      '<div class="home-stats">' + statsFor(s).map(x => "<span>" + x + "</span>").join("") + "</div></div>";
  });
  const totals = STACKS.reduce((a, s) => {
    a.t += Object.keys(s.terms || {}).length;
    a.q += Object.keys(s.qa || {}).length;
    a.p += Object.keys(s.topics || {}).length;
    a.d += (s.docs || []).length;
    return a;
  }, { t: 0, q: 0, p: 0, d: 0 });

  detail.className = "detail home";
  detail.innerHTML =
    "<h2>Java Stack \u2014 consolidated notes</h2>" +
    '<p class="lede">Everything from the Java, Microservices and Spring note apps in one offline page: ' +
    totals.t + " glossary terms, " + totals.q + " interview questions, " + totals.p +
    " topics and " + totals.d + " long-form documents.</p>" +
    '<div class="home-cards">' + cards + "</div>" +
    '<div class="home-note"><b>How to use this page.</b> Pick a stack above to narrow everything down, ' +
    "or stay on <b>All</b> to browse the three side by side. The left sidebar switches between " +
    "<b>Terms</b>, <b>QA</b>, <b>Topic</b> and <b>Docs</b>; <b>Search</b> in the header looks inside " +
    "every one of them at once. Long-form documents open in their own tab straight from the file system \u2014 " +
    "no server, no install, works offline.</div>";
  detail.querySelectorAll(".home-card").forEach(c =>
    c.addEventListener("click", () => { setStack(c.dataset.stack); }));
  showView("home");
}
function showHome() { curKey = null; markActive(); renderHome(); syncHash(); main.scrollTop = 0; }

/* ---------- detail renderers ---------- */
function relatedHTML(e) {
  const s = STACK_BY_ID[e.stack];
  const rel = (e.obj.related || []).filter(r => s.terms && s.terms[r]);
  if (!rel.length) return "";
  return '<div class="section"><h3>Related terms</h3><div class="related">' +
    rel.map(r => '<span class="pill" data-key="' + entryKey(e.stack, "terms", r) + '">' +
      escapeHtml(s.terms[r].title) + "</span>").join("") + "</div></div>";
}
function crumbs(e) {
  return '<div class="crumbs"><span class="stack-chip">' + escapeHtml(e.stackLabel) + "</span>" +
    '<span class="tag-chip">' + escapeHtml(tagLeaf(e.group)) + "</span>" +
    (tagParts(e.group).length > 1 ? " <span>" + escapeHtml(tagParts(e.group).join(" \u203A ")) + "</span>" : "") +
    "</div>";
}
function notesHTML(e) {
  const s = STACK_BY_ID[e.stack];
  const nid = e.section === "qa" ? "qa__" + e.id : e.section === "topics" ? "topic__" + e.id : e.id;
  const n = (s.notes || {})[nid];
  if (!n || !stripHtml(n)) return "";
  return '<div class="section"><h3>My notes</h3><div class="rich">' + n + "</div></div>";
}

function termHTML(e) {
  const t = e.obj;
  let h = crumbs(e) + '<h2 class="term-title">' + escapeHtml(t.title) + "</h2>";
  if (t.lede) h += '<p class="lede">' + t.lede + "</p>";
  if (t.flow) h += '<div class="section"><h3>At a glance</h3>' + t.flow + "</div>";
  if (t.what) h += '<div class="section"><h3>' + (t.builtin ? "What it is" : "Details") +
                   '</h3><div class="rich">' + t.what + "</div></div>";
  if (t.why) h += '<div class="section"><h3>Why it matters</h3><div class="rich">' + t.why + "</div></div>";
  if (t.apply && t.apply.length)
    h += '<div class="section"><h3>How to apply</h3><ul>' +
         t.apply.map(a => "<li>" + a + "</li>").join("") + "</ul></div>";
  if (t.code) h += '<div class="section"><h3>Example</h3><pre><code>' + escapeHtml(t.code) + "</code></pre></div>";
  if (t.variants && t.variants.length)
    h += '<div class="section"><h3>Flavours &amp; their fixes</h3>' + t.variants.map(v =>
      '<div class="variant"><div class="variant-head">' + escapeHtml(v.name) + "</div>" +
      (v.note ? '<p class="variant-note">' + v.note + "</p>" : "") +
      '<div class="variant-code bad"><span class="variant-tag">\u2717 Problem</span><pre><code>' +
        escapeHtml(v.bad) + "</code></pre></div>" +
      '<div class="variant-code good"><span class="variant-tag">\u2713 Fix \u2014 ' + escapeHtml(v.fix) +
        "</span><pre><code>" + escapeHtml(v.good) + "</code></pre></div></div>").join("") + "</div>";
  if (t.gotcha && t.gotcha.length)
    h += '<div class="section"><h3>Trade-offs &amp; points to remember</h3><ul class="gotchas">' +
         t.gotcha.map(g => "<li>" + g + "</li>").join("") + "</ul></div>";
  if (t.ask && t.ask.length)
    h += '<div class="section"><h3>Interview asks</h3><div class="asks">' +
         t.ask.map(a => '<div class="ask"><div class="ask-q">' + a.q + '</div><div class="ask-a">' +
           a.a + "</div></div>").join("") + "</div></div>";
  return h + notesHTML(e) + relatedHTML(e);
}
function qaHTML(e) {
  const q = e.obj;
  return crumbs(e) + '<h2 class="term-title">' + escapeHtml(e.title) + "</h2>" +
    '<div class="section"><h3>Question</h3><div class="rich">' + (q.question || "") + "</div></div>" +
    '<div class="section"><h3>Answer</h3><div class="rich">' + (q.answer || "") + "</div></div>" +
    notesHTML(e);
}
function topicHTML(e) {
  const t = e.obj;
  return crumbs(e) + '<h2 class="term-title">' + escapeHtml(t.title) + "</h2>" +
    (t.summary ? '<p class="lede">' + t.summary + "</p>" : "") +
    (t.content ? '<div class="section"><h3>Content</h3><div class="rich">' + t.content + "</div></div>" : "") +
    notesHTML(e);
}
function docHTML(e) {
  const d = e.obj;
  if (d.kind === "md") {
    return crumbs(e) + '<div class="doc-head"><h2>' + escapeHtml(d.title) + "</h2></div>" +
      '<div class="rich md-body">' + renderMarkdown(d.md) + "</div>";
  }
  const kb = d.size ? Math.round(d.size / 1024) + " KB" : "";
  return crumbs(e) +
    '<div class="doc-head"><h2>' + escapeHtml(d.title) + "</h2>" +
    '<a class="doc-open" href="' + d.file + '" target="_blank" rel="noopener">Open in a new tab \u2197</a></div>' +
    '<iframe class="doc-frame" src="' + d.file + '" title="' + escapeHtml(d.title) + '"></iframe>' +
    '<p class="doc-hint">' + escapeHtml(d.name) + (kb ? " \u00b7 " + kb : "") +
    " \u00b7 this is a self-contained page shipped alongside index.html. If the preview above stays blank " +
    "(some browsers block framing local files), use <b>Open in a new tab</b>.</p>";
}

function openKey(key) {
  const e = INDEX[key];
  if (!e) return;
  curKey = key;
  if (curStack !== "all" && e.stack !== curStack) setStack(e.stack);
  if (curSection !== e.section) {
    curSection = e.section;
    document.querySelectorAll(".nav-tabs button")
      .forEach(x => x.classList.toggle("active", x.dataset.section === e.section));
    renderNav();
  }
  detail.className = "detail";
  detail.innerHTML = e.section === "terms" ? termHTML(e)
    : e.section === "qa" ? qaHTML(e)
    : e.section === "topics" ? topicHTML(e)
    : docHTML(e);
  highlightBlocks(detail);
  detail.querySelectorAll(".pill[data-key]").forEach(p =>
    p.addEventListener("click", () => openKey(p.dataset.key)));
  showView("detail");
  markActive();
  const active = navEl.querySelector(".term.active");
  if (active) {
    let g = active.parentElement;
    while (g && g !== navEl) { if (g.classList.contains("group")) g.classList.remove("collapsed"); g = g.parentElement; }
    active.scrollIntoView({ block: "nearest" });
  }
  main.scrollTop = 0;
  syncHash();
}

/* ---------- search ---------- */
const searchInput = $("#search-input");
const searchResults = $("#search-results");
const searchSummary = $("#search-summary");
let searchTimer = null;

function showSearch() {
  showView("search");
  searchInput.focus();
  searchInput.select();
  if (!searchResults.innerHTML) runSearch();
  syncHash();
}
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});

function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.slice(0, 220);
  const from = Math.max(0, i - 90);
  const raw = (from ? "\u2026" : "") + text.slice(from, i) +
              "\u0000" + text.substr(i, q.length) + "\u0001" +
              text.slice(i + q.length, i + q.length + 140) + "\u2026";
  return raw;
}
function snippetHTML(text, q) {
  return escapeHtml(snippet(text, q)).replace(/\u0000/g, "<mark>").replace(/\u0001/g, "</mark>");
}

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  const pool = ALL.filter(e => curStack === "all" || e.stack === curStack);
  if (!q) {
    searchSummary.innerHTML = "Type to search <b>" + pool.length + "</b> entries" +
      (curStack === "all" ? " across all three stacks." : " in " + STACK_BY_ID[curStack].label + ".");
    searchResults.innerHTML = "";
    return;
  }
  const hits = [];
  for (const e of pool) {
    const t = searchText(e);
    const lt = t.toLowerCase();
    const inTitle = e.title.toLowerCase().includes(q);
    if (!inTitle && !lt.includes(q)) continue;
    hits.push({ e: e, score: (inTitle ? 0 : 1), text: t });
    if (hits.length > 400) break;
  }
  hits.sort((a, b) => a.score - b.score || a.e.title.localeCompare(b.e.title));
  searchSummary.innerHTML = "<b>" + hits.length + "</b> result" + (hits.length === 1 ? "" : "s") +
    " for \u201c" + escapeHtml(searchInput.value.trim()) + "\u201d" +
    (hits.length > 400 ? " (showing the first 400)" : "");
  searchResults.innerHTML = hits.map(h =>
    '<div class="sr-hit" data-key="' + h.e.key + '"><div class="sr-meta">' +
    '<span class="sr-type">' + SECTION_LABEL[h.e.section] + "</span>" +
    '<span class="stack-chip">' + escapeHtml(h.e.stackLabel) + "</span>" +
    '<span class="sr-title">' + escapeHtml(h.e.title) + "</span>" +
    '<span class="sr-field">' + escapeHtml(tagParts(h.e.group).join(" \u203A ")) + "</span></div>" +
    '<div class="sr-snippet">' + snippetHTML(h.text, q) + "</div></div>").join("");
  searchResults.querySelectorAll(".sr-hit").forEach(hit =>
    hit.addEventListener("click", () => openKey(hit.dataset.key)));
}

/* ---------- theme ---------- */
const themeSel = $("#theme");
const THEMES = Array.from(themeSel.options).map(o => o.value);
function applyTheme(name) {
  if (THEMES.indexOf(name) < 0) name = "dark";
  document.documentElement.setAttribute("data-theme", name);
  themeSel.value = name;
  try { localStorage.setItem("javastack-theme", name); } catch (e) {}
}
themeSel.addEventListener("change", () => applyTheme(themeSel.value));
let saved = null;
try { saved = localStorage.getItem("javastack-theme"); } catch (e) {}
applyTheme(saved || "dark");

/* ---------- hash routing ---------- */
let hashLock = false;
function syncHash() {
  hashLock = true;
  const h = view === "search" ? "#/search/" + curStack
    : curKey ? "#/" + curKey
    : "#/home/" + curStack;
  if (location.hash !== h) {
    /* Chrome can reject history.replaceState on a file:// document (opaque
       origin), so fall back to writing the hash directly. */
    try { history.replaceState(null, "", h); }
    catch (err) { try { location.hash = h.slice(1); } catch (e2) {} }
  }
  setTimeout(() => (hashLock = false), 0);
}
function applyHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (!raw) { renderNav(); showHome(); return; }
  const parts = raw.split("/");
  if (parts[0] === "search") { curStack = parts[1] || "all"; renderStackTabs(); renderNav(); showSearch(); return; }
  if (parts[0] === "home") { curStack = parts[1] || "all"; renderStackTabs(); renderNav(); showHome(); return; }
  if (parts.length >= 3 && INDEX[parts.slice(0, 3).join("/")]) {
    curSection = parts[1];
    document.querySelectorAll(".nav-tabs button")
      .forEach(x => x.classList.toggle("active", x.dataset.section === curSection));
    renderNav();
    openKey(parts.slice(0, 3).join("/"));
    return;
  }
  renderNav();
  showHome();
}
window.addEventListener("hashchange", () => { if (!hashLock) applyHash(); });

/* ---------- keyboard ---------- */
document.addEventListener("keydown", ev => {
  const typing = /^(INPUT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.isContentEditable;
  if ((ev.key === "/" || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k")) && !typing) {
    ev.preventDefault();
    showSearch();
  } else if (ev.key === "Escape" && view === "search") {
    showHome();
  }
});

/* ---------- go ---------- */
renderStackTabs();
applyHash();
"""


def build_page(css, data):
    parts = [
        "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"dark\">\n<head>\n",
        "<meta charset=\"UTF-8\" />\n",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n",
        "<title>Java Stack — Java · Microservices · Spring</title>\n",
        "<style>", css, "</style>\n</head>\n<body>\n",
        BODY,
        "<script>\nconst DATA = ", js_literal(data), ";\n",
        APP_JS,
        "\n</script>\n</body>\n</html>\n",
    ]
    return "".join(parts)


README = """Java Stack — consolidated offline notes
=======================================

WHAT THIS IS
    One self-contained reader for three sets of study notes:
    Java, Microservices and Spring. Glossary terms, interview
    Q&A, topic write-ups and long-form documents, all in one place.

HOW TO OPEN IT
    Double-click  index.html
    That's it. No server, no Python, no install, no internet.
    Works in Chrome, Edge, Safari and Firefox.

WHAT'S INSIDE
    index.html      the whole reader — terms, Q&A, topics and the
                    markdown documents are embedded directly in it
    docs/           the large standalone documents (interview vaults,
                    drills, guides), kept as separate pages
    assets/         images referenced by notes, if there are any

GETTING AROUND
    Header      switch stacks: All / Java / Microservices / Spring
    Sidebar     Terms · QA · Topic · Docs, with a filter box
    Search      searches inside every term, question, topic and doc
                at once — press "/" or Ctrl/Cmd+K
    Theme       seven themes in the top-right; your pick is remembered

NOTES
    - Long documents in docs/ preview inside the page. If a preview
      stays blank (some browsers refuse to frame local files),
      use the "Open in a new tab" button above it.
    - Those documents pull web fonts when you're online; offline they
      simply fall back to system fonts and read exactly the same.
    - This export is read-only by design: nothing here writes back to
      the original note apps.
"""


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    print("Reading note apps…")
    data = build_data(OUT)
    css = build_css()

    page = build_page(css, data)
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)
    with open(os.path.join(OUT, "README.txt"), "w", encoding="utf-8") as fh:
        fh.write(README)

    for s in data["stacks"]:
        print("  %-14s %3d terms  %3d Q&A  %2d topics  %2d docs"
              % (s["label"], len(s["terms"]), len(s["qa"]), len(s["topics"]), len(s["docs"])))

    zip_path = os.path.join(ROOT, "JavaStackPage.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(OUT):
            for f in sorted(files):
                if f == ".DS_Store":
                    continue
                full = os.path.join(dirpath, f)
                z.write(full, os.path.join("JavaStackPage", os.path.relpath(full, OUT)))

    print("\nindex.html   %6.1f KB" % (os.path.getsize(os.path.join(OUT, "index.html")) / 1024))
    print("zip          %6.1f MB  ->  %s" % (os.path.getsize(zip_path) / 1048576, zip_path))


if __name__ == "__main__":
    main()
