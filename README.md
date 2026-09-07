# PG Hub Technologies

A study hub for the working stack — languages, frameworks, architecture, APIs
and AI engineering — across seventeen modules.

**This repository contains only the application.** Every term, answer, topic,
note, document and image lives in a private Google Drive folder and is fetched
in your browser with your own Google token. Nothing studied here is stored in,
or served from, this repository.

---

## How it works

```
    Anyone can read this repo               Only the owner can read this
   ┌────────────────────────────┐          ┌────────────────────────────┐
   │  index.html                │          │   Google Drive             │
   │  AWS/AWSNotes.html         │  OAuth   │     PGHubTechnologies/     │
   │  Java/JavaNotes.html  …    │ ───────► │       hub.json             │
   │  app/*.js   vendor/        │  token   │       hub-index.json       │
   │                            │          │       Kafka/               │
   │  ~55k lines of app code,   │          │         terms.json …       │
   │  zero content              │          │         docs/  images/     │
   └────────────────────────────┘          │     PGHubTechnologies      │
        GitHub Pages (public)              │       Manifest 📊          │
                                           └────────────────────────────┘
```

The site is static. There is no server, no database and no API key: the browser
talks to Drive directly, authenticated as whoever signed in. A visitor who is
not the folder's owner sees a sign-in screen and nothing else, because Drive
will not serve them the files.

### The one interesting trick

Each module app is ~3,000–4,500 lines that were written against a local Python
server, talking to it through six `fetch()` calls on relative paths — `/terms`,
`/qa`, `/topics`, `/notes`, `/docs`, `/upload`. None of that code was rewritten.
Instead `app/store.js` patches `window.fetch`, answers exactly those paths out
of Drive, and passes everything else through. The applications cannot tell the
difference.

Two consequences worth knowing:

- **Reads are cached** for the session. A Drive round trip is ~200 ms where
  localhost was ~1 ms.
- **Writes are debounced** (~1 s) and flushed on page hide. The app saves a whole
  file per edited item, so saving on every keystroke would re-upload the same
  100 KB repeatedly. A chip in the corner shows when a save is pending, and
  `Cmd/Ctrl-S` forces one.

### Why seventeen pages and not one

The sibling System Design hub collapsed thirteen byte-identical module apps into
a single `module.html`. These seventeen are **not** identical: they are different
vintages of the same lineage and have drifted apart — some render PDFs and
standalone HTML documents in an iframe, some only markdown; some carry Java
syntax highlighting; AgenticAI re-renders its open document when the theme
changes and draws mermaid diagrams. Collapsing them would have meant picking one
and silently dropping features from sixteen others, so each stays its own page
and `hub.json` records where it lives.

That drift is also why the store asks each module what it can display:
`docs-caps.json` records the document types that module's `load_docs` used to
list, so a document dropped into Drive is only surfaced to a page that can
actually draw it. Kafka's `docs/` folder has held an `.html` file its server
never listed and its renderer cannot handle; without this it would have appeared
in the sidebar and rendered as nothing.

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page — module cards, cross-module tree, browse, preview, practice |
| `<Module>/<Name>.html` | The seventeen module apps, one per folder |
| `app/` | The Drive layer: auth, Drive REST, the fetch store, media, sign-in gate |
| `vendor/` | Third-party libraries (mermaid) |
| `tools/` | Migration and maintenance. Never deployed |
| `dev.py` | Static file server for local development |

---

## Running it locally

```bash
python3 dev.py            # http://localhost:5173/
```

Port 5173 is the default because it is almost certainly already registered as an
authorized JavaScript origin on the OAuth client. Serving from an unregistered
origin makes Google reject sign-in with `origin_mismatch`; add the origin under
**APIs & Services → Credentials → your Web client** if you use another port.

---

## Migrating content into Drive

Already done — this is here for the record, and for a re-run against restored
content (see below). Requires `tools/credentials.json`, a Desktop OAuth client
from the same Cloud project (`pg-hub-tech`) as the web client; it and the token
it mints are gitignored.

```bash
cd tools && npm install && cd ..      # googleapis; node_modules is gitignored
python3 tools/build-docs-index.py     # bake the /docs and hub payloads
node    tools/migrate.mjs --dry-run   # report, write nothing
node    tools/migrate.mjs             # upload
node    tools/verify.mjs --write      # read it all back and check it
```

The migration is idempotent and resumable: it keys everything on
(parent folder, name), skips files whose checksum already matches, retries
transient Google errors with backoff, and checkpoints to
`tools/.migration-state.json`. Re-running after an interruption picks up where
it stopped.

