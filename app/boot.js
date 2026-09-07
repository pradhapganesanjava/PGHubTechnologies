/* Entry point for every module app page (AWS/AWSNotes.html, Java/JavaNotes.html, …).
 *
 * Wires the Drive-backed store into the page and puts the sign-in gate up. The
 * module's identity is baked into its own page — each module is a distinct app
 * here, not one page parameterised by a query string — so the only thing this
 * needs from the outside is which Drive folder to read, which tools/build-app.py
 * stamped in as __pghubModule.
 */
import * as Settings from './settings.js'
import { installStore, flush } from './store.js'
import { installMedia }        from './media.js'
import { installGate }         from './gate.js'

// Stamped by tools/build-app.py. The ?m= fallback exists so a page can be
// pointed at another module's folder by hand when debugging.
const mod = window.__pghubModule ||
            new URLSearchParams(location.search).get('m') || ''

installStore(mod)
installMedia()
installGate({ title: document.title || 'PG Hub Technologies', emoji: '🧰', onFlush: flush })

// ── shared preferences ──────────────────────────────────────────────────────
// The page's own applyTheme is a plain function in its inline script, so it is
// on window; settings calls back into it when another page or Drive changes
// the theme. withRemote stops that arriving change bouncing straight back out.
window.__pghubSettings = Settings
Settings.onThemeChange(t => Settings.withRemote(() => window.applyTheme?.(t)))
Settings.syncFromDrive().catch(() => { /* the local theme stands */ })
