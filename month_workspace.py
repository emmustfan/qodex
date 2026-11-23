"""Monthly review, project expense rules, and weekly actions."""

from calendar import monthrange


def initialize(db, non_operating):
    # Individual DDL statements keep the caller's migration transaction intact.
    db.execute("""
        CREATE TABLE IF NOT EXISTS monthly_rules (
            id INTEGER PRIMARY KEY, entity INTEGER NOT NULL REFERENCES legal_entities(id),
            project TEXT NOT NULL, article TEXT NOT NULL, month TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('fixed','commission','off')),
            value INTEGER NOT NULL CHECK(value>=0), income_article TEXT,
            UNIQUE(entity, project, article, month)
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS bonus_confirmations (
            entity INTEGER NOT NULL REFERENCES legal_entities(id), month TEXT NOT NULL,
            project TEXT NOT NULL, article TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK(amount>0), basis INTEGER NOT NULL,
            actor TEXT NOT NULL, cutoff TEXT NOT NULL,
            PRIMARY KEY(entity, month, project, article)
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS weekly_actions (
            id INTEGER PRIMARY KEY, entity INTEGER NOT NULL REFERENCES legal_entities(id),
            project TEXT, day TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1))
        )
    """)
    excluded = ",".join("'" + article.replace("'", "''") + "'" for article in non_operating)
    db.execute(f"""
        CREATE VIEW IF NOT EXISTS project_cash_entries AS
        SELECT a.entity,o.day,l.project,l.article,l.amount,COALESCE(l.bonus_month,l.accrual,substr(o.day,1,7)) AS settlement_month
        FROM allocations l JOIN operations o ON o.id=l.operation JOIN accounts a ON a.id=o.account
        WHERE l.article NOT IN ({excluded})
          AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.incoming=o.id OR t.outgoing=o.id)
          AND NOT EXISTS (SELECT 1 FROM profit_payments p WHERE p.operation=o.id)
    """)
    db.execute(f"""
        CREATE VIEW IF NOT EXISTS recorded_pnl_expenses AS
        SELECT entity,month,project,article,-amount AS amount FROM accruals WHERE amount<0
        UNION ALL
        SELECT a.entity,l.accrual,l.project,COALESCE(l.accrual_article,l.article),-l.amount
        FROM allocations l JOIN operations o ON o.id=l.operation JOIN accounts a ON a.id=o.account
        WHERE l.accrual IS NOT NULL AND l.amount<0 AND l.article NOT IN ({excluded})
    """)
    db.execute("""
        CREATE VIEW IF NOT EXISTS bonus_accruals AS
        SELECT entity,month,project,article,'Премия по поступлениям' AS description,-difference AS amount
        FROM (
            SELECT b.*, b.amount - COALESCE((
                SELECT SUM(e.amount) FROM recorded_pnl_expenses e
                WHERE e.entity=b.entity AND e.month=b.month AND e.project=b.project AND e.article=b.article
            ),0) AS difference FROM bonus_confirmations b
        ) WHERE difference>0
    """)


def month_end(period):
    year, month = map(int, period.split("-"))
    return f"{period}-{monthrange(year, month)[1]:02}"


def effective_rules(db, entity, period):
    return db.execute("""
        SELECT r.*, p.archived OR a.archived OR COALESCE(i.archived,0) AS archived
        FROM monthly_rules r JOIN projects p ON p.name=r.project
        JOIN articles a ON a.name=r.article LEFT JOIN articles i ON i.name=r.income_article
        WHERE r.entity=? AND r.month<=? AND r.kind<>'off'
          AND NOT EXISTS (SELECT 1 FROM monthly_rules n WHERE n.entity=r.entity AND n.project=r.project
            AND n.article=r.article AND n.month>r.month AND n.month<=?)
        ORDER BY r.project,r.article
    """, (entity,period,period)).fetchall()


