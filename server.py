#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Static site + official-data update API.

  GET  /api/latest   -> latest official snapshot JSON
  GET  /api/status   -> update status

The server also checks for official updates every 6 hours in the background.
"""
from __future__ import annotations
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LATEST = ROOT / "official_latest.json"
UPDATE = ROOT / "update_official.py"
UPDATE_LOCK = threading.Lock()
REFRESH_SECONDS = 24 * 3600
STATE = {"lastCheck": None, "lastResult": None, "busy": False}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_latest() -> dict:
    if not LATEST.exists():
        return {"ok": False, "status": "missing", "error": "official_latest.json not found"}
    try:
        d = json.loads(LATEST.read_text(encoding="utf-8"))
        d["ok"] = True
        return d
    except Exception as e:
        return {"ok": False, "status": "error", "error": str(e)}


def run_update() -> dict:
    if not UPDATE_LOCK.acquire(blocking=False):
        return {"ok": False, "status": "busy", "error": "update already running"}
    try:
        STATE["busy"] = True
        STATE["lastCheck"] = now_iso()
        proc = subprocess.run(
            [sys.executable, str(UPDATE)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=240,
        )
        out = (proc.stdout or "").strip().splitlines()
        err = (proc.stderr or "").strip()
        ok = proc.returncode == 0
        STATE["lastResult"] = {
            "ok": ok,
            "at": now_iso(),
            "returncode": proc.returncode,
            "stdout": out[-3:],
            "stderr": err[-800:],
        }
        if not ok:
            return {"ok": False, "status": "error", "error": err[-800:] or "updater failed", "result": STATE["lastResult"]}
        data = read_latest()
        data["refresh"] = STATE["lastResult"]
        return data
    except subprocess.TimeoutExpired:
        return {"ok": False, "status": "timeout", "error": "official update timed out"}
    except Exception as e:
        return {"ok": False, "status": "error", "error": str(e)}
    finally:
        STATE["busy"] = False
        UPDATE_LOCK.release()


def update_if_stale(force: bool = False) -> None:
    try:
        if LATEST.exists():
            d = json.loads(LATEST.read_text(encoding="utf-8"))
            ts = d.get("updatedAt")
            if ts:
                age = time.time() - datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
                if not force and age < REFRESH_SECONDS:
                    return
        run_update()
    except Exception as e:
        STATE["lastResult"] = {"ok": False, "at": now_iso(), "error": str(e)}


def auto_loop() -> None:
    # First check shortly after startup, then every 24 hours.
    time.sleep(2)
    update_if_stale(force=True)
    while True:
        time.sleep(REFRESH_SECONDS)
        update_if_stale()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/latest":
            self._json(read_latest())
            return
        if path == "/api/status":
            self._json({
                "ok": True,
                "state": STATE,
                "latest": (read_latest() or {}).get("latestMonth"),
                "updatedAt": (read_latest() or {}).get("updatedAt"),
                "refreshSeconds": REFRESH_SECONDS,
            })
            return
        # The page is a standalone file; only expose the entry point and API.
        # This keeps README, raw data, CSV files and the build scripts private
        # when the local server is published through a tunnel.
        if path not in ("/", "/index.html", "/favicon.ico"):
            self._json({"ok": False, "error": "not found"}, 404)
            return
        super().do_GET()

    def do_POST(self):
        # Public manual refresh is intentionally disabled. Only the server's
        # 24-hour timer (and startup check) may run the official updater.
        self._json({"ok": False, "error": "not found"}, 404)

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        if self.path.endswith(".html") or self.path in ("/", ""):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[web] " + (fmt % args) + "\n")


def main():
    # Ensure a snapshot exists before serving.
    if not LATEST.exists():
        update_if_stale(force=True)
    threading.Thread(target=auto_loop, daemon=True).start()
    host, port = "0.0.0.0", 8080
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving {ROOT} on http://{host}:{port}/")
    print(f"Auto-update every {REFRESH_SECONDS // 3600}h; API: /api/latest")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
