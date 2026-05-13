#!/usr/bin/env python3
"""Минимальный сервер приложения RZD Live Tracker.

Этот файл намеренно написан на стандартной библиотеке Python, чтобы приложение
можно было запустить командой `python3 server.py` без установки Flask, FastAPI,
Node.js, сборщиков фронтенда или других внешних зависимостей. Сервер выполняет
две роли:

1. Отдает статические файлы веб-интерфейса: `index.html`, CSS, JavaScript и
   данные маршрутов.
2. Предоставляет небольшой JSON API, включая proxy-метод для неофициального
   endpoint РЖД `pass.rzd.ru`, чтобы браузер не сталкивался с CORS-ограничениями.

Комментарии в этом файле специально подробные и русскоязычные: они описывают не
только "что делает строка", но и "почему решение выбрано именно так".
"""

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


# Абсолютный путь к корню репозитория. Мы вычисляем его от расположения самого
# `server.py`, а не от текущей рабочей директории процесса. Благодаря этому
# сервер одинаково работает при запуске из `/workspace`, из другой папки через
# абсолютный путь или из process manager вроде systemd/docker-compose.
ROOT = Path(__file__).resolve().parent

# JSON-файл со встроенным каталогом станций и маршрутов. Он нужен для полностью
# автономного режима: даже если pass.rzd.ru временно недоступен, интерфейс все
# равно показывает карту, линии маршрутов, станции и расчетные позиции поездов.
DATA_FILE = ROOT / "app" / "data" / "routes.json"

# Базовый endpoint неофициального API РЖД. У публичного сайта РЖД нет стабильного
# официального API для такого frontend-only сценария, поэтому proxy изолирует
# остальной код приложения от деталей внутреннего контракта pass.rzd.ru.
RZD_BASE = "https://pass.rzd.ru/timetable/public/ru"

# Ограничение времени ожидания сетевого запроса к РЖД. Важно не зависать навсегда:
# браузер должен быстро получить либо live-данные, либо понятный fallback-ответ.
RZD_TIMEOUT_SECONDS = 12


