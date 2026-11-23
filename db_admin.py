"""Make a consistent SQLite copy or restore a copy into an empty volume."""

import argparse
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import NamedTemporaryFile


def transfer(source, destination):
    if destination.exists():
        raise ValueError("Файл назначения уже существует. Выберите новое имя или пустой том.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=destination.parent, prefix=".qodex-backup-", delete=False) as staging:
        temporary = Path(staging.name)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(temporary)) as copy:
                original.backup(copy)
                if copy.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("Проверка целостности базы не пройдена.")
                if copy.execute("PRAGMA foreign_key_check").fetchone():
                    raise ValueError("В базе есть нарушенные связи.")
                names = {row[0] for row in copy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {"operations", "accounts", "accruals", "requests"} <= names:
                    raise ValueError("Файл не похож на базу Qodex.")
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "restore"])
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    database = Path(os.environ.get("QODEX_DB", "data/finance.sqlite3"))
    source, destination = (database, args.file) if args.action == "backup" else (args.file, database)
    try:
        transfer(source, destination)
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(1, str(error) + "\n")
    print(f"Проверенная копия сохранена в {destination}")


if __name__ == "__main__":
    main()
