"""Accounting period locks and the bank/accrual checklist."""

import json

LOCK_MESSAGE = "Период закрыт. Откройте его для корректировки."


def install_locks(db):
    # Generate fixed SQL from this module's definitions. User data never becomes SQL.
    db.execute("""CREATE TABLE IF NOT EXISTS period_closures (
        entity INTEGER NOT NULL CHECK(entity IN (1,2)), month TEXT NOT NULL,
        actor TEXT NOT NULL, note TEXT NOT NULL, checks TEXT NOT NULL,
        closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(entity,month)
    )""")
    lock = lambda entity, period, through=False: (
        f"EXISTS (SELECT 1 FROM period_closures WHERE month {'>=' if through else '='} {period}"
        f" AND ({entity} IS NULL OR entity={entity}))"
    )

    def account(record):
        return f"(SELECT a.entity FROM accounts a WHERE a.id={record}.account)"

    def operations(ids, accrual=None):
        periods = "c.month=substr(o.day,1,7)"
        if accrual:
            periods += f" OR c.month={accrual}"
        return (f"EXISTS (SELECT 1 FROM operations o LEFT JOIN accounts a ON a.id=o.account"
                f" JOIN period_closures c ON (c.entity=a.entity OR a.entity IS NULL)"
                f" AND ({periods}) WHERE o.id IN ({ids}))")

    def operation(record):
        entity = account(record)
        return (
            lock(entity, f"substr({record}.day,1,7)", through=True) +
            f" OR EXISTS (SELECT 1 FROM allocations l JOIN period_closures c ON c.month=l.accrual"
            f" AND ({entity} IS NULL OR c.entity={entity}) WHERE l.operation={record}.id)"
        )

    per_month = lambda r: lock(f"{r}.entity", f"{r}.month")
    by_day = lambda r: lock(f"{r}.entity", f"substr({r}.day,1,7)")
    check = {
        "operations": operation,
        "allocations": lambda r: operations(f"{r}.operation", f"{r}.accrual"),
        "transfers": lambda r: operations(f"{r}.outgoing,{r}.incoming"),
        "request_payments": lambda r: operations(f"{r}.operation"),
        "profit_payments": lambda r: operations(f"{r}.operation"),
        "accrual_schedule_payments": lambda r: operations(f"{r}.operation"),
        "statement_controls": lambda r: lock(account(r), f"{r}.month"),
        "account_balances": lambda r: lock(account(r), f"substr({r}.day,1,7)", through=True),
        "balances": lambda r: lock("NULL", f"substr({r}.day,1,7)", through=True),
        "accruals": per_month,
        "plans": per_month,
        "office_contributions": per_month,
        "office_distribution_rules": per_month,
        "requests": lambda r: f"({r}.status='Согласована' AND {by_day(r)})",
        "profit_decisions": lambda r: (f"({per_month(r)} OR {by_day(r)} OR "
            f"({r}.fund IS NOT NULL AND {lock(f'{r}.entity', f'substr({r}.day,1,7)', through=True)}))"),
        "fund_entries": lambda r: lock(f"(SELECT f.entity FROM funds f WHERE f.id={r}.fund)",
                                       f"substr({r}.day,1,7)", through=True),
    }
    for table, rule in check.items():
        for event, records in (("INSERT", ("NEW",)), ("UPDATE", ("OLD", "NEW")), ("DELETE", ("OLD",))):
            if table == "requests" and event == "UPDATE":
                event_clause = "UPDATE OF status,day,entity,project,article,amount"
            else:
                event_clause = event
            condition = " OR ".join("(" + rule(record) + ")" for record in records)
            db.execute(f"""CREATE TRIGGER IF NOT EXISTS close_guard_{table}_{event.lower()}
                BEFORE {event_clause} ON {table} WHEN {condition}
                BEGIN SELECT RAISE(ABORT, '{LOCK_MESSAGE}'); END""")


def bank_totals(db, account, start, end):
    return tuple(db.execute("""
        SELECT COALESCE(SUM(MAX(amount,0)),0),COALESCE(SUM(MAX(-amount,0)),0)
        FROM operations WHERE account=? AND day>=? AND day<?
    """, (account, start, end)).fetchone())


