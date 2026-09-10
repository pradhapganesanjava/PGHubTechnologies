/* Accept a Google session handed down by a host page that frames this app.
 *
 * PG Hub Tech (pradhapganesanjava.github.io/pghubtech/) embeds this site in an
 * iframe. Both are the same origin in production, so the frame already shares
 * that tab's sessionStorage — but the two apps namespace their keys
 * differently ('pghubtechs_tok' here, 'pghtech_tok' there), so sharing the storage
 * area is not enough on its own. The host posts its token; this module writes
 * it under OUR key in OUR shape, and the gate's existing restore() path takes
 * it from there. No second sign-in, no second consent screen.
 *
 * It writes through gauth's store, so a handed-down session reaches BOTH
 * storage areas exactly like one from our own sign-in button. That matters
 * twice over: sessionStorage alone would confine the session to the frame's
 * tab — the very per-tab sign-in localStorage was adopted to end — and the
 * localStorage write fires a storage event in every other open tab, which
 * GAuth.listen picks up, so tabs parked on the gate come in without a reload.
 *
 * Standalone (not framed) this module does nothing at all.
 */
import { Config } from './config.js'
import { store }  from './gauth.js'

// Only ever talk to the host, and only ever trust a message from it. A '*'
// target or a missing origin check here would hand a Drive token to whatever
// page happened to frame this one.
const HOST_ORIGIN = 'https://pradhapganesanjava.github.io'
const DEV_ORIGINS = [
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:5174', 'http://127.0.0.1:5174',
]
const TRUSTED = [HOST_ORIGIN, ...DEV_ORIGINS]

export const framed = () => window.parent !== window

/**
 * Start listening for the host's session. Call BEFORE installGate so the token
 * is in place (or arrives moments later) rather than after the gate has
 * already given up and shown the button.
 *
 * @param onAuth called once the session has been stored, so the caller can
 *               re-run its restore()/enter() path.
 */
export function installParentAuth(onAuth) {
  if (!framed()) return

  window.addEventListener('message', e => {
    if (!TRUSTED.includes(e.origin)) return
    const d = e.data
    if (!d || d.type !== 'pghubtech:auth' || !d.token || !d.expires) return
    try {
      store.set(
        Config.ns + 'tok',
        JSON.stringify({ token: d.token, expires: d.expires }),
      )
      if (d.user) store.set(Config.ns + 'usr', JSON.stringify(d.user))
      // store.set swallows a blocked area on its own and onAuth re-reads
      // storage, so a write that lands nowhere simply leaves the gate up.
    } catch { return }
    try { onAuth?.() } catch { /* caller's problem, not ours */ }
  })

  // Ask rather than wait: the host also pushes on iframe load, but that fires
  // before this script has parsed, so the push alone would be missed.
  for (const origin of hostOrigins()) {
    try { window.parent.postMessage({ type: 'pghubtech:auth-request' }, origin) } catch { /* ignore */ }
  }
}

/**
 * Which trusted origins to address the request to.
 *
 * postMessage does not throw when the target origin is not the recipient's —
 * it logs a console error the caller cannot catch. Asking all three therefore
 * left two red lines in every framed session in production, for the two dev
 * origins that were never going to be the parent.
 *
 * The parent's origin is knowable without reading across it: ancestorOrigins
 * names it outright in Chrome and Safari, and document.referrer carries it
 * otherwise. Where neither answers — Firefox with a referrer policy that
 * strips it — fall back to asking each in turn, which is noisy but no less
 * safe, since every target is still an origin on the list.
 */
function hostOrigins() {
  let named = null
  try {
    named = location.ancestorOrigins?.[0]
      ?? (document.referrer ? new URL(document.referrer).origin : null)
  } catch { /* an unparseable referrer is the same as none */ }

  if (!named) return TRUSTED                    // unknown: ask all of them
  return TRUSTED.includes(named) ? [named] : [] // framed by a stranger: say nothing
}
