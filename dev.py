#!/usr/bin/env python3
"""Static file server for local development.

The hub is a static site now — there is no backend to run, and no per-module
`python3 server.py` on its own port. This exists only so the pages are served
over http:// rather than file://, which Google sign-in and ES modules both
require.

Port 5173 is the default deliberately: it is Vite's, which means it is almost
certainly already listed under "Authorized JavaScript origins" on the OAuth
client this project shares with the System Design hub. Serving from an
unregistered origin makes Google reject the sign-in popup with origin_mismatch.

Run:  python3 dev.py          then open http://localhost:5173/
      python3 dev.py 5174     (must also be a registered origin)

If the port is taken, the next free one is used and printed — which is only
useful for sign-in if that origin is registered too.
"""
import errno
import os
import socket
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
TRIES = 20      # how far past the requested port to look for a free one
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "5173"))


def _also_on_ipv6(port):
    """True if something holds [::1]:port — see the note printed at startup."""
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
        try:
            probe.connect(("::1", port))
            return True
        except OSError:
            return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Everything here is edited live; never serve a stale module.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        # Quiet the per-asset noise; surface only failures.
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("  %s %s\n" % (args[1], args[0]))


if __name__ == "__main__":
    HTTPServer.allow_reuse_address = True
    # A busy port is usually this server already running in another terminal.
    # Walk forward to the next free one rather than stopping.
    wanted, httpd = PORT, None
    for PORT in range(wanted, wanted + TRIES):
        try:
            httpd = HTTPServer(("127.0.0.1", PORT), Handler)
            break
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                raise
    if httpd is None:
        sys.exit(f"\n  Ports {wanted}–{wanted + TRIES - 1} are all in use.\n")
    if PORT != wanted:
        print(f"\n  Port {wanted} is already in use — using {PORT} instead.")
        print(f"  Google will refuse sign-in unless http://localhost:{PORT} and")
        print(f"  http://127.0.0.1:{PORT} are authorized JavaScript origins on the")
        print(f"  OAuth client. If {wanted} is this server in another terminal, use that.\n")
    # Google matches the origin exactly, and "localhost" is the one registered
    # on the OAuth client — 127.0.0.1 is a different origin and is refused with
    # origin_mismatch. So localhost is the address to print, unless something
    # else holds [::1] on this port (a Vite server, say): binding 127.0.0.1
    # leaves ::1 free, and "localhost" may then reach that other server.
    if _also_on_ipv6(PORT):
        print(f"  PG Hub Technologies  →  http://127.0.0.1:{PORT}/")
        print(f"\n  NOTE: something else is listening on [::1]:{PORT}, so")
        print(f"        http://localhost:{PORT}/ may reach that instead.")
        print(f"        Use the 127.0.0.1 address above, and make sure it is an")
        print(f"        authorized JavaScript origin on the OAuth client.")
    else:
        print(f"  PG Hub Technologies  →  http://localhost:{PORT}/")
    print("\n  (sign in with the Google account that owns the Drive folder)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
