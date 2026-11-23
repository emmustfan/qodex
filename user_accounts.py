"""Persistent user accounts and project scopes."""

import hashlib
import hmac
import json
import re
import secrets

ROLES = ("employee", "manager", "finance", "owner")
FINANCE_ROLES = ("finance", "owner")
DEMO_NAME = "Демо-пользователь"
PASSWORD_ROUNDS = 240_000


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ROUNDS)
    return salt.hex() + ":" + digest.hex()


def password_matches(candidate, saved):
    if not saved or len(candidate) > 1000:
        return False
    salt, expected = saved.split(":")
    digest = hashlib.pbkdf2_hmac("sha256", candidate.encode(), bytes.fromhex(salt), PASSWORD_ROUNDS)
    return hmac.compare_digest(digest, bytes.fromhex(expected))


def read(db, active_only=False):
    where = " WHERE active=1" if active_only else ""
    return [{**dict(row), "projects": json.loads(row["projects"])} for row in db.execute(
        "SELECT login,role,projects,active FROM workspace_users" + where + " ORDER BY login"
    )]


def active(db):
    return {row["login"]: row for row in read(db, active_only=True)}


def identity(db, login):
    return db.execute("SELECT role,digest FROM workspace_users WHERE login=? AND active=1", (login,)).fetchone()


def initialize(db, bootstrap):
    db.execute("""CREATE TABLE IF NOT EXISTS workspace_users (
        login TEXT PRIMARY KEY, role TEXT NOT NULL,
        projects TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, digest TEXT
    )""")
    for login, cfg in bootstrap.items():
        if db.execute("SELECT 1 FROM workspace_users WHERE login=?", (login,)).fetchone():
            continue
        projects = [project for project in cfg.get("projects", []) if project != "Офис"] if cfg["role"] == "manager" else []
        digest = hash_password(cfg["password"]) if cfg.get("password") else None
        db.execute("INSERT INTO workspace_users(login,role,projects,digest) VALUES(?,?,?,?)",
                   (login, cfg["role"], json.dumps(projects, ensure_ascii=False), digest))


def protect_last_owner(db, old, new_role, new_active):
    if old and old["active"] and old["role"] == "owner" and (new_role != "owner" or not new_active):
        owners = db.execute("SELECT COUNT(*) FROM workspace_users WHERE role='owner' AND active=1").fetchone()[0]
        if owners == 1:
            raise ValueError("Оставьте хотя бы одного действующего владельца.")


def change(db, action, payload, proxy):
    login = payload["login"].strip()
    old = db.execute("SELECT * FROM workspace_users WHERE login=?", (login,)).fetchone()
    if action == "user-save":
        if not old and (not re.fullmatch(r"[^\s:\x00-\x1f\x7f]{1,150}", login) or login == DEMO_NAME):
            raise ValueError("Укажите логин до 150 символов без пробелов и двоеточий.")
        role = payload["role"]
        if role not in ROLES:
            raise ValueError("Выберите роль.")
        projects = payload.get("projects", []) if role == "manager" else []
        available = {row["name"] for row in db.execute("SELECT name FROM projects WHERE name<>'Офис'")}
        if (not isinstance(projects, list) or not set(projects) <= available
                or role == "manager" and not projects):
            raise ValueError("Выберите проекты руководителя.")
        password = payload.get("password", "")
        if not proxy and (password or not old) and not 10 <= len(password) <= 250:
            raise ValueError("Задайте пароль от 10 до 250 символов.")
        digest = (hash_password(password) if password and not proxy else old["digest"] if old else None)
        protect_last_owner(db, old, role, old["active"] if old else True)
        db.execute("""INSERT INTO workspace_users(login,role,projects,digest) VALUES(?,?,?,?)
            ON CONFLICT(login) DO UPDATE SET role=excluded.role,projects=excluded.projects,digest=excluded.digest""",
                   (login, role, json.dumps(sorted(set(projects)), ensure_ascii=False), digest))
    else:
        if old is None:
            raise ValueError("Сотрудник не найден.")
        enabled = action == "user-restore"
        if enabled and not proxy and not old["digest"]:
            raise ValueError("Сначала задайте сотруднику пароль.")
        protect_last_owner(db, old, old["role"], enabled)
        db.execute("UPDATE workspace_users SET active=? WHERE login=?", (int(enabled), login))
    return login
