#!/usr/bin/env python3
"""Run the planner locally: serves the app and lets the "Re-sync & log" button pull the
live Ignite catalog through scripts/sync.py.

    python3 scripts/serve.py              # http://localhost:8026
    python3 scripts/serve.py --port 9000
    python3 scripts/serve.py --lan        # also reachable from your phone on the same Wi-Fi

Local syncs write to .local-data/ignite2026/ (git-ignored, seeded from data/ignite2026/), so
they never collide with the catalog commits the GitHub Action makes. Other conferences'
folders (data/gartner2026/) are served as committed. On a phone, prefer the GitHub Pages
deployment: it's HTTPS (offline mode works) and its address never changes.
"""
import argparse
import functools
import http.server
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC = os.path.join(ROOT, "scripts", "sync.py")
LOCAL_DATA = os.path.join(ROOT, ".local-data", "ignite2026")
COMMITTED = os.path.join(ROOT, "data", "ignite2026")
ALLOWED_FILES = {"/", "/index.html", "/sw.js", "/manifest.webmanifest"}
ALLOWED_PREFIXES = ("/assets/", "/data/", "/tests/fixtures/")
_lock = threading.Lock()


def _generated(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("generatedAt") or ""
    except (OSError, ValueError, AttributeError):
        return ""


def seed_local_data():
    """Start the local history from the committed snapshot, and take a newer committed
    catalog (e.g. after git pull) over a stale local copy."""
    os.makedirs(LOCAL_DATA, exist_ok=True)
    for name in ("sessions.json", "changes.json", "meta.json", "watchlist.json"):
        src, dst = os.path.join(COMMITTED, name), os.path.join(LOCAL_DATA, name)
        if not os.path.exists(src):
            continue
        newer = name in ("sessions.json", "meta.json") and _generated(src) > _generated(dst)
        if not os.path.exists(dst) or newer:
            shutil.copy2(src, dst)


def run_sync():
    return subprocess.run([sys.executable, SYNC, "--data-dir", LOCAL_DATA], cwd=ROOT,
                          capture_output=True, text=True, timeout=240)


class Handler(http.server.SimpleHTTPRequestHandler):
    token = None  # required for /api/sync when listening on the LAN

    def translate_path(self, path):
        clean = urllib.parse.urlsplit(path).path
        if clean.startswith("/data/ignite2026/") and os.path.isdir(LOCAL_DATA):
            local = os.path.join(LOCAL_DATA, os.path.basename(clean))
            if os.path.exists(local):
                return local
        return super().translate_path(path)

    def allowed(self):
        p = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        return ".." not in p and (p in ALLOWED_FILES or p.startswith(ALLOWED_PREFIXES))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/status":
            return self._json(200, {"local": True})
        if not self.allowed():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            return self.send_error(404)
        return super().do_HEAD()

    def same_origin(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        return origin is None or urllib.parse.urlsplit(origin).netloc == host

    def do_POST(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path != "/api/sync":
            return self._json(404, {"ok": False, "output": "not found"})
        if not self.same_origin():
            return self._json(403, {"ok": False, "output": "cross-site request refused"})
        local = self.client_address[0] in ("127.0.0.1", "::1")
        if self.token and not local and urllib.parse.parse_qs(parts.query).get("token", [""])[0] != self.token:
            return self._json(403, {"ok": False, "output": "re-sync from the computer running serve.py"})
        if not _lock.acquire(blocking=False):
            return self._json(409, {"ok": False, "output": "a sync is already running"})
        try:
            proc = run_sync()
            out = (proc.stdout + proc.stderr).strip()
            return self._json(200 if proc.returncode == 0 else 502, {"ok": proc.returncode == 0, "output": out})
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "output": "sync timed out"})
        finally:
            _lock.release()

    def log_message(self, fmt, *args):
        if "/api/" in getattr(self, "path", ""):
            super().log_message(fmt, *args)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="Serve the Ignite planner locally")
    ap.add_argument("--port", type=int, default=8026)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (phone on same Wi-Fi)")
    ap.add_argument("--no-sync", action="store_true", help="don't refresh the catalog on startup")
    args = ap.parse_args()
    seed_local_data()
    if not args.no_sync:
        print("Refreshing catalog…", flush=True)
        proc = run_sync()
        print((proc.stdout + proc.stderr).strip())
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    if args.lan:
        Handler.token = secrets.token_urlsafe(12)
    handler = functools.partial(Handler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer((host, args.port), handler)
    print("Ignite planner running at http://localhost:%d" % args.port)
    if args.lan:
        print("On your phone (same Wi-Fi): http://%s:%d  (re-sync is only allowed from this computer)" % (lan_ip(), args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
