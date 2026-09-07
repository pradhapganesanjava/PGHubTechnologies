/* Google Identity Services — OAuth token flow for the browser.
 *
 * Ported from the sibling System Design hub, trimmed to what this hub
 * needs. The important behaviour is withAuthRetry: Drive access tokens last an
 * hour, and this app is one people leave open all day, so a save that lands
 * after expiry must not lose the user's writing. Every call goes through
 * GAuth.fetch, which re-authorizes silently and retries once on a 401.
 */
import { Config, isEmailAllowed } from './config.js'

const TOK_KEY = 'tok'
const USR_KEY = 'usr'

/* WHERE THE TOKEN LIVES
 *
 * It used to be sessionStorage, which is per-tab: signing in on the hub and
 * then opening a module in a NEW tab asked for a second sign-in, and so did
 * every browser restart. It is now localStorage, so one sign-in covers every
 * tab, every window, and a restart — until the token expires on its own, which
 * for a Drive access token is about an hour.
 *
 * The trade, stated plainly: an access token now touches disk for that hour,
 * where before it died with the tab. It is not a refresh token — it cannot be
 * renewed, and it carries only the two Drive scopes in config.js.
 *
 * sessionStorage is still read on restore so a session started before this
 * change is not thrown away, and still written so a tab that has localStorage
 * blocked (private windows, some enterprise policies) keeps working as before.
 */
export const store = {
  /* Both areas are read and the FRESHER entry wins, rather than localStorage
     simply taking precedence: a session written before this change lives in
     sessionStorage only, and a stale localStorage token left from an earlier
     sign-in would otherwise shadow it — and then be cleared as expired,
     taking the good one with it.

     Exported because parent-auth.js writes through it too: a session handed
     down by the framing host has to land in both areas the same way one from
     our own sign-in does, or it stays trapped in the frame's tab. */
  get(k) {
    const raw = [null, null]
    try { raw[0] = localStorage.getItem(k) } catch {}
    try { raw[1] = sessionStorage.getItem(k) } catch {}
    if (!raw[0]) return raw[1]
    if (!raw[1]) return raw[0]
    if (raw[0] === raw[1]) return raw[0]
    const exp = r => { try { return JSON.parse(r).expires ?? 0 } catch { return 0 } }
    return exp(raw[1]) > exp(raw[0]) ? raw[1] : raw[0]
  },
  set(k, v) {
    try { localStorage.setItem(k, v) } catch {}
    try { sessionStorage.setItem(k, v) } catch {}
  },
  del(k) {
    try { localStorage.removeItem(k) } catch {}
    try { sessionStorage.removeItem(k) } catch {}
  },
}

/* Tabs already open when a sign-in happens elsewhere should not sit on the gate
 * waiting for a reload. localStorage alone would only reach them on their next
 * load, so the event is broadcast too. */
const CHANNEL = 'pghub-auth'
let _bc = null
try { _bc = new BroadcastChannel(CHANNEL) } catch { /* unsupported: storage still works */ }

const GIS_SRC = 'https://accounts.google.com/gsi/client'
let _gisPromise = null

/** Load Google Identity Services once.
 *
 * Called eagerly at gate install, not lazily inside the click handler: opening
 * the OAuth popup must happen in the same task as the user's click, and an
 * `await` before requestAccessToken spends that user-gesture token, after which
 * Chrome blocks the popup silently — the button just sits on "Signing in…".
 */
export function loadGIS() {
  if (typeof google !== 'undefined' && google.accounts?.oauth2) return Promise.resolve()
  return _gisPromise ??= new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    const s = existing ?? Object.assign(document.createElement('script'),
      { src: GIS_SRC, async: true, defer: true })
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error(
      'Could not load Google sign-in. A network block or tracking-protection ' +
      'extension is the usual cause.')))
    if (!existing) document.head.appendChild(s)
  })
}

// Auth traffic goes straight to the browser: it is cross-origin, the store
// would only pass it through anyway, and routing it through the app handler
// during startup is how the recursion above bites.
const rawFetch = (...a) => (window.__pghubNativeFetch ?? window.fetch)(...a)

