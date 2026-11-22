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

import bank_statement
import pnl_template

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("QODEX_DB", ROOT / "data" / "finance.sqlite3"))
USERS = json.loads(os.environ.get("QODEX_USERS", "{}"))
SEED_PROJECTS = ["Ро-бот", "Проект 2", "Проект 3", "Офис"]
SEED_ARTICLES = ["Лицензии", "Услуги", "Разработка", "Дизайн", "Инфраструктура", "Продажи", "Офисные расходы", "Налоги", "Финансирование", "Дивиденды", "ФОТ", "Поддержка", "Прямые расходы на клиентов", "Банковские комиссии"]
CASH_STAGES = ("Аванс от клиента", "Промежуточный платёж", "Окончательный расчёт")
NON_OPERATING = ("Финансирование", "Дивиденды")
DEFAULT_ARTICLES = {
    **dict.fromkeys(SEED_ARTICLES, "expense"),
    **dict.fromkeys(("Лицензии", "Услуги", "Выручка по проекту", *CASH_STAGES, "Прочие поступления"), "income"),
    "Услуги поставщиков": "expense",
    "Финансирование": "both",
}
ENTITIES = ["ООО 1", "ООО 2"]
SCENARIOS = ["Базовый", "Консервативный", "Оптимистичный"]


def pnl_articles(directions):
    return {name: direction for name, direction in directions.items() if name not in (*NON_OPERATING, *CASH_STAGES)}


