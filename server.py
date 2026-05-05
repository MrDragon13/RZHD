#!/usr/bin/env python3
"""Tiny production-friendly static server with an optional RZD timetable proxy."""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "app" / "data" / "routes.json"
RZD_BASE = "https://pass.rzd.ru/timetable/public/ru"
RZD_TIMEOUT_SECONDS = 12


class RzdTrackerHandler(SimpleHTTPRequestHandler):
    server_version = "RzdTracker/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/health":
            self.send_json({"ok": True, "service": "rzd-live-tracker"})
            return

        if parsed.path == "/api/routes":
            self.send_routes()
            return

        if parsed.path == "/api/rzd/search":
            self.search_rzd(parsed.query)
            return

        self.path = self.rewrite_static_path(parsed.path)
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))

    def rewrite_static_path(self, path: str) -> str:
        if path in {"", "/"}:
            return "/index.html"

        asset_map = {
            "/app.js": "/app/main.js",
            "/styles.css": "/app/styles.css",
        }
        if path in asset_map:
            return asset_map[path]

        candidate = (ROOT / path.lstrip("/")).resolve()
        if ROOT in candidate.parents or candidate == ROOT:
            if candidate.exists():
                return path

        return "/index.html"

    def send_routes(self) -> None:
        try:
            with DATA_FILE.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except OSError as error:
            self.send_json(
                {"error": "routes_unavailable", "message": str(error)},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return

        self.send_json(data)

    def search_rzd(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        origin = first_query_value(params, "origin")
        destination = first_query_value(params, "destination")
        date = first_query_value(params, "date")

        if not origin or not destination or not date:
            self.send_json(
                {"error": "bad_request", "message": "origin, destination and date are required"},
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        if os.environ.get("RZD_LIVE_PROXY", "1").lower() in {"0", "false", "no", "off"}:
            self.send_json(
                {
                    "status": "unavailable",
                    "reason": "RZD live proxy is disabled by RZD_LIVE_PROXY.",
                }
            )
            return

        try:
            result = fetch_rzd_timetable(origin=origin, destination=destination, date=date)
        except Exception as error:  # pragma: no cover - network fallback is runtime-specific.
            self.send_json({"status": "unavailable", "reason": str(error)})
            return

        self.send_json(result)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def first_query_value(params: dict[str, list[str]], key: str) -> str | None:
    value = params.get(key, [None])[0]
    return value.strip() if isinstance(value, str) else None


def fetch_rzd_timetable(origin: str, destination: str, date: str) -> dict[str, Any]:
    session = CookieSession()
    request_params = {
        "layer_id": "5827",
        "dir": "0",
        "tfl": "3",
        "checkSeats": "0",
        "code0": origin,
        "code1": destination,
        "dt0": date,
        "md": "1",
    }
    initial_url = f"{RZD_BASE}?{urllib.parse.urlencode(request_params)}"
    initial_payload = session.post_json(initial_url)
    rid = initial_payload.get("RID")

    if not rid:
        return normalize_rzd_response(initial_payload)

    # The RZD endpoint usually needs a short delay between RID creation and result polling.
    time.sleep(float(os.environ.get("RZD_POLL_DELAY", "2")))
    response = session.post_json(
        f"{RZD_BASE}?layer_id=5827",
        data=urllib.parse.urlencode({"rid": rid}).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    return normalize_rzd_response(response)


def normalize_rzd_response(payload: dict[str, Any]) -> dict[str, Any]:
    trains: list[dict[str, Any]] = []

    for item in payload.get("tp", []) or payload.get("trains", []) or []:
        number = item.get("number") or item.get("trainNumber") or item.get("num")
        route = item.get("route") or item.get("route0") or item.get("station0")
        departure = item.get("date0") or item.get("time0") or item.get("localDate0")
        arrival = item.get("date1") or item.get("time1") or item.get("localDate1")
        trains.append(
            {
                "number": number,
                "route": route,
                "departure": departure,
                "arrival": arrival,
                "raw": item,
            }
        )

    return {
        "status": "ok",
        "source": "pass.rzd.ru",
        "trains": trains,
        "raw": payload,
    }


class CookieSession:
    def __init__(self) -> None:
        self.cookies: dict[str, str] = {}
        self.context = ssl.create_default_context()

    def post_json(
        self,
        url: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        request_headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "User-Agent": "RzdLiveTracker/1.0 (+https://www.rzd.ru/)",
            "X-Requested-With": "XMLHttpRequest",
            **(headers or {}),
        }
        if self.cookies:
            request_headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in self.cookies.items())

        request = urllib.request.Request(url, data=data or b"", headers=request_headers, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=RZD_TIMEOUT_SECONDS, context=self.context) as response:
                self.capture_cookies(response.headers.get_all("Set-Cookie", []))
                charset = response.headers.get_content_charset("utf-8")
                return json.loads(response.read().decode(charset))
        except urllib.error.HTTPError as error:
            message = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"RZD HTTP {error.code}: {message[:300]}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"RZD network error: {error.reason}") from error

    def capture_cookies(self, set_cookie_headers: list[str]) -> None:
        for header in set_cookie_headers:
            cookie = header.split(";", 1)[0]
            if "=" not in cookie:
                continue
            name, value = cookie.split("=", 1)
            self.cookies[name] = value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RZD Live Tracker web application.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", default=int(os.environ.get("PORT", "8000")), type=int)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), RzdTrackerHandler)
    print(f"RZD Live Tracker is running at http://{args.host}:{args.port}")
    print("Open http://localhost:%s in your browser." % args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