export const GAuth = {
  _token: null,
  _user:  null,
  _reauthInFlight: null,

  /** Restore a token saved earlier — survives reloads, other tabs and restarts. */
  restore() {
    try {
      const raw = store.get(Config.ns + TOK_KEY)
      if (!raw) return false
      const { token, expires } = JSON.parse(raw)
      // Expired or nearly so: drop it, or every page load retries a token that
      // cannot work and the gate's error is the first thing the user sees.
      if (Date.now() >= expires - 5 * 60 * 1000) { this.signOut({ broadcast: false }); return false }
      this._token = token
      const u = store.get(Config.ns + USR_KEY)
      if (u) this._user = JSON.parse(u)
      return true
    } catch { return false }
  },

  /**
   * Adopt a session another tab just established, and tell the gate.
   * @param onAdopt called when this tab was signed out and now is not.
   */
  listen(onAdopt) {
    const adopt = () => { if (!this.isSignedIn() && this.restore()) onAdopt?.() }
    // Same-origin tabs, immediately.
    try { _bc?.addEventListener('message', e => {
      if (e.data?.type === 'signin') adopt()
      if (e.data?.type === 'signout') { this._token = null; this._user = null }
    }) } catch {}
    // BroadcastChannel is not everywhere, and the storage event fires in other
    // tabs regardless — belt and braces, both funnel into the same guard.
    window.addEventListener('storage', e => {
      if (e.key === Config.ns + TOK_KEY && e.newValue) adopt()
    })
  },

  getToken() { return this._token },
  getUser()  { return this._user },
  isSignedIn() { return !!this._token },

  /**
   * @param prompt  '' lets Google reuse the current session silently, which is
   *                what you want almost always. Pass 'select_account' to force
   *                the chooser — needed after signing in with an account that
   *                cannot see the content, since silent reuse would just pick
   *                the same one again.
   */
  signIn(prompt = '') {
    // Fast path: GIS is already loaded (preloaded at gate install), so the
    // token client is built and the popup opened synchronously, still inside
    // the click's gesture. Only a cold start pays the await, and then the
    // user's second click succeeds.
    if (typeof google === 'undefined' || !google.accounts?.oauth2) {
      return loadGIS().then(() => this._requestToken(prompt))
    }
    return this._requestToken(prompt)
  },

  _requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: Config.clientId,
        scope: Config.scopes.join(' '),
        callback: async res => {
          if (res.error) { reject(new Error(res.error)); return }
          this._token = res.access_token
          const expires = Date.now() + (res.expires_in ?? 3600) * 1000
          store.set(Config.ns + TOK_KEY, JSON.stringify({ token: this._token, expires }))

          try {
            const r = await rawFetch('https://www.googleapis.com/oauth2/v1/userinfo', {
              headers: { Authorization: `Bearer ${this._token}` },
            })
            this._user = await r.json()
            store.set(Config.ns + USR_KEY, JSON.stringify(this._user))
          } catch { /* profile is cosmetic — carry on without it */ }

          // Courtesy check only. The real boundary is the Drive folder's ACL:
          // a disallowed account simply cannot read the content regardless of
          // what this branch does.
          if (this._user?.email && !(await isEmailAllowed(this._user.email))) {
            const who = this._user.email
            this.signOut()
            reject(new Error(`${who} doesn't have access to this hub.`))
            return
          }
          // Any tab sitting on the gate can come in now, without a reload.
          try { _bc?.postMessage({ type: 'signin' }) } catch {}
          resolve(this._user)
        },
      })
      client.requestAccessToken({ prompt })
    })
  },

  signOut({ broadcast = true } = {}) {
    // Deliberately NOT google.accounts.oauth2.revoke(). Revoking withdraws the
    // user's grant to the whole Cloud project, not just this tab — which takes
    // the command-line tooling's refresh token down with it, since it lives
    // under the same project. Signing out of a browser session should end that
    // session, so the token is simply dropped. It expires on its own within
    // the hour; to withdraw access properly, use the Google account page.
    this._token = null
    this._user  = null
    store.del(Config.ns + TOK_KEY)
    store.del(Config.ns + USR_KEY)
    // Signing out in one tab should not leave the others holding a token that
    // is no longer in storage.
    if (broadcast) { try { _bc?.postMessage({ type: 'signout' }) } catch {} }
  },

  /** Run a request; on 401 re-authorize once (coalesced) and retry. */
  async withAuthRetry(makeRequest) {
    let res = await makeRequest()
    if (res.status !== 401) return res
    if (!this._reauthInFlight) {
      this._reauthInFlight = this.signIn().catch(() => {})
      this._reauthInFlight.finally?.(() => { this._reauthInFlight = null })
    }
    try { await this._reauthInFlight } catch {}
    res = await makeRequest()
    if (res.status === 401) {
      this.signOut()
      window.dispatchEvent(new Event('gauth:expired'))
    }
    return res
  },

  /** Authenticated fetch — header is rebuilt per attempt so retries use the fresh token. */
  fetch(url, init = {}) {
    return this.withAuthRetry(() => {
      const headers = new Headers(init.headers || {})
      if (this._token) headers.set('Authorization', `Bearer ${this._token}`)
      return window.fetch(url, { ...init, headers })
    })
  },
}