def connect():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as db, db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS articles (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          direction TEXT NOT NULL CHECK(direction IN ('income','expense','both'))
        );
        CREATE TABLE IF NOT EXISTS pnl_template (
          id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clients (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS client_payers (
          party_key TEXT PRIMARY KEY, client INTEGER NOT NULL REFERENCES clients(id),
          payer TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY, entity INTEGER NOT NULL CHECK(entity IN (1,2)),
          name TEXT NOT NULL, UNIQUE(entity,name)
        );
        INSERT OR IGNORE INTO accounts(id,entity,name) VALUES(1,1,'Основной счёт');
        INSERT OR IGNORE INTO accounts(id,entity,name) VALUES(2,2,'Основной счёт');
        CREATE TABLE IF NOT EXISTS account_balances (
          account INTEGER PRIMARY KEY REFERENCES accounts(id), day TEXT NOT NULL, amount INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS statement_controls (
          account INTEGER NOT NULL REFERENCES accounts(id), month TEXT NOT NULL,
          opening INTEGER NOT NULL, incoming INTEGER NOT NULL CHECK(incoming>=0),
          outgoing INTEGER NOT NULL CHECK(outgoing>=0), closing INTEGER NOT NULL,
          PRIMARY KEY(account,month)
        );
        CREATE TABLE IF NOT EXISTS bank_statements (
          account INTEGER NOT NULL REFERENCES accounts(id), start TEXT NOT NULL, end TEXT NOT NULL,
          opening INTEGER NOT NULL, incoming INTEGER NOT NULL, outgoing INTEGER NOT NULL, closing INTEGER NOT NULL,
          PRIMARY KEY(account,start,end)
        );
        CREATE TABLE IF NOT EXISTS bank_rules (
          account INTEGER NOT NULL REFERENCES accounts(id), party_key TEXT NOT NULL,
          direction INTEGER NOT NULL, project TEXT NOT NULL, article TEXT NOT NULL,
          PRIMARY KEY(account,party_key,direction)
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
        CREATE TABLE IF NOT EXISTS funds (
          id INTEGER PRIMARY KEY, entity INTEGER NOT NULL CHECK(entity IN (1,2)),
          name TEXT NOT NULL COLLATE NOCASE, UNIQUE(entity,name)
        );
        CREATE TABLE IF NOT EXISTS profit_decisions (
          id INTEGER PRIMARY KEY, entity INTEGER NOT NULL CHECK(entity IN (1,2)),
          month TEXT NOT NULL, day TEXT NOT NULL, note TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK(amount>0), fund INTEGER REFERENCES funds(id),
          canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled IN (0,1)), actor TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profit_payments (
          operation INTEGER PRIMARY KEY REFERENCES operations(id),
          decision INTEGER NOT NULL REFERENCES profit_decisions(id)
        );
        CREATE INDEX IF NOT EXISTS profit_payments_decision ON profit_payments(decision);
        CREATE TABLE IF NOT EXISTS fund_entries (
          id INTEGER PRIMARY KEY, fund INTEGER NOT NULL REFERENCES funds(id),
          day TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount<>0), note TEXT NOT NULL,
          actor TEXT NOT NULL, decision INTEGER UNIQUE REFERENCES profit_decisions(id)
        );
        CREATE INDEX IF NOT EXISTS fund_entries_day ON fund_entries(fund,day);
        CREATE TABLE IF NOT EXISTS office_contributions (
          entity INTEGER NOT NULL CHECK(entity IN (1,2)), month TEXT NOT NULL,
          project TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0),
          PRIMARY KEY(entity,month,project)
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
            ("accounts", "bank_key", "TEXT"),
            ("operations", "account", "INTEGER REFERENCES accounts(id)"),
            ("operations", "counterparty", "TEXT"),
            ("operations", "party_key", "TEXT"),
            ("operations", "document_pending", "INTEGER NOT NULL DEFAULT 0"),
            ("operations", "payer_label", "TEXT"),
            ("operations", "client", "INTEGER REFERENCES clients(id)"),
            ("allocations", "accrual_article", "TEXT"),
            ("plans", "entity", "INTEGER"),
            ("plans", "source", "TEXT"),
            ("accruals", "entity", "INTEGER"),
            ("requests", "entity", "INTEGER"),
            ("requests", "payment_day", "TEXT"),
        ):
            if column not in {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        db.executemany("INSERT OR IGNORE INTO projects(name) VALUES(?)", [(name,) for name in SEED_PROJECTS])
        db.executemany("INSERT OR IGNORE INTO articles(name,direction) VALUES(?,?)", DEFAULT_ARTICLES.items())
        pnl_template.initialize(db, pnl_articles(DEFAULT_ARTICLES))
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS accounts_bank_key ON accounts(bank_key)")
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
                    db.execute("INSERT INTO allocations(operation,project,article,amount,accrual) VALUES(?,?,?,?,?)",
                               (oid, SEED_PROJECTS[project], SEED_ARTICLES[article], amount * 100, day[:7]))
            for idx, (income, expense) in enumerate([(1180, 940), (1440, 1130), (1580, 1270), (1980, 1420), (2150, 1480), (2500, 1530)], 1):
                period = f"2026-{idx:02d}"
                for basis in ("БДДС", "БДР"):
                    db.executemany("INSERT INTO plans(month,project,article,amount,basis,scenario,entity) VALUES(?,?,?,?,?,?,?)",
                                   [(period, SEED_PROJECTS[0], SEED_ARTICLES[0], income * 100000, basis, SCENARIOS[0], 1),
                                    (period, SEED_PROJECTS[0], SEED_ARTICLES[2], -expense * 100000, basis, SCENARIOS[0], 1)])
                if idx < 6:
                    for tag, amount, article in [("in", income - 70, 0), ("out", -expense + 45, 2)]:
                        oid = db.execute("INSERT INTO operations(ref,day,description,amount,account) VALUES(?,?,?,?,?)",
                                         (f"demo-{period}-{tag}", period + "-15", SEED_ARTICLES[article], amount * 100000, 1)).lastrowid
                        db.execute("INSERT INTO allocations(operation,project,article,amount,accrual) VALUES(?,?,?,?,?)", (oid, SEED_PROJECTS[0], SEED_ARTICLES[article], amount * 100000, period))
            db.executemany("INSERT INTO requests(title,author,day,project,article,amount,entity) VALUES(?,?,?,?,?,?,?)",
                           [("Дизайн личного кабинета", "Команда продукта", "2026-06-27", SEED_PROJECTS[0], SEED_ARTICLES[3], 8500000, 1),
                            ("Облачные ресурсы на июнь", "Техлид", "2026-06-29", SEED_PROJECTS[1], SEED_ARTICLES[4], 4200000, 2)])


def money(value, allow_zero=False):
    amount = Decimal(str(value).replace("\xa0", "").replace(" ", "").replace(",", ".")) * 100
    if not amount.is_finite() or amount != amount.to_integral_value() or abs(amount) > 10**13 or (not amount and not allow_zero):
        raise ValueError("Укажите ненулевую сумму с точностью до копейки.")
    return int(amount)


def day(value):
    return date.fromisoformat(value).isoformat()


def month(value):
    return day(value + "-01")[:7]


def ensure_project(db, project):
    if not db.execute("SELECT 1 FROM projects WHERE name=?", (project,)).fetchone():
        raise ValueError("Выберите проект из списка.")


def allow_article(direction, amount):
    return direction == "both" or direction == ("income" if amount > 0 else "expense")


def ensure_article(db, article, amount, accrual=False):
    row = db.execute("SELECT direction FROM articles WHERE name=?", (article,)).fetchone()
    if not row or not allow_article(row["direction"], amount):
        raise ValueError("Выберите статью для поступления." if amount > 0 else "Выберите статью для расхода.")
    if accrual and article in (*NON_OPERATING, *CASH_STAGES):
        raise ValueError("Для БДР выберите статью начисления, например «Выручка по проекту».")


def directory_name(db, table, raw, limit=100):
    name = raw.strip()
    if not name or len(name) > limit:
        raise ValueError(f"Укажите название до {limit} символов.")
    if any(row["name"].casefold() == name.casefold() for row in db.execute(f"SELECT name FROM {table}")):
        raise ValueError("Такое название уже есть в справочнике.")
    return name


def add_client(db, raw):
    name = directory_name(db, "clients", raw)
    return db.execute("INSERT INTO clients(name) VALUES(?)", (name,)).lastrowid


def assign_receipt_client(db, oid, op, payload):
    if op["amount"] <= 0 or "client" not in payload:
        return
    new_client = (payload.get("newClient") or "").strip()
    client = int(payload["client"]) if payload["client"] else None
    if new_client:
        if client is not None:
            raise ValueError("Выберите существующего клиента или создайте нового.")
        client = add_client(db, new_client)
    if client is not None and not db.execute("SELECT 1 FROM clients WHERE id=?", (client,)).fetchone():
        raise ValueError("Выберите клиента из справочника.")
    payer = (payload.get("payer") or "").strip()
    if len(payer) > 200:
        raise ValueError("Название плательщика должно быть до 200 символов.")
    if payload.get("rememberClient") is True:
        if not op["party_key"] or not client:
            raise ValueError("Для запоминания выберите клиента и банковского плательщика.")
        db.execute("""
            INSERT INTO client_payers(party_key,client,payer) VALUES(?,?,?)
            ON CONFLICT(party_key) DO UPDATE SET client=excluded.client,payer=excluded.payer
        """, (op["party_key"], client, op["counterparty"]))
    db.execute("UPDATE operations SET client=?, payer_label=? WHERE id=?", (client, payer or None, oid))


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
            counterparty = (row.get("counterparty") or "").strip()
            if not description or len(counterparty) > 200:
                raise ValueError()
        except (ValueError, InvalidOperation, AttributeError, TypeError) as exc:
            raise ValueError(f"Проверьте дату, описание и сумму в строке {n}.") from exc
        external_id = (row.get("id") or "").strip()
        key = [external_id] if external_id else [when, description, amount]
        ref = "bank:" + hashlib.sha256(json.dumps([account, *key], ensure_ascii=False).encode()).hexdigest()
        legacy_ref = "bank:" + hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
        existing = db.execute("SELECT id,day,description,amount,counterparty FROM operations WHERE account=? AND ref IN (?,?)",
                              (account, ref, legacy_ref)).fetchone()
        if existing:
            if (existing["day"], existing["description"], existing["amount"]) != (when, description, amount):
                raise ValueError(f"В строке {n} повторяется ID с другими реквизитами.")
            if counterparty and existing["counterparty"] and existing["counterparty"] != counterparty:
                raise ValueError(f"В строке {n} повторяется операция с другим плательщиком. Проверьте банковский ID.")
            if counterparty and not existing["counterparty"]:
                db.execute("UPDATE operations SET counterparty=? WHERE id=?", (counterparty, existing["id"]))
            duplicates += 1
            continue
        db.execute("INSERT INTO operations(ref,day,description,amount,account,counterparty) VALUES(?,?,?,?,?,?)",
                   (ref, when, description, amount, account, counterparty or None))
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


def payer_debit(db, operation, entity):
    op = db.execute("""
        SELECT o.amount, o.document_pending, a.entity FROM operations o JOIN accounts a ON a.id=o.account
        WHERE o.id=? AND o.amount<0
    """, (operation,)).fetchone()
    if not op or op["entity"] != entity:
        raise ValueError("Выберите банковское списание со счёта ООО-плательщика.")
    return op


def is_profit_payment(db, operation):
    return db.execute("SELECT 1 FROM profit_payments WHERE operation=?", (operation,)).fetchone() is not None


def link_payment(db, request, operation):
    item = db.execute("SELECT * FROM requests WHERE id=?", (request,)).fetchone()
    if not item or item["status"] != "Согласована":
        raise ValueError("Выберите согласованную заявку.")
    old = db.execute("SELECT request FROM request_payments WHERE operation=?", (operation,)).fetchone()
    if old:
        if old["request"] == request:
            return False
        raise ValueError("Операция уже связана с другой заявкой.")
    op = payer_debit(db, operation, item["entity"])
    if is_profit_payment(db, operation):
        raise ValueError("Списание уже связано с выплатой собственникам.")
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
        db.execute("INSERT INTO allocations(operation,project,article,amount,accrual) VALUES(?,?,?,?,NULL)", (operation, *dimensions, op["amount"]))
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


def bank_hash(parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


def find_statement_account(db, choice, statement):
    key = bank_hash([statement.number])
    known = db.execute("SELECT id,entity FROM accounts WHERE bank_key=?", (key,)).fetchone()
    if isinstance(choice, str) and choice.startswith("new:"):
        entity = entity_id({"entity": choice[4:]})
        if known and known["entity"] != entity:
            raise ValueError("Этот счёт Точки уже привязан к другому ООО.")
        return known["id"] if known else None, entity, key
    account = account_id(db, choice)
    registered = db.execute("SELECT entity,bank_key FROM accounts WHERE id=?", (account,)).fetchone()
    if (known and known["id"] != account) or (registered["bank_key"] and registered["bank_key"] != key):
        raise ValueError("Выбранный счёт уже связан с другой выпиской. Проверьте ООО и счёт.")
    return account, registered["entity"], key


def operation_hint(op, rule, directions):
    if not op["ref"].startswith("tochka:"):
        return None, None, None
    article, project, flag = bank_statement.hints(op["description"], op["amount"])
    if rule and flag != "transfer" and allow_article(directions.get(rule["article"]), op["amount"]):
        return article if article in CASH_STAGES else rule["article"], rule["project"], flag
    return article, project, flag


def import_tochka(db, payload, save):
    raw = b64decode(payload["workbook"], validate=True)
    if len(raw) > 1_000_000:
        raise ValueError("Допустимый размер XLSX — до 1 МБ. Разбейте выгрузку на периоды.")
    statement = bank_statement.parse(raw, money)
    account, entity, key = find_statement_account(db, payload["account"], statement)
    name = f"Точка · ••••{statement.number[-4:]}"
    existing = {row["ref"] for row in db.execute("SELECT ref FROM operations WHERE account=?", (account,))}
    rows = []
    for op in statement.operations:
        ref = "tochka:" + bank_hash([key, *op.key])
        if ref not in existing:
            party_key = bank_hash(op.counterparty_key) if op.counterparty else None
            rows.append((ref, op.day, op.description, op.amount, op.counterparty, party_key))
    other = sum(not ref.startswith("tochka:") for ref in existing)
    if save:
        if account is None:
            if db.execute("SELECT 1 FROM accounts WHERE entity=? AND name=?", (entity, name)).fetchone():
                name += f" · {key[:6]}"
            account = db.execute("INSERT INTO accounts(entity,name,bank_key) VALUES(?,?,?)",
                                 (entity, name, key)).lastrowid
        else:
            db.execute("UPDATE accounts SET bank_key=? WHERE id=?", (key, account))
        db.executemany("""
            INSERT INTO operations(ref,day,description,amount,counterparty,party_key,account) VALUES(?,?,?,?,?,?,?)
        """, [(*row, account) for row in rows])
        if not existing:
            db.execute("INSERT OR IGNORE INTO account_balances VALUES(?,?,?)",
                       (account, statement.start, statement.opening))
        db.execute("""
            INSERT INTO bank_statements VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(account,start,end) DO UPDATE SET opening=excluded.opening, incoming=excluded.incoming,
                outgoing=excluded.outgoing, closing=excluded.closing
        """, (account, statement.start, statement.end, statement.opening,
              statement.incoming, statement.outgoing, statement.closing))
    return {"account": account, "entity": entity, "accountTail": statement.number[-4:], "other": other,
            "start": statement.start, "end": statement.end, "opening": statement.opening,
            "incoming": statement.incoming, "outgoing": statement.outgoing, "closing": statement.closing,
            "new": len(rows), "duplicates": len(statement.operations) - len(rows)}


def read_operation_rows(db):
    rules = {(row["account"], row["party_key"], row["direction"]): row for row in db.execute("SELECT * FROM bank_rules")}
    clients = {row["party_key"]: row["client"] for row in db.execute("SELECT party_key,client FROM client_payers")}
    directions = {row["name"]: row["direction"] for row in db.execute("SELECT name,direction FROM articles")}
    operations = []
    for row in db.execute("SELECT * FROM operations"):
        op = dict(row)
        key = op.pop("party_key")
        rule = rules.get((op["account"], key, 1 if op["amount"] > 0 else -1))
        article, project, flag = operation_hint(op, rule, directions)
        operations.append({**op, "suggested_article": article, "suggested_project": project, "bank_hint": flag,
                           "suggested_client": clients.get(key) if op["amount"] > 0 else None,
                           "has_bank_payer": bool(key)})
    return operations


def apply_bank_suggestions(db, ids):
    if not isinstance(ids, list) or not ids or len(ids) > 2000:
        raise ValueError("Выберите до 2 000 операций с подсказками.")
    by_id = {op["id"]: op for op in read_operation_rows(db)}
    count = 0
    for oid in set(int(value) for value in ids):
        op = by_id.get(oid)
        if not op or not op["suggested_project"] or not op["suggested_article"] or op["bank_hint"] == "transfer":
            continue
        if is_profit_payment(db, oid):
            continue
        if db.execute("SELECT 1 FROM allocations WHERE operation=?", (oid,)).fetchone() or db.execute(
            "SELECT 1 FROM transfers WHERE outgoing=? OR incoming=?", (oid, oid)
        ).fetchone():
            continue
        db.execute("INSERT INTO allocations(operation,project,article,amount,accrual) VALUES(?,?,?,?,NULL)",
                   (oid, op["suggested_project"], op["suggested_article"], op["amount"]))
        if op["bank_hint"] == "advance":
            db.execute("UPDATE operations SET document_pending=1 WHERE id=?", (oid,))
        if op["suggested_client"] and op["client"] is None:
            db.execute("UPDATE operations SET client=? WHERE id=?", (op["suggested_client"], oid))
        count += 1
    return count


def fund_id(db, value, entity=None):
    fund = int(value)
    row = db.execute("SELECT entity FROM funds WHERE id=?", (fund,)).fetchone()
    if not row or (entity is not None and row["entity"] != entity):
        raise ValueError("Выберите фонд нужного ООО.")
    return fund


def positive_amount(value):
    amount = money(value)
    if amount <= 0:
        raise ValueError("Укажите положительную сумму.")
    return amount


def decision_note(value):
    note = value.strip()
    if not note or len(note) > 200:
        raise ValueError("Укажите основание длиной до 200 символов.")
    return note


def check_fund_balance(db, fund):
    balance = 0
    for row in db.execute("""
        SELECT e.day, SUM(e.amount) AS amount FROM fund_entries e
        LEFT JOIN profit_decisions d ON e.decision=d.id
        WHERE e.fund=? AND (d.id IS NULL OR d.canceled=0)
        GROUP BY e.day ORDER BY e.day
    """, (fund,)):
        balance += row["amount"]
        if balance < 0:
            raise ValueError(f'Операция даст отрицательный остаток фонда на {row["day"]}.')


def add_profit_decision(db, payload, actor):
    entity = entity_id(payload)
    fund = fund_id(db, payload["fund"], entity) if payload.get("fund") else None
    when, amount, note = day(payload["day"]), positive_amount(payload["amount"]), decision_note(payload["note"])
    decision = db.execute("""
        INSERT INTO profit_decisions(entity,month,day,note,amount,fund,actor) VALUES(?,?,?,?,?,?,?)
    """, (entity, month(payload["month"]), when, note, amount, fund, actor)).lastrowid
    if fund is not None:
        db.execute("INSERT INTO fund_entries(fund,day,amount,note,actor,decision) VALUES(?,?,?,?,?,?)",
                   (fund, when, amount, note, actor, decision))
    return decision


def profit_decision_rows(db, decision=None):
    where, params = ("", ()) if decision is None else ("WHERE d.id=?", (decision,))
    return [dict(row) for row in db.execute(f"""
        SELECT d.*, COALESCE(SUM(-o.amount),0) AS paid
        FROM profit_decisions d LEFT JOIN profit_payments p ON p.decision=d.id
        LEFT JOIN operations o ON o.id=p.operation
        {where} GROUP BY d.id
    """, params)]


def link_profit_payment(db, decision, operation):
    rows = profit_decision_rows(db, decision)
    if not rows or rows[0]["canceled"] or rows[0]["fund"] is not None:
        raise ValueError("Выберите действующее решение о выплате собственникам.")
    item = rows[0]
    old = db.execute("SELECT decision FROM profit_payments WHERE operation=?", (operation,)).fetchone()
    if old:
        if old["decision"] == decision:
            return False
        raise ValueError("Списание уже связано с другим решением.")
    op = payer_debit(db, operation, item["entity"])
    if db.execute("SELECT 1 FROM transfers WHERE outgoing=?", (operation,)).fetchone():
        raise ValueError("Списание связано с внутренним переводом.")
    if db.execute("SELECT 1 FROM request_payments WHERE operation=?", (operation,)).fetchone():
        raise ValueError("Списание уже связано с заявкой.")
    if op["document_pending"] or db.execute(
        "SELECT 1 FROM allocations WHERE operation=? AND article<>'Дивиденды'", (operation,)
    ).fetchone():
        raise ValueError("Сначала проверьте статус документа или измените статью списания на «Дивиденды».")
    if -op["amount"] > item["amount"] - item["paid"]:
        raise ValueError("Списание превышает остаток к выплате.")
    db.execute("INSERT INTO profit_payments VALUES(?,?)", (operation, decision))
    return True


def mutate(db, action, payload, actor, role):
    if role != "finance" and action != "request":
        raise PermissionError("Действие доступно финансисту.")
    target = ""
    result = {}
    if action == "preview-tochka":
        return import_tochka(db, payload, save=False)
    if action == "import-tochka":
        result = import_tochka(db, payload, save=True)
        target = f'{result["account"]}:{result["start"]}:{result["end"]}'
    elif action == "apply-bank-suggestions":
        result["applied"] = apply_bank_suggestions(db, payload["ids"])
        target = str(result["applied"])
    elif action == "pnl-template":
        directions = {row["name"]: row["direction"] for row in db.execute("SELECT name,direction FROM articles")}
        result["revision"] = pnl_template.save(db, payload, pnl_articles(directions))
        target = str(result["revision"])
    elif action == "project":
        name = directory_name(db, "projects", payload["name"])
        target = str(db.execute("INSERT INTO projects(name) VALUES(?)", (name,)).lastrowid)
    elif action == "article":
        name = directory_name(db, "articles", payload["name"])
        direction = payload["direction"]
        if direction not in ("income", "expense"):
            raise ValueError("Выберите поступление или расход.")
        if name.casefold() in ("без распределения", "между счетами", "между ооо"):
            raise ValueError("Это название используется в банковских отчётах.")
        target = str(db.execute("INSERT INTO articles(name,direction) VALUES(?,?)", (name, direction)).lastrowid)
    elif action == "client":
        target = str(add_client(db, payload["name"]))
    elif action == "fund":
        name = payload["name"].strip()
        if not name or len(name) > 80:
            raise ValueError("Укажите название фонда до 80 символов.")
        entity = entity_id(payload)
        names = db.execute("SELECT name FROM funds WHERE entity=?", (entity,))
        if any(row["name"].casefold() == name.casefold() for row in names):
            raise ValueError("У этого ООО уже есть фонд с таким названием.")
        target = str(db.execute("INSERT INTO funds(entity,name) VALUES(?,?)", (entity, name)).lastrowid)
    elif action == "fund-entry":
        fund = fund_id(db, payload["fund"])
        direction = payload["direction"]
        if direction not in ("reserve", "release"):
            raise ValueError("Выберите пополнение или высвобождение.")
        amount = positive_amount(payload["amount"]) * (-1 if direction == "release" else 1)
        target = str(db.execute("""
            INSERT INTO fund_entries(fund,day,amount,note,actor) VALUES(?,?,?,?,?)
        """, (fund, day(payload["day"]), amount, decision_note(payload["note"]), actor)).lastrowid)
        check_fund_balance(db, fund)
    elif action == "office-contribution":
        entity, period = entity_id(payload), month(payload["month"])
        project = payload["project"]
        ensure_project(db, project)
        if project == "Офис":
            raise ValueError("Выберите проект.")
        amount = money(payload["amount"], allow_zero=True)
        if amount < 0:
            raise ValueError("Вклад проекта в офис задаётся неотрицательной суммой.")
        db.execute("""
            INSERT INTO office_contributions VALUES(?,?,?,?) ON CONFLICT(entity,month,project)
            DO UPDATE SET amount=excluded.amount
        """, (entity, period, project, amount))
        target = f"{entity}:{period}:{project}"
    elif action == "profit-decision":
        target = str(add_profit_decision(db, payload, actor))
    elif action == "link-profit-payment":
        decision, operation = int(payload["decision"]), int(payload["operation"])
        if not link_profit_payment(db, decision, operation):
            return result
        target = f"{decision}:{operation}"
    elif action == "unlink-profit-payment":
        operation = int(payload["operation"])
        row = db.execute("DELETE FROM profit_payments WHERE operation=? RETURNING decision", (operation,)).fetchone()
        if not row:
            raise ValueError("Связь с выплатой не найдена.")
        target = f'{row["decision"]}:{operation}'
    elif action == "cancel-profit-decision":
        target = str(int(payload["id"]))
        if db.execute("SELECT 1 FROM profit_payments WHERE decision=?", (target,)).fetchone():
            raise ValueError("Перед отменой решения отвяжите банковские списания.")
        decision = db.execute("""
            UPDATE profit_decisions SET canceled=1 WHERE id=? AND canceled=0 RETURNING fund
        """, (target,)).fetchone()
        if not decision:
            raise ValueError("Действующее решение не найдено.")
        if decision["fund"] is not None:
            check_fund_balance(db, decision["fund"])
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
        if is_profit_payment(db, outgoing):
            raise ValueError("Списание уже связано с выплатой собственникам.")
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
        if is_profit_payment(db, oid):
            raise ValueError("Сначала отвяжите списание от решения о выплате.")
        if db.execute("SELECT 1 FROM transfers WHERE outgoing=? OR incoming=?", (oid, oid)).fetchone():
            raise ValueError("Сначала разорвите связь внутреннего перевода.")
        op = db.execute("SELECT amount,account,party_key,counterparty,document_pending FROM operations WHERE id=?", (oid,)).fetchone()
        if not op:
            raise ValueError("Операция не найдена.")
        previous = {row["article"] for row in db.execute("SELECT article FROM allocations WHERE operation=?", (oid,))}
        rows = []
        for row in payload["lines"]:
            project, article = row["project"], row["article"]
            amount = money(row["amount"])
            ensure_project(db, project)
            if article not in previous:
                ensure_article(db, article, op["amount"])
            accrual = month(row["accrual"]) if row.get("accrual") else None
            accrual_article = row.get("accrualArticle") or None
            if accrual and article in CASH_STAGES and not accrual_article:
                accrual_article = "Выручка по проекту"
            if accrual_article and accrual:
                ensure_article(db, accrual_article, amount, accrual=True)
            rows.append((oid, project, article, amount, accrual, accrual_article if accrual else None))

        if not rows or sum(row[3] for row in rows) != op["amount"] or any(row[3] * op["amount"] <= 0 for row in rows):
            raise ValueError("Сумма строк и знак должны совпадать с суммой операции.")
        linked = db.execute("""
            SELECT r.project,r.article FROM request_payments p JOIN requests r ON r.id=p.request
            WHERE p.operation=?
        """, (oid,)).fetchone()
        if linked and any(row[1:3] != tuple(linked) for row in rows):
            raise ValueError("Проект и статья операции должны совпадать со связанной заявкой.")
        pending = payload.get("documentPending", bool(op["document_pending"])) is True
        if pending and any(row[4] for row in rows):
            raise ValueError("Пока ждёте акт или другой документ, оставьте месяц БДР пустым.")
        if payload.get("remember") is True:
            if not op["party_key"] or len(rows) != 1:
                raise ValueError("Правило можно сохранить для платежа одного контрагента с одной статьёй и проектом.")
            db.execute("""
                INSERT INTO bank_rules VALUES(?,?,?,?,?)
                ON CONFLICT(account,party_key,direction) DO UPDATE SET project=excluded.project,article=excluded.article
            """, (op["account"], op["party_key"], 1 if op["amount"] > 0 else -1, rows[0][1], rows[0][2]))
        assign_receipt_client(db, oid, op, payload)
        db.execute("UPDATE operations SET document_pending=? WHERE id=?", (pending, oid))
        db.execute("DELETE FROM allocations WHERE operation=?", (oid,))
        db.executemany("INSERT INTO allocations(operation,project,article,amount,accrual,accrual_article) VALUES(?,?,?,?,?,?)", rows)
        target = str(oid)
    elif action == "balance":
        target = payload["project"]
        if target:
            ensure_project(db, target)
        db.execute("INSERT INTO balances VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET day=excluded.day,amount=excluded.amount",
                   (target, day(payload["day"]), money(payload["amount"], allow_zero=True)))
    elif action in ("accrual", "plan", "request"):
        project, article = payload["project"], payload["article"]
        ensure_project(db, project)
        amount = money(payload["amount"])
        if action == "accrual":
            ensure_article(db, article, amount, accrual=True)
            description = payload["description"].strip()
            if not description:
                raise ValueError("Укажите содержание начисления.")
            target = str(db.execute("""
                INSERT INTO accruals(month,project,article,amount,description,entity) VALUES(?,?,?,?,?,?)
            """, (month(payload["month"]), project, article, amount, description, entity_id(payload))).lastrowid)
        elif action == "plan":
            basis, scenario = payload["basis"], payload["scenario"]
            if basis not in ("БДР", "БДДС") or scenario not in SCENARIOS:
                raise ValueError("Проверьте тип бюджета и сценарий.")
            ensure_article(db, article, amount, accrual=basis == "БДР")
            target = str(db.execute("""
                INSERT INTO plans(month,project,article,amount,basis,scenario,entity) VALUES(?,?,?,?,?,?,?)
            """, (month(payload["month"]), project, article, amount, basis, scenario, entity_id(payload))).lastrowid)
        else:
            ensure_article(db, article, -1)
            title = payload["title"].strip()
            if not title or len(title) > 200 or amount <= 0:
                raise ValueError("Укажите назначение, статью расхода и положительную сумму.")
            target = str(db.execute("""
                INSERT INTO requests(title,author,day,project,article,amount,entity) VALUES(?,?,?,?,?,?,?)
            """, (title, actor, day(payload["day"]), project, article, amount, entity_id(payload))).lastrowid)
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
                        for table in ("allocations", "plans", "accruals", "balances", "accounts", "account_balances", "statement_controls", "bank_statements", "transfers", "request_payments", "forecast_entries",
                                      "funds", "fund_entries", "profit_payments", "office_contributions", "clients") if role == "finance"}
                if role == "finance":
                    data["operations"] = read_operation_rows(db)
                    data["client_payers"] = [dict(row) for row in db.execute("SELECT DISTINCT client,payer FROM client_payers")]
                    data["profit_decisions"] = profit_decision_rows(db)
                    data["pnlTemplate"] = pnl_template.read(db)
                    data["budget_versions"] = [
                        {**dict(row), "rows": json.loads(row["rows"])}
                        for row in db.execute("SELECT * FROM budget_versions ORDER BY id DESC")
                    ]
                data["requests"] = request_rows(db, None if role == "finance" else name)
                projects = [row["name"] for row in db.execute("SELECT name FROM projects ORDER BY name='Офис', id")]
                directions = {row["name"]: row["direction"] for row in db.execute("SELECT name,direction FROM articles ORDER BY id")}
                data.update(entities=ENTITIES, projects=projects, articles=list(directions), articleDirections=directions, cashStages=CASH_STAGES,
                            scenarios=SCENARIOS, user=name, role=role, demo=not USERS)
                return self.reply(200, data)
        assets = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"), "/app.js": ("app.js", "text/javascript"), "/pnl.js": ("pnl.js", "text/javascript")}
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
