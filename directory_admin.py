"""Keep closed and historical financial references intact."""

import json

TABLES = {
    "projects": (
        ("allocations", "project"), ("accruals", "project"), ("plans", "project"), ("requests", "project"),
        ("bank_rules", "project"), ("accrual_schedules", "project"), ("balances", "project"),
        ("office_contributions", "project"), ("forecast_entries", "project"),
    ),
    "articles": (
        ("allocations", "article"), ("allocations", "accrual_article"), ("accruals", "article"),
        ("plans", "article"), ("requests", "article"), ("bank_rules", "article"), ("accrual_schedules", "article"),
    ),
}
PROTECTED = {"projects": {"Офис"}, "articles": {"Финансирование", "Дивиденды"}}


def used_names(db, category):
    used = set(PROTECTED[category])
    for table, column in TABLES[category]:
        used.update(row[0] for row in db.execute(f"SELECT DISTINCT {column} FROM {table}"))
    key = "project" if category == "projects" else "article"
    for row in db.execute("SELECT rows FROM budget_versions"):
        used.update(item.get(key) for item in json.loads(row["rows"]))
    if category == "projects":
        for row in db.execute("SELECT projects FROM workspace_users"):
            used.update(json.loads(row["projects"]))
        for row in db.execute("SELECT weights FROM office_distribution_rules"):
            used.update(project for project, weight in json.loads(row["weights"]).items() if weight)
    used.discard(None)
    return used


def edit_article(db, current, name, direction):
    if current in used_names(db, "articles"):
        raise ValueError("Статья используется. Для новой классификации создайте новую статью.")
    if direction not in ("income", "expense"):
        raise ValueError("Выберите поступление или расход.")
    if not name or len(name) > 100 or name.casefold() in ("без распределения", "между счетами", "между ооо"):
        raise ValueError("Укажите название статьи до 100 символов.")
    if any(row["name"].casefold() == name.casefold() for row in db.execute(
        "SELECT name FROM articles WHERE name<>?", (current,)
    )):
        raise ValueError("Такое название уже есть в справочнике.")
    old = db.execute("SELECT direction FROM articles WHERE name=?", (current,)).fetchone()
    if not old:
        raise ValueError("Статья не найдена.")
    db.execute("UPDATE articles SET name=?,direction=? WHERE name=?", (name,direction,current))
    if current != name or old["direction"] != direction:
        update_article_bindings(db, current, name if old["direction"] == direction else None)


def update_article_bindings(db, name, replacement=None):
    row = db.execute("SELECT body FROM pnl_template WHERE id=1").fetchone()
    body = json.loads(row["body"])
    remaining = [{**item, "article": replacement} if item["article"] == name else item
                 for item in body["assignments"] if item["article"] != name or replacement]
    if remaining != body["assignments"]:
        body["assignments"] = remaining
        db.execute("UPDATE pnl_template SET body=?,revision=revision+1 WHERE id=1",
                   (json.dumps(body, ensure_ascii=False),))


def change(db, category, name, mode):
    if category not in TABLES or mode not in ("archive", "restore", "delete"):
        raise ValueError("Выберите действие со справочником.")
    if name in PROTECTED[category]:
        raise ValueError("Эта запись используется в системных отчётах.")
    if mode == "delete":
        if name in used_names(db, category):
            raise ValueError("Запись уже используется. Для сохранения истории отправьте её в архив.")
        count = db.execute(f"DELETE FROM {category} WHERE name=?", (name,)).rowcount
        if category == "articles" and count:
            update_article_bindings(db, name)
    else:
        count = db.execute(f"UPDATE {category} SET archived=? WHERE name=?",
                           (int(mode == "archive"),name)).rowcount
    if not count:
        raise ValueError("Запись не найдена.")