def approved_bonuses(db, entity, cutoff):
    return [dict(row) for row in db.execute("""
        SELECT b.*, COALESCE((
            SELECT SUM(-c.amount) FROM project_cash_entries c WHERE c.entity=b.entity
              AND c.day<=? AND c.project=b.project AND c.article=b.article AND c.amount<0
              AND c.settlement_month=b.month
        ),0) AS paid
        FROM bonus_confirmations b WHERE b.entity=? AND b.cutoff<=?
        ORDER BY b.month,b.project,b.article
    """, (cutoff,entity,cutoff))]


def calculate_percentage(base, basis_points):
    return (base * basis_points + 5000) // 10000


def rule_rows(db, entity, period, cutoff, plans, non_operating):
    rules = effective_rules(db,entity,period)
    if not rules:
        return []
    cash = db.execute("""
        SELECT project,article,amount FROM project_cash_entries
        WHERE entity=? AND day<=? AND (
            (amount>0 AND day>=?) OR (amount<0 AND settlement_month=?)
        )
    """, (entity,cutoff,period + "-01",period)).fetchall()
    confirmed = {(r["project"],r["article"]): r for r in db.execute(
        "SELECT * FROM bonus_confirmations WHERE entity=? AND month=?", (entity,period)
    )}
    recorded = {(r["project"],r["article"]): r["amount"] for r in db.execute("""
        SELECT project,article,SUM(amount) AS amount FROM recorded_pnl_expenses
        WHERE entity=? AND month=? GROUP BY project,article
    """, (entity,period))}
    result = []
    for rule in rules:
        project, article, source = rule["project"], rule["article"], rule["income_article"]
        plan = [row for row in plans if row["basis"] == "БДР" and row["project"] == project and row["article"] == article]
        previous = confirmed.get((project,article))
        row = {**dict(rule), "manual": any(p["source"] != "monthly-rule" for p in plan),
               "applied": sum(-p["amount"] for p in plan) if plan else None,
               "posted": previous["amount"] if previous else 0,
               "posted_cutoff": previous["cutoff"] if previous else None,
               "recorded": recorded.get((project,article),0)}
        if rule["kind"] == "fixed":
            row["plan"] = rule["value"]
        else:
            income_plan = [p for p in plans if p["basis"] == "БДДС" and p["amount"] > 0
                           and p["project"] == project and p["article"] not in non_operating
                           and (not source or p["article"] == source)]
            base = sum(c["amount"] for c in cash if c["project"] == project and c["amount"] > 0
                       and (not source or c["article"] == source))
            paid = sum(-c["amount"] for c in cash if c["project"] == project and c["article"] == article and c["amount"] < 0)
            calculated = calculate_percentage(base,rule["value"])
            row.update(
                base=base, paid=paid, calculated=calculated, due=max(calculated - paid,0),
                plan=calculate_percentage(sum(p["amount"] for p in income_plan),rule["value"]) if income_plan else None,
            )
        result.append(row)
    return result


def review(db, entity, period, cutoff, scenario, non_operating):
    plans = db.execute("""
        SELECT * FROM plans WHERE entity=? AND month=? AND scenario=?
    """, (entity,period,scenario)).fetchall()
    return {
        "rules": rule_rows(db,entity,period,cutoff,plans,non_operating),
        "bonuses": approved_bonuses(db,entity,cutoff),
        "actions": [dict(row) for row in db.execute("""
            SELECT * FROM weekly_actions WHERE entity=? AND (substr(day,1,7)=? OR (day<? AND done=0))
            ORDER BY done,day,id
        """, (entity,period,period + "-01"))],
    }


def pending_bonuses(db, entity, period, non_operating):
    return sum(
        row["kind"] == "commission" and (
            row["calculated"] > max(row["posted"],row["recorded"])
            or (row["posted"] and row["calculated"] != row["posted"] and row["recorded"] < row["posted"])
        )
        for row in rule_rows(db,entity,period,month_end(period),[],non_operating)
    )