`build-docs-index.py` deliberately imports each module's own `server.py` and
`serve_hub.py` and calls their functions, so the baked payloads are identical to
what those servers produced rather than a reimplementation that could drift —
which matters here, because the seventeen servers do not agree with each other.

### Pasted images

`server.py` saved a pasted image to `images/` and answered with the path it had
just created — `/images/qa/qa-a__1782390824744.png` — which the app stored
inside the note's HTML. On a static host nothing serves that path. The migration
rewrites every one of those references to the `drive:<id>` form the app now
understands, on the way up; the files on disk are left untouched, so a re-run
reads the same originals and produces the same result. `verify.mjs` fails if any
survive.

### The tools need a content checkout

`migrate.mjs`, `verify.mjs`, `preflight-delete.mjs`, `build-docs-index.py` and
`export_javastack.py` all read `hub.json` and the per-module folders off disk.
Once the content is deleted locally they have nothing to read until it is
restored from git history or from Drive.

`preflight-delete.mjs` is the one to run before deleting any local copy: it
walks every file individually and refuses unless each one has a Drive id that
still resolves.

---

## Adding a document

Drop the file into the module's `docs/` folder in Drive. The app lists that
folder and folds in anything the baked index doesn't know about, so it appears
in the sidebar on the next load — no migration, no checkout, no deploy. New
markdown is read on load so it renders, and its title comes from the first
`# heading`.

The one limit is the module's own `docs-caps.json` (see above): dropping a PDF
into a markdown-only module's folder will not surface it, because that module's
page cannot draw one.

---

## Shared preferences

The theme is chosen once and holds everywhere — the hub, all seventeen modules,
other open tabs, and other machines. Three layers, in order of how quickly they
apply:

| Where | Scope | Why |
|---|---|---|
| Cookie (`tech_theme`) | this browser, all pages on the origin | applies before any script or sign-in, so there is no flash of the wrong theme |
| `BroadcastChannel` | pages open right now | a hub sitting beside a module used to go stale until it was reloaded |
| `settings.json` in Drive | every device | a cookie does not travel |

Drive wins only when it is genuinely newer: both sides carry a timestamp, so
opening a stale tab does not undo a change made elsewhere. Writes are debounced
and flushed on page hide.

### If the tools stop working with `invalid_grant`

```bash
node tools/reauth.mjs
```

The saved refresh token has been withdrawn. Google expires them while the
consent screen is in Testing mode, and revoking a token anywhere withdraws the
grant for the whole Cloud project — which is why the app's sign-out drops its
token rather than calling `revoke()`.

---

## Before making the repository public

```bash
bash tools/check-public-safe.sh
```

It inspects what git actually tracks — not just what `.gitignore` covers, since
that does nothing for files committed before the rule existed — and fails on
credentials, per-module data stores, document and image libraries, baked
indexes, or a key pasted into source.

Install it as a pre-push hook so it runs automatically:

```bash
bash tools/install-hooks.sh
```

That is deliberately a *pre*-push check rather than CI. A workflow can only tell
you about a leak once the content is already on GitHub and, in a public repo,
already fetchable by anyone watching. The hook stops the push while the content
is still only on your machine.

## Hosting

The site is static — no build, no bundler — so GitHub Pages serves the default
branch directly. There is nothing to compile and no secret to inject at build
time, because everything the page displays is fetched from Drive in the
visitor's browser using their own token.

Whatever origin it ends up served from must be added to the OAuth client's
**Authorized JavaScript origins**, or Google refuses the sign-in popup.

---

## Access

`app/config.js` holds a SHA-256 of the owner's Google address and shows a clear
message to anyone else. **This is a courtesy, not a security boundary** — anyone
can edit client-side JavaScript. What actually keeps the content private is the
Drive folder's ACL: a browser signed in as someone else simply cannot read the
files. Add an address with:

```bash
node tools/hash-email.mjs someone@example.com
```

The OAuth client id in `config.js` is public by design; Google treats it as an
identifier, not a secret, and it is inert without a user consenting in a browser.

### If saving fails with 403

Reads work but writes do not. Drive grants `drive.file` access per *Cloud
project*, and the migration tool and the web app share project `pg-hub-tech`, so
this should not happen — but if it does, swap the two Drive scopes in
`app/config.js` for the single `https://www.googleapis.com/auth/drive`, add it on
the OAuth consent screen, and sign in again.
