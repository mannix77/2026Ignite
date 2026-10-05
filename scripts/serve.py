#!/usr/bin/env python3
"""Run the planner locally: serves the app and lets the "Re-sync now" button pull the
live Ignite catalog (the catalog API blocks direct browser access, so the sync runs here).

    python3 scripts/serve.py              # http://localhost:8026
    python3 scripts/serve.py --port 9000
    python3 scripts/serve.py --lan        # also reachable from your phone on the same Wi-Fi
"""
import argparse
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC = os.path.join(ROOT, "scripts", "sync.py")
_lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split("?")[0]
        if path.startswith("/data/") or path.endswith((".js", ".css", ".html", "/")) or path == "/sw.js":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            return self._json(200, {"local": True})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/sync":
            return self._json(404, {"ok": False, "output": "not found"})
        if not _lock.acquire(blocking=False):
            return self._json(409, {"ok": False, "output": "a sync is already running"})
        try:
            proc = subprocess.run([sys.executable, SYNC], cwd=ROOT, capture_output=True, text=True, timeout=180)
            out = (proc.stdout + proc.stderr).strip()
            return self._json(200 if proc.returncode == 0 else 502, {"ok": proc.returncode == 0, "output": out})
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "output": "sync timed out"})
        finally:
            _lock.release()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
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
    if not args.no_sync:
        print("Refreshing catalog…", flush=True)
        subprocess.run([sys.executable, SYNC], cwd=ROOT)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    handler = functools.partial(Handler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer((host, args.port), handler)
    print("Ignite planner running at http://localhost:%d" % args.port)
    if args.lan:
        print("On your phone (same Wi-Fi): http://%s:%d" % (lan_ip(), args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