def save_rule(db, entity, period, project, article, kind, value, income_article, expected):
    key = (entity,project,article)
    versions = db.execute("""
        SELECT * FROM monthly_rules WHERE entity=? AND project=? AND article=? ORDER BY month
    """, key).fetchall()
    current = next((row for row in reversed(versions) if row["month"] <= period),None)
    unchanged = current and (current["kind"],current["value"],current["income_article"]) == (kind,value,income_article)
    if unchanged:
        return current["id"]
    actual = [current[name] for name in ("id","kind","value","income_article")] if current else None
    if expected != actual and not (expected is None and current and current["kind"] == "off"):
        raise ValueError("Правило за этот месяц изменилось. Обновите рабочий месяц и проверьте настройки.")
    until = next((row["month"] for row in versions if row["month"] > period),"9999-99")
    if db.execute("SELECT 1 FROM period_closures WHERE entity=? AND month>=? AND month<?",
                  (entity,period,until)).fetchone():
        raise ValueError("Правило затрагивает закрытый месяц. Укажите более поздний месяц начала.")
    if db.execute("""
        SELECT 1 FROM bonus_confirmations WHERE entity=? AND project=? AND article=? AND month>=? AND month<?
    """, (*key,period,until)).fetchone():
        raise ValueError("В затронутом периоде есть подтверждённая премия. Выберите другой месяц или снимите подтверждение.")
    return db.execute("""
        INSERT INTO monthly_rules(entity,project,article,month,kind,value,income_article) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(entity,project,article,month) DO UPDATE SET
            kind=excluded.kind,value=excluded.value,income_article=excluded.income_article
        RETURNING id
    """, (*key,period,kind,value,income_article)).fetchone()[0]


def apply_plan(db, entity, period, scenario, rule):
    key = (entity,period,scenario,rule["project"],rule["article"])
    if rule["manual"]:
        raise ValueError("По этой статье уже есть ручная строка бюджета. Проверьте её в БДР.")
    if rule["plan"] is None:
        raise ValueError("Добавьте план поступлений по проекту в БДДС.")
    db.execute("""
        DELETE FROM plans WHERE entity=? AND month=? AND scenario=? AND project=? AND article=?
          AND basis='БДР' AND source='monthly-rule'
    """, key)
    if rule["plan"]:
        db.execute("""
            INSERT INTO plans(entity,month,scenario,project,article,basis,amount,source)
            VALUES(?,?,?,?,?,'БДР',?,'monthly-rule')
        """, (*key,-rule["plan"]))


def confirm_bonus(db, entity, period, cutoff, rule, actor, clear):
    key = (entity,period,rule["project"],rule["article"])
    if clear:
        db.execute("DELETE FROM bonus_confirmations WHERE entity=? AND month=? AND project=? AND article=?", key)
    elif not rule["calculated"]:
        raise ValueError("На выбранную дату расчёт премии равен нулю. Для отмены начисления снимите подтверждение.")
    else:
        db.execute("""
            INSERT INTO bonus_confirmations(entity,month,project,article,amount,basis,actor,cutoff)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(entity,month,project,article) DO UPDATE SET amount=excluded.amount,
                basis=excluded.basis,actor=excluded.actor,cutoff=excluded.cutoff
        """, (*key,rule["calculated"],rule["base"],actor,cutoff))


def action_save(db, entity, project, when, title, assignee, action_id):
    if not title or len(title) > 300 or len(assignee) > 100:
        raise ValueError("Укажите действие до 300 символов и ответственного до 100 символов.")
    values = (entity,project,when,title,assignee)
    if not action_id:
        return db.execute("""
            INSERT INTO weekly_actions(entity,project,day,title,assignee) VALUES(?,?,?,?,?)
        """, values).lastrowid
    if db.execute("""
        UPDATE weekly_actions SET entity=?,project=?,day=?,title=?,assignee=? WHERE id=? AND entity=?
    """, (*values,int(action_id),entity)).rowcount != 1:
        raise ValueError("Действие не найдено.")
    return int(action_id)