class RzdTrackerHandler(SimpleHTTPRequestHandler):
    """HTTP-handler, который совмещает static serving и JSON API.

    `SimpleHTTPRequestHandler` уже умеет безопасно отдавать файлы из заданной
    директории. Мы расширяем его только там, где нужны API endpoints и SPA-like
    fallback на `index.html` для неизвестных URL.
    """

    # Человекочитаемое имя сервера попадет в заголовок `Server`. Это не влияет на
    # бизнес-логику, но помогает отличать приложение в логах и curl-ответах.
    server_version = "RzdTracker/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Передаем корневую директорию явно, чтобы стандартный handler не пытался
        # отдавать файлы из той папки, из которой случайно был запущен процесс.
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        # Разбираем URL на путь и query-string. Это позволяет маршрутизировать
        # `/api/rzd/search?origin=...` по path, а параметры отдельно передать
        # обработчику live-поиска.
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/health":
            # Health-check нужен для smoke-тестов, контейнеров и внешних
            # балансировщиков: он подтверждает, что процесс поднялся и отвечает.
            self.send_json({"ok": True, "service": "rzd-live-tracker"})
            return

        if parsed.path == "/api/routes":
            # Основной endpoint фронтенда. Клиент загружает отсюда встроенный
            # каталог станций, маршрутов, цветов линий и расписаний отправления.
            self.send_routes()
            return

        if parsed.path == "/api/rzd/search":
            # Отдельный proxy endpoint для live-поиска. Браузер не ходит на РЖД
            # напрямую: это убирает CORS-проблемы и позволяет серверу хранить
            # cookies/RID-состояние между двумя POST-запросами к pass.rzd.ru.
            self.search_rzd(parsed.query)
            return

        # Все не-API запросы считаем запросами статических ресурсов. Метод ниже
        # переписывает короткие алиасы (`/app.js`, `/styles.css`) и возвращает
        # `index.html` для неизвестного пути.
        self.path = self.rewrite_static_path(parsed.path)
        super().do_GET()

    def end_headers(self) -> None:
        # Базовые защитные заголовки не превращают этот мини-сервер в полноценный
        # hardened production gateway, но закрывают самые очевидные риски:
        # - браузер не должен "угадывать" MIME-тип;
        # - Referer не должен раскрывать полный локальный URL при внешних переходах.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        # Оставляем формат логов близким к стандартному `http.server`, но явно
        # пишем в stderr, чтобы process manager или Docker корректно собирали логи.
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))

    def rewrite_static_path(self, path: str) -> str:
        # Корневой путь всегда открывает главный HTML-файл приложения.
        if path in {"", "/"}:
            return "/index.html"

        # Короткие пути нужны для обратной совместимости с ранней разметкой и для
        # удобства smoke-тестов. Реальные файлы лежат внутри `app/`.
        asset_map = {
            "/app.js": "/app/main.js",
            "/styles.css": "/app/styles.css",
        }
        if path in asset_map:
            return asset_map[path]

        # Защита от path traversal: преобразуем путь в абсолютный и проверяем, что
        # он все еще находится внутри ROOT. Например, `/../../etc/passwd` не должен
        # стать доступным статическим файлом.
        candidate = (ROOT / path.lstrip("/")).resolve()
        if ROOT in candidate.parents or candidate == ROOT:
            if candidate.exists():
                return path

        # Если файл не найден, возвращаем главную страницу. Это удобно для будущего
        # расширения до SPA-роутинга: `/routes/751A` сможет открывать интерфейс, а
        # клиентский JS уже решит, что показать.
        return "/index.html"

    def send_routes(self) -> None:
        try:
            # Читаем JSON каждый раз с диска, а не кэшируем в памяти. Для маленького
            # каталога это дешево, зато изменения данных видны сразу после
            # перезапуска/обновления файла без дополнительных механизмов invalidation.
            with DATA_FILE.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except OSError as error:
            # Если файл не найден или недоступен, клиент получает структурированную
            # JSON-ошибку, а не HTML-страницу 500. Это упрощает обработку ошибок на
            # фронтенде и в автоматических проверках.
            self.send_json(
                {"error": "routes_unavailable", "message": str(error)},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
            return

        self.send_json(data)

    def search_rzd(self, query: str) -> None:
        # `parse_qs` возвращает словарь вида {"origin": ["2000000"]}. Отдельная
        # helper-функция ниже достает первый элемент и обрезает пробелы.
        params = urllib.parse.parse_qs(query)
        origin = first_query_value(params, "origin")
        destination = first_query_value(params, "destination")
        date = first_query_value(params, "date")

        if not origin or not destination or not date:
            # Для live-поиска обязательны оба кода станций и дата. Без этих данных
            # невозможно сформировать корректный запрос к layer_id=5827.
            self.send_json(
                {"error": "bad_request", "message": "origin, destination and date are required"},
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        if os.environ.get("RZD_LIVE_PROXY", "1").lower() in {"0", "false", "no", "off"}:
            # Переменная окружения позволяет принудительно отключить внешнюю сеть.
            # Это полезно для демо, тестов, CI и сред, где обращения к pass.rzd.ru
            # нежелательны или невозможны.
            self.send_json(
                {
                    "status": "unavailable",
                    "reason": "RZD live proxy is disabled by RZD_LIVE_PROXY.",
                }
            )
            return

        try:
            # Внешний API может быть медленным, менять формат ответа или отдавать
            # временные ошибки. Любая проблема превращается в штатный JSON-fallback,
            # чтобы пользовательский интерфейс продолжал работать.
            result = fetch_rzd_timetable(origin=origin, destination=destination, date=date)
        except Exception as error:  # pragma: no cover - network fallback is runtime-specific.
            self.send_json({"status": "unavailable", "reason": str(error)})
            return

        self.send_json(result)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        # `ensure_ascii=False` сохраняет кириллицу читаемой в ответах API. Это важно
        # для отладки: curl/браузер показывают "Москва", а не escape-последовательности.
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # API-ответы не кэшируем: состояние live-поиска и каталога может меняться, а
        # stale JSON способен запутать пользователя при проверке актуальности данных.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def first_query_value(params: dict[str, list[str]], key: str) -> str | None:
    # Query-string допускает несколько значений одного ключа, но API приложения
    # ожидает ровно одно. Берем первое значение, как это обычно делают веб-фреймворки.
    value = params.get(key, [None])[0]
    return value.strip() if isinstance(value, str) else None


def fetch_rzd_timetable(origin: str, destination: str, date: str) -> dict[str, Any]:
    """Выполняет двухшаговый запрос к неофициальному расписанию РЖД.

    Сайт РЖД сначала возвращает RID (request id) и cookies, затем отдельным POST
    по этому RID отдает фактические результаты. Поэтому здесь создается простая
    cookie-сессия и выполняются два запроса подряд.
    """

    session = CookieSession()
    # Набор параметров соответствует reverse-engineered endpoint `layer_id=5827`,
    # который используется для поиска поездов между двумя станциями.
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
    # Первый POST инициирует расчет/поиск на стороне РЖД и обычно возвращает RID.
    initial_payload = session.post_json(initial_url)
    rid = initial_payload.get("RID")

    if not rid:
        # Иногда endpoint может сразу вернуть данные или ошибку вместо RID. В таком
        # случае не пытаемся искусственно продолжать polling, а нормализуем то, что
        # уже получили.
        return normalize_rzd_response(initial_payload)

    # Endpoint РЖД обычно требует паузу между созданием RID и чтением результата.
    # Значение вынесено в переменную окружения, потому что в разных сетях и в разные
    # периоды сайт может требовать более длинную задержку.
    time.sleep(float(os.environ.get("RZD_POLL_DELAY", "2")))
    # Второй POST отправляет RID в form-urlencoded теле. Cookies, полученные на
    # первом шаге, добавляются автоматически внутри CookieSession.
    response = session.post_json(
        f"{RZD_BASE}?layer_id=5827",
        data=urllib.parse.urlencode({"rid": rid}).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    return normalize_rzd_response(response)


def normalize_rzd_response(payload: dict[str, Any]) -> dict[str, Any]:
    """Приводит нестабильный ответ РЖД к небольшому контракту фронтенда.

    Внутренний API pass.rzd.ru не является стабильным публичным контрактом, поэтому
    поля могут называться по-разному. Фронтенду же нужны простые свойства:
    `number`, `route`, `departure`, `arrival`.
    """

    trains: list[dict[str, Any]] = []

    for item in payload.get("tp", []) or payload.get("trains", []) or []:
        # Используем цепочки fallback-полей, потому что разные варианты ответа РЖД
        # могут использовать разные имена для номера поезда и времен отправления.
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
        # Нормализованный список удобен для UI, а raw оставлен для диагностики и
        # будущего развития интеграции без повторного reverse engineering.
        "trains": trains,
        "raw": payload,
    }


class CookieSession:
    """Мини-сессия на urllib для хранения cookies между POST-запросами.

    requests/httpx здесь не используются намеренно: проект должен запускаться без
    установки зависимостей. Этого класса достаточно для RID-сценария РЖД.
    """

    def __init__(self) -> None:
        # Cookies храним как простой словарь "имя -> значение". Для текущей задачи
        # не нужны path/domain/expires-атрибуты, потому что все запросы идут на один
        # endpoint pass.rzd.ru в рамках одной короткой операции.
        self.cookies: dict[str, str] = {}
        # Контекст TLS создается стандартным способом, чтобы urllib проверял
        # сертификаты сервера и не отключал HTTPS-защиту.
        self.context = ssl.create_default_context()

    def post_json(
        self,
        url: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        # Заголовки имитируют обычный AJAX-запрос браузера к сайту РЖД. Некоторые
        # внутренние endpoints чувствительны к Accept/User-Agent/X-Requested-With.
        request_headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "User-Agent": "RzdLiveTracker/1.0 (+https://www.rzd.ru/)",
            "X-Requested-With": "XMLHttpRequest",
            **(headers or {}),
        }
        if self.cookies:
            # На втором шаге RID-polling важно вернуть JSESSIONID и другие cookies,
            # иначе pass.rzd.ru может не связать polling-запрос с первоначальным RID.
            request_headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in self.cookies.items())

        # urllib считает наличие `data` признаком POST-запроса. Мы также явно
        # указываем method="POST", чтобы поведение было очевидным при чтении кода.
        request = urllib.request.Request(url, data=data or b"", headers=request_headers, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=RZD_TIMEOUT_SECONDS, context=self.context) as response:
                # Сохраняем cookies до чтения тела, потому что они приходят в
                # заголовках ответа и нужны для второго запроса.
                self.capture_cookies(response.headers.get_all("Set-Cookie", []))
                charset = response.headers.get_content_charset("utf-8")
                return json.loads(response.read().decode(charset))
        except urllib.error.HTTPError as error:
            # HTTPError содержит тело ответа. Обрезаем его, чтобы не заливать в UI и
            # логи огромные HTML-страницы ошибок внешнего сайта.
            message = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"RZD HTTP {error.code}: {message[:300]}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"RZD network error: {error.reason}") from error

    def capture_cookies(self, set_cookie_headers: list[str]) -> None:
        # Set-Cookie выглядит как `JSESSIONID=abc; Path=/; HttpOnly`. Для повторной
        # отправки достаточно пары до первой точки с запятой.
        for header in set_cookie_headers:
            cookie = header.split(";", 1)[0]
            if "=" not in cookie:
                continue
            name, value = cookie.split("=", 1)
            self.cookies[name] = value


def parse_args() -> argparse.Namespace:
    # CLI-аргументы дублируются переменными окружения. Это удобно и локально
    # (`--port 8080`), и в cloud/container окружениях (`PORT=8080`).
    parser = argparse.ArgumentParser(description="Run the RZD Live Tracker web application.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", default=int(os.environ.get("PORT", "8000")), type=int)
    return parser.parse_args()


def main() -> None:
    # ThreadingHTTPServer обслуживает несколько параллельных запросов: например,
    # браузер может одновременно запросить HTML, CSS, JS, `/api/routes` и tiles
    # Leaflet. Для маленького приложения этого достаточно без отдельного ASGI/WSGI.
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), RzdTrackerHandler)
    print(f"RZD Live Tracker is running at http://{args.host}:{args.port}")
    print("Open http://localhost:%s in your browser." % args.port)
    # Блокирующий цикл сервера. Он завершится по Ctrl+C или сигналу остановки
    # процесса от окружения, в котором запущено приложение.
    server.serve_forever()


if __name__ == "__main__":
    # Стандартная Python-точка входа: позволяет импортировать функции из этого файла
    # в тестах, не запуская HTTP-сервер автоматически.
    main()
