#!/usr/bin/env python3
"""
Schedule Lab local server + Tunarr proxy.

Serves the newest tunarr-schedule-lab*.html in this folder at
http://localhost:8765/ and forwards every /api/... request to Tunarr.
Because the page and the API now share one origin, the browser has
no CORS or mixed-content reason to block anything.

Usage:
  python3 lab-server.py http://YOUR-TUNARR-HOST:8000
  python3 lab-server.py http://YOUR-TUNARR-HOST:8000 8765   (optional port)

Then open http://localhost:8765/ and click Connect with the
address box left EMPTY (the page will call /api on this server).
"""
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TUNARR = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
HERE = os.path.dirname(os.path.abspath(__file__))


def find_html():
    files = [os.path.join(HERE, f) for f in os.listdir(HERE)
             if f.lower().startswith("tunarr-schedule-lab") and f.lower().endswith(".html")]
    return max(files, key=os.path.getmtime) if files else None


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, data, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _serve_page(self):
        path = find_html()
        if not path:
            self._send(404, b"No tunarr-schedule-lab*.html found next to lab-server.py", "text/plain")
            return
        with open(path, "rb") as f:
            self._send(200, f.read(), "text/html; charset=utf-8")

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(TUNARR + self.path, data=body, method=self.command)
        for h in ("Content-Type", "Accept"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            resp = urllib.request.urlopen(req, timeout=120)
            status, headers, data = resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:  # pass Tunarr's own error through untouched
            status, headers, data = e.code, e.headers, e.read()
        except Exception as e:
            msg = f"Proxy could not reach Tunarr at {TUNARR}: {e}".encode()
            self._send(502, msg, "text/plain")
            return
        self._send(status, data, headers.get("Content-Type", "application/json"))

    def _route(self):
        if self.path.startswith("/api"):
            self._proxy()
        elif self.command == "GET" and self.path.split("?")[0] in ("/", "/index.html"):
            self._serve_page()
        else:
            self._send(404, b"Not found", "text/plain")

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _route

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[lab] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}\n")


if __name__ == "__main__":
    print(f"Schedule Lab:  http://localhost:{PORT}/")
    print(f"Proxying /api to {TUNARR}")
    print("Leave the address box in the page EMPTY and click Connect.  Ctrl+C to stop.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
