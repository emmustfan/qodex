"""Storage and validation for the shared P&L layout."""

import json
import re

STAGES = {"revenue", "direct", "project", "office"}
DEFAULT_BLOCKS = [
    {"id": "revenue", "stage": "revenue", "name": "Выручка проектов"},
    {"id": "direct", "stage": "direct", "name": "Прямые затраты"},
    {"id": "project", "stage": "project", "name": "Прочие расходы проектов"},
    {"id": "office", "stage": "office", "name": "Доходы и расходы офиса"},
]
DIRECT_ARTICLES = {"Разработка", "Дизайн", "ФОТ", "Инфраструктура", "Поддержка",
                   "Прямые расходы на клиентов", "Услуги поставщиков"}


def initialize(db, articles):
    assignments = []
    for article, direction in articles.items():
        block = "revenue" if direction == "income" else "direct" if article in DIRECT_ARTICLES else "project"
        assignments.extend([
            {"article": article, "scope": "project", "block": block},
            {"article": article, "scope": "office", "block": "office"},
        ])
    body = {"blocks": DEFAULT_BLOCKS, "assignments": assignments}
    db.execute("INSERT OR IGNORE INTO pnl_template(id,revision,body) VALUES(1,1,?)",
               (json.dumps(body, ensure_ascii=False),))


def read(db):
    row = db.execute("SELECT revision,body FROM pnl_template WHERE id=1").fetchone()
    return {"revision": row["revision"], **json.loads(row["body"])}


def validate(payload, articles):
    blocks, assignments = payload["blocks"], payload["assignments"]
    if not isinstance(blocks, list) or len(blocks) > 60:
        raise ValueError("В шаблоне может быть до 60 блоков.")
    if not isinstance(assignments, list) or len(assignments) > 2 * len(articles):
        raise ValueError("Проверьте привязки статей.")
    by_id = {}
    names = set()
    for block in blocks:
        block_id, stage, name = block["id"], block["stage"], block["name"].strip()
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", block_id) or block_id in by_id or stage not in STAGES:
            raise ValueError("Проверьте блоки шаблона.")
        if not name or len(name) > 80 or name.casefold() in names:
            raise ValueError("Названия блоков должны различаться и содержать до 80 символов.")
        by_id[block_id] = {"id": block_id, "stage": stage, "name": name}
        names.add(name.casefold())
    routes = {}
    for entry in assignments:
        article, scope, block_id = entry["article"], entry["scope"], entry["block"]
        stage = by_id.get(block_id, {}).get("stage")
        if article not in articles or scope not in ("office", "project") or stage is None:
            raise ValueError("Проверьте привязку статьи к блоку.")
        expected = {"office"} if scope == "office" else (
            {"revenue"} if articles[article] == "income" else {"direct", "project"})
        if stage not in expected or (article, scope) in routes:
            raise ValueError(f'Для статьи «{article}» выберите один подходящий блок в каждом разрезе.')
        routes[article, scope] = {"article": article, "scope": scope, "block": block_id}
    return {"blocks": list(by_id.values()), "assignments": list(routes.values())}


def save(db, payload, articles):
    body = validate(payload, articles)
    revision = int(payload["revision"])
    row = db.execute("""
        UPDATE pnl_template SET revision=revision+1, body=? WHERE id=1 AND revision=? RETURNING revision
    """, (json.dumps(body, ensure_ascii=False), revision)).fetchone()
    if not row:
        raise ValueError("Шаблон уже обновили. Откройте последнюю версию и повторите изменения.")
    return row["revision"]
