"""Vercel WSGI entry point. Neon persists the existing SQLite workspace."""

from email.message import Message
from http import HTTPStatus
import logging
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs

import psycopg
from psycopg.conninfo import conninfo_to_dict

import app as qodex

WORKSPACE_LOCK = 0x514F444558
ROUTE_PARAM = "_qodex_path"
logger = logging.getLogger(__name__)


class ConfigurationError(ValueError):
    pass


def bootstrap_owner():
    login = os.environ.get("QODEX_OWNER_LOGIN", "owner")
    password = os.environ.get("QODEX_OWNER_PASSWORD", "")
    if not qodex.user_accounts.valid_login(login):
        raise ConfigurationError("Проверьте QODEX_OWNER_LOGIN в настройках Vercel.")
    if not 12 <= len(password) <= 250:
        raise ConfigurationError("Задайте QODEX_OWNER_PASSWORD длиной от 12 до 250 символов в настройках Vercel.")
    return {login: {"role": "owner", "password": password}}


def state_snapshot(pg, write):
    pg.execute("SELECT set_config('lock_timeout', '8s', true)")
    locked = False
    if write or pg.execute("SELECT to_regclass('public.qodex_workspace')").fetchone()[0] is None:
        pg.execute("SELECT pg_advisory_xact_lock(%s)", (WORKSPACE_LOCK,))
        locked = True
        if pg.execute("SELECT to_regclass('public.qodex_workspace')").fetchone()[0] is None:
            pg.execute("""
                CREATE TABLE public.qodex_workspace (
                    id smallint PRIMARY KEY CHECK (id=1),
                    snapshot bytea NOT NULL,
                    updated_at timestamptz NOT NULL DEFAULT now()
                )
            """)
    row = pg.execute("SELECT snapshot FROM public.qodex_workspace WHERE id=1").fetchone()
    if row is None and not locked:
        pg.execute("SELECT pg_advisory_xact_lock(%s)", (WORKSPACE_LOCK,))
        row = pg.execute("SELECT snapshot FROM public.qodex_workspace WHERE id=1").fetchone()
    return bytes(row[0]) if row is not None else None


def initialize_snapshot(path, saved):
    if saved is not None:
        path.write_bytes(saved)
    else:
        path.unlink(missing_ok=True)
    return qodex.init(seed=False, bootstrap=bootstrap_owner() if saved is None else {})


def run_with_database(request, action, write):
    url = (
        os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
        or os.environ.get("QODEXTECH_DATABASE_URL") or os.environ.get("QODEXTECH_POSTGRES_URL")
    )
    if not url:
        raise ConfigurationError("Подключите постоянную базу Neon к проекту Vercel.")
    sslmode = conninfo_to_dict(url).get("sslmode", "require")
    if os.environ.get("VERCEL") and sslmode not in ("require", "verify-ca", "verify-full"):
        raise ConfigurationError("Используйте строку подключения к Neon с TLS.")
    with psycopg.connect(url, sslmode=sslmode, connect_timeout=5, prepare_threshold=None) as pg:
        saved = state_snapshot(pg, write)
        with TemporaryDirectory(prefix="qodex-") as directory:
            path = Path(directory) / "workspace.sqlite3"
            token = qodex.request_database.set(path)
            try:
                migrated = initialize_snapshot(path, saved)
                if migrated and saved is not None and not write:
                    # A read can discover the one-time migration while another worker is writing.
                    latest = state_snapshot(pg, True)
                    if latest != saved:
                        saved = latest
                        migrated = initialize_snapshot(path, saved)
                action()
                # Return the buffered HTTP response only after Postgres commits.
                if migrated or saved is None or (write and 200 <= request.response[0] < 300):
                    snapshot = path.read_bytes()
                    if snapshot != saved:
                        pg.execute("""
                            INSERT INTO public.qodex_workspace (id,snapshot) VALUES (1,%s)
                            ON CONFLICT (id) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=now()
                        """, (snapshot,))
            finally:
                qodex.request_database.reset(token)


class Request(qodex.Handler):
    # The serverless endpoint uses its persistent user database for all authentication.
    allow_demo = False
    proxy_token = ""

    def __init__(self, environ):
        self.headers = Message()
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                self.headers[key[5:].replace("_", "-")] = value
        for key in ("CONTENT_LENGTH", "CONTENT_TYPE"):
            if environ.get(key):
                self.headers[key.replace("_", "-")] = environ[key]
        self.rfile = environ["wsgi.input"]
        path = environ.get("PATH_INFO") or "/"
        if path in ("/api/index", "/api/index.py"):
            path = parse_qs(environ.get("QUERY_STRING", "")).get(ROUTE_PARAM, ["/"])[0]
        self.path = "/" + path.lstrip("/")

    def send_data(self, code, data, mime="application/json; charset=utf-8", filename=None):
        self.response = code, data, mime, filename


def app(environ, start_response):
    request = Request(environ)
    method = environ["REQUEST_METHOD"]
    try:
        if method not in ("GET", "HEAD", "POST"):
            request.reply(405, {"error": "Метод не поддерживается."})
        elif method in ("GET", "HEAD") and request.path in qodex.ASSETS and request.path != "/":
            request.send_data(200, *qodex.read_asset(request.path))
        elif not request.headers.get("Authorization"):
            request.reply(401, {"error": "Требуется вход."})
        else:
            write = method == "POST" and request.path != "/api/export-report"
            run_with_database(request, request.do_POST if method == "POST" else request.do_GET, write)
    except ConfigurationError as error:
        request.reply(503, {"error": str(error)})
    except (psycopg.Error, sqlite3.Error, OSError, ValueError) as error:
        logger.error("Qodex workspace unavailable (%s)", type(error).__name__)
        request.reply(503, {"error": "База временно недоступна. Повторите запрос."})
    code, body, mime, filename = request.response
    start_response(f"{code} {HTTPStatus(code).phrase}", qodex.response_headers(code, body, mime, filename))
    return [b"" if method == "HEAD" else body]
