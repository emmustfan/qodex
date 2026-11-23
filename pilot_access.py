"""Role boundaries and supporting records for the request workflow."""

import re
from base64 import b64decode


def can_view(request, actor, role, users):
    return (role == "finance" or request["author"] == actor
            or role == "manager" and request["project"] in users.get(actor, {}).get("projects", []))


def manager_matches(user, request, money):
    return (user.get("role") == "manager" and request["project"] in user.get("projects", [])
            and ("articles" not in user or request["article"] in user["articles"])
            and request["amount"] <= money(user.get("limit", 0), allow_zero=True))


def can_review(request, actor, role, users, money):
    return (request["status"] == "На согласовании" and (not users or request["author"] != actor)
            and (role == "finance" or manager_matches(users.get(actor, {}), request, money)))


def request_for(db, value, actor, role, users):
    request = db.execute("SELECT * FROM requests WHERE id=?", (int(value),)).fetchone()
    if not request or not can_view(request, actor, role, users):
        raise PermissionError("Заявка недоступна.")
    return request


def add_comment(db, request, actor, note):
    text = note.strip()
    if not text or len(text) > 2000:
        raise ValueError("Введите комментарий до 2 000 символов.")
    return db.execute("INSERT INTO request_comments(request,actor,body) VALUES(?,?,?)",
                      (request, actor, text)).lastrowid


def add_attachment(db, request, actor, filename, data):
    filename = re.split(r"[/\\]", filename)[-1].strip()
    raw = b64decode(data, validate=True)
    if not 1 <= len(filename) <= 160 or not filename.lower().endswith(".pdf"):
        raise ValueError("Выберите PDF с названием до 160 символов.")
    if len(raw) > 1_000_000 or not raw.startswith(b"%PDF-"):
        raise ValueError("Выберите корректный PDF до 1 МБ.")
    return db.execute("INSERT INTO request_attachments(request,actor,name,data) VALUES(?,?,?,?)",
                      (request, actor, filename, raw)).lastrowid



def notify_request(db, request, action, actor, users, money):
    labels = {
        "request": "Новая заявка к рассмотрению",
        "review": request["status"],
        "request-comment": "Новый комментарий",
        "request-attach": "Добавлено вложение",
        "reschedule": "Перенесён срок оплаты",
        "link-payment": "Добавлена оплата",
        "unlink-payment": "Снята связь оплаты",
    }
    for recipient, user in users.items():
        role = user["role"]
        if recipient == actor or not can_view(request, recipient, role, users):
            continue
        if action == "request" and not can_review(request, recipient, role, users, money):
            continue
        if action in ("review", "reschedule", "link-payment", "unlink-payment") and recipient != request["author"]:
            continue
        db.execute("INSERT INTO request_alerts(request,recipient,body) VALUES(?,?,?)",
                   (request["id"], recipient, labels[action]))
