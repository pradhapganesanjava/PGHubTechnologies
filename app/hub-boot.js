/* Entry point for the landing page (index.html).
 *
 * Lighter than the module boot: the hub only reads — the manifest, the baked
 * cross-module index, and single entries for the preview pane — so it needs
 * no store, no media rewriting and no save indicator. Just a session and the
 * three endpoints serve_hub.py used to answer.
 */
import * as Settings from './settings.js'
import { installHubStore } from './hub.js'
import { installGate }     from './gate.js'

installHubStore()
installGate({ title: 'PG Hub Technologies', emoji: '🧰' })

// ── shared preferences ──────────────────────────────────────────────────────
// The page's own applyTheme is a plain function in its inline script, so it is
// on window; settings calls back into it when another page or Drive changes
// the theme. withRemote stops that arriving change bouncing straight back out.
window.__pghubSettings = Settings
Settings.onThemeChange(t => Settings.withRemote(() => window.applyTheme?.(t)))
Settings.syncFromDrive().catch(() => { /* the local theme stands */ })
