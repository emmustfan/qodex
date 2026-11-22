import csv
import hashlib
import hmac
import io
import json
import os
import sqlite3
from base64 import b64decode
from contextlib import closing
from datetime import date
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import robot_budget

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("QODEX_DB", ROOT / "data" / "finance.sqlite3"))
USERS = json.loads(os.environ.get("QODEX_USERS", "{}"))
PROJECTS = ["Ро-бот", "Проект 2", "Проект 3", "Офис"]
ARTICLES = ["Лицензии", "Услуги", "Разработка", "Дизайн", "Инфраструктура", "Продажи", "Офисные расходы", "Налоги", "Финансирование", "Дивиденды", "ФОТ", "Поддержка", "Прямые расходы на клиентов"]
ENTITIES = ["ООО 1", "ООО 2"]
SCENARIOS = ["Базовый", "Консервативный", "Оптимистичный"]


def connect():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as db, db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY, entity INTEGER NOT NULL CHECK(entity IN (1,2)),
          name TEXT NOT NULL, UNIQUE(entity,name)
        );
        INSERT OR IGNORE INTO accounts VALUES(1,1,'Основной счёт');
        INSERT OR IGNORE INTO accounts VALUES(2,2,'Основной счёт');
        CREATE TABLE IF NOT EXISTS account_balances (
          account INTEGER PRIMARY KEY REFERENCES accounts(id), day TEXT NOT NULL, amount INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS statement_controls (
          account INTEGER NOT NULL REFERENCES accounts(id), month TEXT NOT NULL,
          opening INTEGER NOT NULL, incoming INTEGER NOT NULL CHECK(incoming>=0),
          outgoing INTEGER NOT NULL CHECK(outgoing>=0), closing INTEGER NOT NULL,
          PRIMARY KEY(account,month)
        );
        CREATE TABLE IF NOT EXISTS transfers (
          outgoing INTEGER PRIMARY KEY REFERENCES operations(id),
          incoming INTEGER NOT NULL UNIQUE REFERENCES operations(id)
        );
        CREATE TABLE IF NOT EXISTS operations (
          id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, day TEXT NOT NULL,
          description TEXT NOT NULL, amount INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS allocations (
          operation INTEGER NOT NULL REFERENCES operations(id), project TEXT NOT NULL,
          article TEXT NOT NULL, amount INTEGER NOT NULL, accrual TEXT
        );
        CREATE TABLE IF NOT EXISTS plans (
          id INTEGER PRIMARY KEY, month TEXT NOT NULL, project TEXT NOT NULL,
          article TEXT NOT NULL, amount INTEGER NOT NULL, basis TEXT NOT NULL, scenario TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS balances (
          project TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accruals (
          id INTEGER PRIMARY KEY, month TEXT NOT NULL, project TEXT NOT NULL,
          article TEXT NOT NULL, amount INTEGER NOT NULL, description TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
          id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
          day TEXT NOT NULL, project TEXT NOT NULL, article TEXT NOT NULL,
          amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'На согласовании'
        );
        CREATE TABLE IF NOT EXISTS budget_versions (
          id INTEGER PRIMARY KEY, month TEXT NOT NULL, basis TEXT NOT NULL,
          scenario TEXT NOT NULL, name TEXT NOT NULL, rows TEXT NOT NULL,
          author TEXT NOT NULL, UNIQUE(month,basis,scenario,name)
        );
        CREATE TABLE IF NOT EXISTS forecast_entries (
          id INTEGER PRIMARY KEY, entity INTEGER NOT NULL, day TEXT NOT NULL,
          description TEXT NOT NULL, amount INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS request_payments (
          operation INTEGER PRIMARY KEY REFERENCES operations(id),
          request INTEGER NOT NULL REFERENCES requests(id)
        );
        CREATE INDEX IF NOT EXISTS request_payments_request ON request_payments(request);
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
          target TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """)
        db.execute("BEGIN IMMEDIATE")
        for table, column, definition in (
            ("operations", "account", "INTEGER REFERENCES accounts(id)"),
            ("plans", "entity", "INTEGER"),
            ("plans", "source", "TEXT"),
            ("accruals", "entity", "INTEGER"),
            ("requests", "entity", "INTEGER"),
            ("requests", "payment_day", "TEXT"),
        ):
            if column not in {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        db.execute("UPDATE operations SET account=CASE WHEN ref IN ('demo-1','demo-2') THEN 2 ELSE 1 END "
                   "WHERE account IS NULL AND ref LIKE 'demo-%'")
        if os.environ.get("QODEX_SEED", "1") == "1" and not db.execute("SELECT 1 FROM operations LIMIT 1").fetchone():
            samples = [
                ("2026-06-02", "Лицензия · Север", 950000, 0, 0),
                ("2026-06-04", "Поддержка · Проект 2", 480000, 1, 1),
                ("2026-06-07", "Итерация · Проект 3", 420000, 2, 1),
                ("2026-06-11", "Лицензия · Маяк", 630000, 0, 0),
                ("2026-06-14", "Облачная инфраструктура", -78000, 0, 4),
                ("2026-06-17", "Аренда и сервисы", -174000, 3, 6),
                ("2026-06-20", "Команда разработки", -1120000, 0, 2),
                ("2026-06-22", "Выплата дизайнеру", -120000, None, 3),
                ("2026-06-24", "Подписка на сервис", -24000, None, 4),
            ]
            for i, (day, desc, amount, project, article) in enumerate(samples):
                oid = db.execute("INSERT INTO operations(ref,day,description,amount,account) VALUES(?,?,?,?,?)",
                                 (f"demo-{i}", day, desc, amount * 100, 2 if i in (1,2) else 1)).lastrowid
                if project is not None:
                    db.execute("INSERT INTO allocations VALUES(?,?,?,?,?)",
                               (oid, PROJECTS[project], ARTICLES[article], amount * 100, day[:7]))
            for idx, (income, expense) in enumerate([(1180, 940), (1440, 1130), (1580, 1270), (1980, 1420), (2150, 1480), (2500, 1530)], 1):
                period = f"2026-{idx:02d}"
                for basis in ("БДДС", "БДР"):
                    db.executemany("INSERT INTO plans(month,project,article,amount,basis,scenario,entity) VALUES(?,?,?,?,?,?,?)",
                                   [(period, PROJECTS[0], ARTICLES[0], income * 100000, basis, SCENARIOS[0], 1),
                                    (period, PROJECTS[0], ARTICLES[2], -expense * 100000, basis, SCENARIOS[0], 1)])
                if idx < 6:
                    for tag, amount, article in [("in", income - 70, 0), ("out", -expense + 45, 2)]:
                        oid = db.execute("INSERT INTO operations(ref,day,description,amount,account) VALUES(?,?,?,?,?)",
                                         (f"demo-{period}-{tag}", period + "-15", ARTICLES[article], amount * 100000, 1)).lastrowid
                        db.execute("INSERT INTO allocations VALUES(?,?,?,?,?)", (oid, PROJECTS[0], ARTICLES[article], amount * 100000, period))
            db.executemany("INSERT INTO requests(title,author,day,project,article,amount,entity) VALUES(?,?,?,?,?,?,?)",
                           [("Дизайн личного кабинета", "Команда продукта", "2026-06-27", PROJECTS[0], ARTICLES[3], 8500000, 1),
                            ("Облачные ресурсы на июнь", "Техлид", "2026-06-29", PROJECTS[1], ARTICLES[4], 4200000, 2)])


def money(value, allow_zero=False):
    amount = Decimal(str(value).replace("\xa0", "").replace(" ", "").replace(",", ".")) * 100
    if not amount.is_finite() or amount != amount.to_integral_value() or abs(amount) > 10**13 or (not amount and not allow_zero):
        raise ValueError("Укажите ненулевую сумму с точностью до копейки.")
    return int(amount)


def day(value):
    return date.fromisoformat(value).isoformat()


def month(value):
    return day(value + "-01")[:7]


def dimensions(row):
    if row["project"] not in PROJECTS or row["article"] not in ARTICLES:
        raise ValueError("Выберите проект и статью из списка.")
    return row["project"], row["article"]


def entity_id(payload):
    entity = int(payload["entity"])
    if entity not in (1, 2):
        raise ValueError("Выберите ООО.")
    return entity


def account_id(db, value):
    account = int(value)
    if not db.execute("SELECT 1 FROM accounts WHERE id=?", (account,)).fetchone():
        raise ValueError("Выберите банковский счёт.")
    return account


def import_statement(db, source, account):
    sample = source.lstrip("\ufeff")
    delimiter = ";" if ";" in sample.split("\n", 1)[0] else ","
    reader = csv.DictReader(io.StringIO(sample), delimiter=delimiter)
    if not {"date", "description", "amount"}.issubset(reader.fieldnames or []):
        raise ValueError("В CSV нужны колонки date, description и amount. Скачайте шаблон.")
    count = duplicates = 0
    for n, row in enumerate(reader, 2):
        try:
            when, description, amount = day(row["date"]), row["description"].strip(), money(row["amount"])
            if not description:
                raise ValueError()
        except (ValueError, InvalidOperation, AttributeError, TypeError) as exc:
            raise ValueError(f"Проверьте дату, описание и сумму в строке {n}.") from exc
        external_id = (row.get("id") or "").strip()
        key = [external_id] if external_id else [when, description, amount]
        ref = "bank:" + hashlib.sha256(json.dumps([account, *key], ensure_ascii=False).encode()).hexdigest()
        legacy_ref = "bank:" + hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
        existing = db.execute("SELECT day,description,amount FROM operations WHERE account=? AND ref IN (?,?)",
                              (account, ref, legacy_ref)).fetchone()
        if existing:
            if tuple(existing) != (when, description, amount):
                raise ValueError(f"В строке {n} повторяется ID с другими реквизитами.")
            duplicates += 1
            continue
        db.execute("INSERT INTO operations(ref,day,description,amount,account) VALUES(?,?,?,?,?)", (ref, when, description, amount, account))
        count += 1
    if not count and not duplicates:
        raise ValueError("В выписке нет операций.")
    return {"imported": count, "duplicates": duplicates}


def request_rows(db, author=None):
    condition, params = ("", ()) if author is None else ("WHERE r.author=?", (author,))
    return [dict(row) for row in db.execute(f"""
        SELECT r.*, COALESCE(SUM(-o.amount),0) AS paid
          FROM requests r LEFT JOIN request_payments p ON p.request=r.id
          LEFT JOIN operations o ON o.id=p.operation
        {condition} GROUP BY r.id
    """, params)]


def link_payment(db, request, operation):
    item = db.execute("SELECT * FROM requests WHERE id=?", (request,)).fetchone()
    if not item or item["status"] != "Согласована":
        raise ValueError("Выберите согласованную заявку.")
    old = db.execute("SELECT request FROM request_payments WHERE operation=?", (operation,)).fetchone()
    if old:
        if old["request"] == request:
            return False
        raise ValueError("Операция уже связана с другой заявкой.")
    op = db.execute("""
        SELECT o.amount, a.entity FROM operations o JOIN accounts a ON a.id=o.account
        WHERE o.id=? AND o.amount<0
    """, (operation,)).fetchone()
    if not op or op["entity"] != item["entity"]:
        raise ValueError("Выберите банковское списание со счёта ООО-плательщика.")
    if db.execute("SELECT 1 FROM transfers WHERE outgoing=?", (operation,)).fetchone():
        raise ValueError("Внутренний перевод нельзя связать с заявкой.")
    paid = db.execute("""
        SELECT COALESCE(SUM(-o.amount),0) FROM request_payments p
        JOIN operations o ON o.id=p.operation WHERE p.request=?
    """, (request,)).fetchone()[0]
    if -op["amount"] > item["amount"] - paid:
        raise ValueError("Списание превышает неоплаченный остаток заявки.")
    dimensions = (item["project"], item["article"])
    lines = db.execute("SELECT project,article FROM allocations WHERE operation=?", (operation,)).fetchall()
    if any(tuple(line) != dimensions for line in lines):
        raise ValueError("Проект и статья каждой доли операции должны совпадать с заявкой.")
    if not lines:
        db.execute("INSERT INTO allocations VALUES(?,?,?,?,NULL)", (operation, *dimensions, op["amount"]))
    db.execute("INSERT INTO request_payments VALUES(?,?)", (operation, request))
    return True


def freeze_budget(db, payload, actor):
    period, basis, scenario = month(payload["month"]), payload["basis"], payload["scenario"]
    name = payload["name"].strip()
    if basis not in ("БДДС", "БДР") or scenario not in SCENARIOS or not name or len(name) > 80:
        raise ValueError("Укажите тип, сценарий и название версии до 80 символов.")
    rows = [dict(row) for row in db.execute("""
        SELECT month,project,article,amount,entity FROM plans WHERE month=? AND basis=? AND scenario=?
    """, (period, basis, scenario))]
    if basis == "БДДС" and scenario == SCENARIOS[0]:
        rows.extend(dict(row) for row in db.execute("""
            SELECT substr(day,1,7) AS month, project,article,-amount AS amount,entity
            FROM requests WHERE status='Согласована' AND substr(day,1,7)=?
        """, (period,)))
    if not rows:
        raise ValueError("Добавьте строки плана за выбранный месяц.")
    try:
        return db.execute("INSERT INTO budget_versions(month,basis,scenario,name,rows,author) VALUES(?,?,?,?,?,?)",
                          (period, basis, scenario, name, json.dumps(rows, ensure_ascii=False), actor)).lastrowid
    except sqlite3.IntegrityError as exc:
        raise ValueError("Версия с таким названием уже существует для этого месяца и сценария.") from exc


def workbook_budget(db, payload, save):
    entity = entity_id(payload)
    raw = b64decode(payload["workbook"], validate=True)
    if len(raw) > 1_000_000:
        raise ValueError("Допустимый размер XLSX — до 1 МБ.")
    include_financing = payload.get("includeFinancing") is True
    rows = robot_budget.parse_workbook(raw, include_financing)
    if not rows:
        raise ValueError("В сценариях нет ни одной ненулевой строки.")
    preview = {(scenario, period): {"scenario": scenario, "month": period, "incoming": 0, "operating": 0, "financing": 0}
               for scenario in robot_budget.SCENARIO_SHEETS for period in robot_budget.PERIODS}
    for period, article, amount, scenario in rows:
        totals = preview[scenario, period]
        column = "financing" if article in ("Финансирование", "Дивиденды") else "incoming" if article == "Лицензии" else "operating"
        totals[column] += amount
    manual = db.execute("""
        SELECT COUNT(*) FROM plans WHERE entity=? AND project=? AND basis='БДДС' AND source IS NULL AND month BETWEEN ? AND ?
    """, (entity, PROJECTS[0], robot_budget.PERIODS[0], robot_budget.PERIODS[-1])).fetchone()[0]
    if save:
        db.execute("DELETE FROM plans WHERE source=? AND entity=? AND project=? AND basis='БДДС'",
                   (robot_budget.SOURCE, entity, PROJECTS[0]))
        db.executemany("""
            INSERT INTO plans(month,project,article,amount,basis,scenario,entity,source) VALUES(?,?,?,?,'БДДС',?,?,?)
        """, [(period, PROJECTS[0], article, amount, scenario, entity, robot_budget.SOURCE)
              for period, article, amount, scenario in rows])
    return {"rows":len(rows), "manual":manual, "months":list(preview.values())}


def mutate(db, action, payload, actor, role):
    if role != "finance" and action != "request":
        raise PermissionError("Действие доступно финансисту.")
    target = ""
    result = {}
    if action == "preview-workbook":
        return workbook_budget(db, payload, save=False)
    if action == "import-workbook":
        result = workbook_budget(db, payload, save=True)
        target = str(payload["entity"])
    elif action == "account":
        name = payload["name"].strip()
        if not name or len(name) > 80:
            raise ValueError("Укажите название счёта до 80 символов.")
        try:
            target = str(db.execute("INSERT INTO accounts(entity,name) VALUES(?,?)", (entity_id(payload), name)).lastrowid)
        except sqlite3.IntegrityError as exc:
            raise ValueError("У этого ООО уже есть счёт с таким названием.") from exc
    elif action == "account-balance":
        target = str(account_id(db, payload["account"]))
        db.execute("INSERT INTO account_balances VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET day=excluded.day,amount=excluded.amount",
                   (target, day(payload["day"]), money(payload["amount"], allow_zero=True)))
    elif action == "statement-control":
        account = account_id(db, payload["account"])
        period = month(payload["month"])
        opening, incoming, outgoing, closing = (
            money(payload[key], allow_zero=True) for key in ("opening", "incoming", "outgoing", "closing")
        )
        if incoming < 0 or outgoing < 0 or opening + incoming - outgoing != closing:
            raise ValueError("Сверьте итоги выписки. Входящий остаток плюс поступления минус выплаты должен равняться исходящему остатку.")
        db.execute("""
            INSERT INTO statement_controls VALUES(?,?,?,?,?,?)
            ON CONFLICT(account,month) DO UPDATE SET opening=excluded.opening,
              incoming=excluded.incoming,outgoing=excluded.outgoing,closing=excluded.closing
        """, (account, period, opening, incoming, outgoing, closing))
        target = f"{account}:{period}"
    elif action == "assign-account":
        oid = int(payload["id"])
        account = account_id(db, payload["account"])
        if db.execute("UPDATE operations SET account=? WHERE id=? AND account IS NULL", (account, oid)).rowcount != 1:
            raise ValueError("Операция уже привязана к счёту или не найдена.")
        target = str(oid)
    elif action == "transfer":
        outgoing, incoming = int(payload["outgoing"]), int(payload["incoming"])
        out = db.execute("SELECT account,amount FROM operations WHERE id=?", (outgoing,)).fetchone()
        inc = db.execute("SELECT account,amount FROM operations WHERE id=?", (incoming,)).fetchone()
        if not out or not inc or not out["account"] or not inc["account"] or out["account"] == inc["account"] or out["amount"] >= 0 or out["amount"] != -inc["amount"]:
            raise ValueError("Нужны списание и поступление одинаковой суммы на разных счетах.")
        if db.execute("SELECT 1 FROM allocations WHERE operation IN (?,?)", (outgoing,incoming)).fetchone():
            raise ValueError("Для связи выберите операции без распределения.")
        try:
            db.execute("INSERT INTO transfers VALUES(?,?)", (outgoing, incoming))
        except sqlite3.IntegrityError as exc:
            raise ValueError("Одна из операций уже связана с переводом.") from exc
        target = f"{outgoing}:{incoming}"
    elif action == "unlink-transfer":
        oid = int(payload["id"])
        if db.execute("DELETE FROM transfers WHERE outgoing=? OR incoming=?", (oid, oid)).rowcount != 1:
            raise ValueError("Связь не найдена.")
        target = str(oid)
    elif action == "import":
        result = import_statement(db, payload["csv"], account_id(db, payload["account"]))
        target = str(result["imported"])
    elif action == "allocate":
        oid = int(payload["id"])
        if db.execute("SELECT 1 FROM transfers WHERE outgoing=? OR incoming=?", (oid, oid)).fetchone():
            raise ValueError("Сначала разорвите связь внутреннего перевода.")
        op = db.execute("SELECT amount FROM operations WHERE id=?", (oid,)).fetchone()
        if not op:
            raise ValueError("Операция не найдена.")
        rows = [(oid, *dimensions(row), money(row["amount"]), month(row["accrual"]) if row.get("accrual") else None) for row in payload["lines"]]
        if not rows or sum(row[3] for row in rows) != op["amount"] or any(row[3] * op["amount"] <= 0 for row in rows):
            raise ValueError("Сумма строк и знак должны совпадать с суммой операции.")
        linked = db.execute("""
            SELECT r.project,r.article FROM request_payments p JOIN requests r ON r.id=p.request
            WHERE p.operation=?
        """, (oid,)).fetchone()
        if linked and any(row[1:3] != tuple(linked) for row in rows):
            raise ValueError("Проект и статья операции должны совпадать со связанной заявкой.")
        db.execute("DELETE FROM allocations WHERE operation=?", (oid,))
        db.executemany("INSERT INTO allocations VALUES(?,?,?,?,?)", rows)
        target = str(oid)
    elif action == "balance":
        target = payload["project"]
        if target not in ["", *PROJECTS]:
            raise ValueError("Выберите проект из списка.")
        db.execute("INSERT INTO balances VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET day=excluded.day,amount=excluded.amount",
                   (target, day(payload["day"]), money(payload["amount"], allow_zero=True)))
    elif action == "accrual":
        description = payload["description"].strip()
        if not description or payload["article"] in ("Финансирование", "Дивиденды"):
            raise ValueError("Укажите содержание начисления и операционную статью.")
        target = str(db.execute("INSERT INTO accruals(month,project,article,amount,description,entity) VALUES(?,?,?,?,?,?)",
                                (month(payload["month"]), *dimensions(payload), money(payload["amount"]), description, entity_id(payload))).lastrowid)
    elif action == "plan":
        if payload["basis"] not in ("БДР", "БДДС") or payload["scenario"] not in SCENARIOS:
            raise ValueError("Проверьте тип бюджета и сценарий.")
        if payload["basis"] == "БДР" and payload["article"] in ("Финансирование", "Дивиденды"):
            raise ValueError("Финансирование и дивиденды включаются в БДДС.")
        target = str(db.execute("INSERT INTO plans(month,project,article,amount,basis,scenario,entity) VALUES(?,?,?,?,?,?,?)",
                                (month(payload["month"]), *dimensions(payload), money(payload["amount"]), payload["basis"], payload["scenario"], entity_id(payload))).lastrowid)
    elif action == "request":
        title = payload["title"].strip()
        amount = money(payload["amount"])
        if not title or len(title) > 200 or amount <= 0 or payload["article"] in ("Лицензии", "Услуги"):
            raise ValueError("Укажите назначение, статью расхода и положительную сумму.")
        target = str(db.execute("INSERT INTO requests(title,author,day,project,article,amount,entity) VALUES(?,?,?,?,?,?,?)",
                                (title, actor, day(payload["day"]), *dimensions(payload), amount, entity_id(payload))).lastrowid)
    elif action == "freeze-budget":
        result["version"] = freeze_budget(db, payload, actor)
        target = str(result["version"])
    elif action == "forecast":
        description = payload["description"].strip()
        if not description or len(description) > 200:
            raise ValueError("Укажите назначение до 200 символов.")
        target = str(db.execute("INSERT INTO forecast_entries(entity,day,description,amount) VALUES(?,?,?,?)",
                                (entity_id(payload), day(payload["day"]), description, money(payload["amount"]))).lastrowid)
    elif action == "remove-forecast":
        target = str(int(payload["id"]))
        if db.execute("DELETE FROM forecast_entries WHERE id=?", (target,)).rowcount != 1:
            raise ValueError("Прогнозная строка не найдена.")
    elif action == "link-payment":
        request, operation = int(payload["request"]), int(payload["operation"])
        if not link_payment(db, request, operation):
            return result
        target = f"{request}:{operation}"
    elif action == "unlink-payment":
        operation = int(payload["operation"])
        row = db.execute("DELETE FROM request_payments WHERE operation=? RETURNING request", (operation,)).fetchone()
        if not row:
            raise ValueError("Связь оплаты не найдена.")
        target = f'{row["request"]}:{operation}'
    elif action == "reschedule":
        target = str(int(payload["id"]))
        changed = db.execute("""
            UPDATE requests SET payment_day=? WHERE id=? AND status='Согласована'
            AND amount > (SELECT COALESCE(SUM(-o.amount),0) FROM request_payments p
                          JOIN operations o ON o.id=p.operation WHERE p.request=requests.id)
        """, (day(payload["day"]), target)).rowcount
        if changed != 1:
            raise ValueError("Перенести можно неоплаченный остаток согласованной заявки.")
    elif action == "review":
        if payload["status"] not in ("Согласована", "Отклонена"):
            raise ValueError("Неизвестное решение.")
        target = str(int(payload["id"]))
        if USERS and db.execute("SELECT 1 FROM requests WHERE id=? AND author=?", (target, actor)).fetchone():
            raise PermissionError("Заявку согласует другой финансист.")
        if db.execute("UPDATE requests SET status=? WHERE id=? AND status='На согласовании'", (payload["status"], target)).rowcount != 1:
            raise ValueError("Заявка уже обработана или не найдена.")
    else:
        raise ValueError("Неизвестное действие.")
    db.execute("INSERT INTO audit(actor,action,target) VALUES(?,?,?)", (actor, action, target))
    return result


class Handler(BaseHTTPRequestHandler):
    def identity(self):
        if not USERS:
            return "Демо-пользователь", "finance"
        try:
            scheme, token = self.headers.get("Authorization", "").split(" ", 1)
            name, password = b64decode(token, validate=True).decode().split(":", 1)
            if scheme == "Basic" and name in USERS and hmac.compare_digest(password.encode(), USERS[name]["password"].encode()):
                return name, USERS[name]["role"]
        except (ValueError, UnicodeError):
            pass
        return None

    def send_data(self, code, data, mime="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        if code == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="Qodex", charset="UTF-8"')
        self.end_headers()
        self.wfile.write(data)

    def reply(self, code, obj):
        self.send_data(code, json.dumps(obj, ensure_ascii=False).encode())

    def do_GET(self):
        identity = self.identity()
        if identity is None:
            return self.reply(401, {"error": "Требуется вход."})
        path = urlsplit(self.path).path
        if path == "/api/state":
            name, role = identity
            with closing(connect()) as db:
                db.execute("BEGIN")
                data = {table: [dict(row) for row in db.execute(f"SELECT * FROM {table}")]
                        for table in ("operations", "allocations", "plans", "accruals", "balances", "accounts", "account_balances", "statement_controls", "transfers", "request_payments", "forecast_entries") if role == "finance"}
                if role == "finance":
                    data["budget_versions"] = [
                        {**dict(row), "rows": json.loads(row["rows"])}
                        for row in db.execute("SELECT * FROM budget_versions ORDER BY id DESC")
                    ]
                data["requests"] = request_rows(db, None if role == "finance" else name)
                data.update(entities=ENTITIES, projects=PROJECTS, articles=ARTICLES, scenarios=SCENARIOS, user=name, role=role, demo=not USERS)
                return self.reply(200, data)
        assets = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"), "/app.js": ("app.js", "text/javascript")}
        if path in assets:
            filename, mime = assets[path]
            return self.send_data(200, (ROOT / "web" / filename).read_bytes(), mime + "; charset=utf-8")
        self.reply(404, {"error": "Страница не найдена."})

    def do_POST(self):
        identity = self.identity()
        if identity is None:
            return self.reply(401, {"error": "Требуется вход."})
        if not self.path.startswith("/api/") or self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "Ожидается JSON-запрос."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 2_000_000:
                return self.reply(413, {"error": "Допустимый размер запроса — до 2 МБ."})
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Ожидается объект JSON.")
            with closing(connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                result = mutate(db, self.path[5:], payload, *identity)
            self.reply(200, result)
        except PermissionError as exc:
            self.reply(403, {"error": str(exc)})
        except (ValueError, KeyError, TypeError, AttributeError, InvalidOperation, OverflowError, csv.Error) as exc:
            self.reply(400, {"error": str(exc) if isinstance(exc, ValueError) else "Проверьте поля формы."})


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "::1", "localhost") and not USERS:
        raise SystemExit("Для сетевого режима задайте QODEX_USERS.")
    if any(user.get("role") not in ("finance", "employee") or not user.get("password") for user in USERS.values()):
        raise SystemExit("Укажите роль finance или employee и пароль каждого пользователя.")
    init()
    ThreadingHTTPServer((host, int(os.environ.get("PORT", "8000"))), Handler).serve_forever()
