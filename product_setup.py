"""Install the agreed product hierarchy and P&L catalog without changing postings."""

import pnl_template

SETUP_KEY = "qodex_product_structure_v1"
PRODUCTS = (
    ("Кодекс ТКО", None, "полигон"),
    ("Ро-бот", None, "РО"),
    ("Ро-бот / Жильё", "Ро-бот", "РО"),
    ("Ро-бот / ГИС ЖКХ", "Ро-бот", "РО"),
    ("Ро-бот / Коммерция", "Ро-бот", "РО"),
    ("Кодекс Tracker", None, "мусоровоз"),
    ("Кодекс TONN", None, None),
    ("Кодекс TONN / Signal", "Кодекс TONN", "компания"),
    ("Кодекс TONN / Gravity", "Кодекс TONN", "полигон"),
)
BLOCKS = (
    ("products-income", "revenue", "Выручка по видам продаж"),
    ("products-delivery", "variable", "Оборудование, монтаж и внедрение"),
    ("products-data", "variable", "Перепродажа данных"),
    ("products-commissions", "variable", "Переменные премии продаж"),
    ("products-fulfillment", "variable", "Переменные затраты на сервис"),
    ("products-team", "project", "Команда и постоянные затраты продукта"),
    ("products-shared", "project", "Распределённые общие услуги"),
    ("products-office", "office", "Административные расходы"),
)
CATALOG = (
    ("Лицензии", "income", "Выручка", "products-income"),
    ("Продажа оборудования", "income", "Выручка", "products-income"),
    ("Монтаж оборудования", "income", "Выручка", "products-income"),
    ("Внедрение", "income", "Выручка", "products-income"),
    ("Платная техподдержка", "income", "Выручка", "products-income"),
    ("Продажа архивных КПТ", "income", "Выручка", "products-income"),
    ("Продажа данных 2ГИС", "income", "Выручка", "products-income"),
    ("Дополнительные строки Ро-бота", "income", "Выручка", "products-income"),
    ("Оборудование для перепродажи", "expense", "Оборудование и монтаж", "products-delivery"),
    ("Доставка оборудования", "expense", "Оборудование и монтаж", "products-delivery"),
    ("Комплектующие для монтажа", "expense", "Оборудование и монтаж", "products-delivery"),
    ("Подрядчики по монтажу", "expense", "Оборудование и монтаж", "products-delivery"),
    ("Подрядчики по внедрению", "expense", "Оборудование и монтаж", "products-delivery"),
    ("Закупка архивных КПТ", "expense", "Данные для перепродажи", "products-data"),
    ("Закупка данных 2ГИС", "expense", "Данные для перепродажи", "products-data"),
    ("Облако по потреблению", "expense", "Инфраструктура продукта", "products-fulfillment"),
    ("Премии продаж по оплатам", "expense", "Премии продаж", "products-commissions"),
    ("Премии с маржи оборудования", "expense", "Премии продаж", "products-commissions"),
    ("ФОТ разработки", "expense", "Зарплата", "products-team"),
    ("ФОТ техподдержки", "expense", "Зарплата", "products-team"),
    ("ФОТ внедрения", "expense", "Зарплата", "products-team"),
    ("ФОТ управления продуктом", "expense", "Зарплата", "products-team"),
    ("ФОТ продаж", "expense", "Зарплата", "products-team"),
    ("Взносы с ФОТ продукта", "expense", "Зарплата", "products-team"),
    ("Базовая инфраструктура продукта", "expense", "Инфраструктура продукта", "products-team"),
    ("Лицензии для продукта", "expense", "Инфраструктура продукта", "products-team"),
    ("Бухгалтерия на аутсорсе", "expense", "Профессиональные услуги", "products-shared"),
)


def installed(db):
    return db.execute("SELECT 1 FROM qodex_settings WHERE key=?", (SETUP_KEY,)).fetchone() is not None