def opening_at(db, account, when):
    row = db.execute("SELECT day,amount FROM account_balances WHERE account=? AND day<=?",
                     (account, when)).fetchone()
    if row is None:
        return None
    incoming, outgoing = bank_totals(db, account, row["day"], when)
    return row["amount"] + incoming - outgoing


def matched_bank(db, account, period, start, end):
    manual = db.execute("SELECT * FROM statement_controls WHERE account=? AND month=?", (account, period)).fetchone()
    opening = opening_at(db, account, start)
    incoming, outgoing = bank_totals(db, account, start, end)
    if opening is None:
        return False
    if manual:
        return (opening, incoming, outgoing, opening + incoming - outgoing) == (
            manual["opening"], manual["incoming"], manual["outgoing"], manual["closing"])
    for row in db.execute("""
        SELECT *, date(end,'+1 day') AS next_day FROM bank_statements
        WHERE account=? AND start<=? AND date(end,'+1 day')>=?
    """, (account, start, end)):
        bank_opening = opening_at(db, account, row["start"])
        full_in, full_out = bank_totals(db, account, row["start"], row["next_day"])
        if (bank_opening, full_in, full_out) == (row["opening"], row["incoming"], row["outgoing"]):
            return True
    return False


def checklist(db, entity, period):
    start, end = db.execute("SELECT ?,date(?,'+1 month')", (period + "-01", period + "-01")).fetchone()
    accounts = db.execute("""
        SELECT a.id,a.name FROM accounts a WHERE a.entity=? AND (
            EXISTS (SELECT 1 FROM operations o WHERE o.account=a.id AND o.day<?)
            OR EXISTS (SELECT 1 FROM account_balances b WHERE b.account=a.id AND b.day<?)
            OR EXISTS (SELECT 1 FROM statement_controls s WHERE s.account=a.id AND s.month=?))
    """, (entity, end, end, period)).fetchall()
    unreconciled = [row["name"] for row in accounts if not matched_bank(db, row["id"], period, start, end)]
    unassigned = db.execute("""
        SELECT count(*) FROM operations o LEFT JOIN accounts a ON a.id=o.account
        WHERE o.day>=? AND o.day<? AND (a.entity=? OR a.entity IS NULL)
        AND (a.entity IS NULL OR (
          NOT EXISTS (SELECT 1 FROM allocations l WHERE l.operation=o.id)
          AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.incoming=o.id OR t.outgoing=o.id)
          AND NOT EXISTS (SELECT 1 FROM profit_payments p WHERE p.operation=o.id)
        ))
    """, (start, end, entity)).fetchone()[0]
    documents = db.execute("""
        SELECT count(*) FROM operations o JOIN accounts a ON a.id=o.account
        WHERE a.entity=? AND o.day>=? AND o.day<? AND o.document_pending=1
    """, (entity, start, end)).fetchone()[0]
    schedules = db.execute("""
        SELECT count(*) FROM schedule_months m JOIN accrual_schedules s ON s.id=m.schedule
        WHERE s.entity=? AND m.month=?
        AND NOT EXISTS (SELECT 1 FROM accruals a WHERE a.schedule_month=m.id)
    """, (entity, period)).fetchone()[0]
    return {"unreconciled": unreconciled, "unassigned": unassigned, "documents": documents, "schedules": schedules}


def close(db, entity, period, actor, note, exceptions, expected=None):
    checks = checklist(db, entity, period)
    if expected is not None and expected != checks:
        raise ValueError("Результаты проверки изменились. Откройте её ещё раз.")
    if any(checks.values()) and not exceptions:
        raise ValueError("Подтвердите закрытие с замечаниями или устраните замечания.")
    if db.execute("SELECT 1 FROM period_closures WHERE entity=? AND month=?", (entity, period)).fetchone():
        raise ValueError("Период уже закрыт.")
    db.execute("INSERT INTO period_closures(entity,month,actor,note,checks) VALUES(?,?,?,?,?)",
               (entity, period, actor, note, json.dumps(checks, ensure_ascii=False)))