def apply(db, default_entities, non_pnl_articles):
    if installed(db):
        return False

    existing_projects = {row[0].casefold(): row[0] for row in db.execute("SELECT name FROM projects")}
    names = {}
    for name, parent, unit in PRODUCTS:
        previous = existing_projects.get(name.casefold())
        root = names.get(parent)
        if previous:
            actual_name = previous
            if root and db.execute("""
                WITH RECURSIVE ancestors(name) AS (
                  VALUES(?) UNION SELECT p.parent FROM projects p JOIN ancestors a ON p.name=a.name
                  WHERE p.parent IS NOT NULL
                ) SELECT 1 FROM ancestors WHERE name=?
            """, (root,actual_name)).fetchone():
                root = None
            db.execute("UPDATE projects SET parent=COALESCE(parent,?),license_unit=COALESCE(license_unit,?) WHERE name=?",
                       (root, unit, actual_name))
        else:
            actual_name = name
            db.execute("INSERT INTO projects(name,parent,license_unit) VALUES(?,?,?)", (name, root, unit))
        names[name] = actual_name

    groups = {row["name"].casefold(): row["id"] for row in db.execute("SELECT id,name FROM article_groups WHERE parent IS NULL")}
    template = pnl_template.read(db)
    block_names = {block["name"].casefold(): block for block in template["blocks"]}
    used_ids = {block["id"] for block in template["blocks"]}
    section_ids = {}
    for desired_id, stage, name in BLOCKS:
        previous = block_names.get(name.casefold())
        if previous and previous["stage"] == stage:
            section_ids[desired_id] = previous["id"]
            continue
        # Keep any user section that already has this name or identifier.
        block_id = desired_id
        suffix = 2
        while block_id in used_ids:
            block_id = f"{desired_id}-{suffix}"
            suffix += 1
        label = name
        suffix = 2
        while label.casefold() in block_names:
            label = f"{name} ({suffix})"
            suffix += 1
        block = {"id": block_id, "stage": stage, "name": label}
        template["blocks"].append(block)
        block_names[label.casefold()] = block
        used_ids.add(block_id)
        section_ids[desired_id] = block_id

    existing_articles = {row["name"].casefold(): row for row in db.execute("SELECT name,direction,archived FROM articles")}
    assigned = {(item["article"], item["scope"]) for item in template["assignments"]}
    for name, direction, group, block in CATALOG:
        previous = existing_articles.get(name.casefold())
        if previous and previous["direction"] != direction:
            label = name + (" (доход)" if direction == "income" else " (расход)")
            name, suffix = label, 2
            previous = existing_articles.get(name.casefold())
            while previous and previous["direction"] != direction:
                name = f"{label} {suffix}"
                suffix += 1
                previous = existing_articles.get(name.casefold())
        if previous and previous["archived"]:
            continue
        group_key = group.casefold()
        if group_key not in groups:
            groups[group_key] = db.execute("INSERT INTO article_groups(name) VALUES(?)", (group,)).lastrowid
        group_id = groups[group_key]
        if previous:
            name = previous["name"]
            db.execute("UPDATE articles SET group_id=? WHERE name=? AND group_id IS NULL", (group_id, name))
        else:
            db.execute("INSERT INTO articles(name,direction,group_id) VALUES(?,?,?)", (name, direction, group_id))
        for scope, section in (("project", block), ("office", "products-office")):
            if (name, scope) not in assigned:
                template["assignments"].append({"article": name, "scope": scope, "block": section_ids[section]})

    directions = {row["name"]: row["direction"] for row in db.execute("SELECT name,direction FROM articles")
                  if row["name"] not in non_pnl_articles}
    pnl_template.save(db, template, directions)
    entity_names = {row["name"].casefold() for row in db.execute("SELECT name FROM legal_entities")}
    for index, (previous, name) in enumerate(zip(default_entities, ("Кодекс Технологии", "Кодекс Электроника")), 1):
        if name.casefold() not in entity_names:
            db.execute("UPDATE legal_entities SET name=? WHERE id=? AND name=?", (name, index, previous))
    db.execute("INSERT INTO qodex_settings(key) VALUES(?)", (SETUP_KEY,))
    return True
