"""Read the XLSX export produced by Tochka's account statement view."""

import re
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from defusedxml.common import DefusedXmlException
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

HEADERS = ("Номер документа", "Дата документа", "Дата операции", "Счёт", "Контрагент",
           "ИНН контрагента", "БИК банка контрагента", "Корр.счёт банка контрагента",
           "Наименование банка контрагента", "Счёт контрагента", "Списание",
           "Зачисление", "Назначение платежа")


@dataclass(frozen=True)
class Operation:
    key: tuple
    day: str
    description: str
    counterparty: str
    counterparty_key: tuple
    amount: int


@dataclass(frozen=True)
class Statement:
    number: str
    start: str
    end: str
    opening: int
    incoming: int
    outgoing: int
    closing: int
    operations: list[Operation]


def iso_date(value):
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    return datetime.strptime(value, "%d.%m.%Y").date().isoformat()


def read_operations(sheet, money):
    counters = Counter()
    rows = sheet.iter_rows(max_col=len(HEADERS), values_only=True)
    for index, row in enumerate(rows, 1):
        if index > 20:
            raise ValueError("Не найдена шапка на листе «Операции».")
        if tuple(str(cell or "").strip() for cell in row) == HEADERS:
            break
    else:
        raise ValueError("Не найдена шапка на листе «Операции».")
    for index, row in enumerate(rows, index + 1):
        if index > 20_000:
            raise ValueError("Загрузите выписку Точки объёмом до 20 000 строк.")
        if not any(cell is not None for cell in row):
            continue
        try:
            number = str(row[3]).strip()
            when = iso_date(row[2])
            debit = money(row[10] or 0, allow_zero=True)
            credit = money(row[11] or 0, allow_zero=True)
            purpose = str(row[12] or "").strip()
            counterparty = str(row[4] or "").strip()
            if not re.fullmatch(r"[0-9]{20}", number) or min(debit, credit) < 0 or bool(debit) == bool(credit):
                raise ValueError()
            if not row[0] or not (purpose or counterparty):
                raise ValueError()
            # Document numbers recur. Use stable transaction fields and an occurrence
            # index so even two otherwise identical lines survive a complete export.
            signature = (str(row[0]), iso_date(row[1]), when, str(row[5] or ""),
                         str(row[6] or ""), str(row[9] or ""), credit - debit, purpose)
            counters[signature] += 1
            yield number, Operation((*signature, counters[signature]), when, purpose or counterparty,
                                    counterparty, (str(row[5] or ""), str(row[9] or ""), counterparty.casefold()),
                                    credit - debit)
        except (ValueError, TypeError, ArithmeticError) as exc:
            raise ValueError(f"Проверьте дату, номер счёта и сумму в строке {index} листа «Операции».") from exc


def read_totals(sheet, number, money):
    dates = []
    totals = {}
    account_found = False
    for row in sheet.iter_rows(max_row=25, max_col=4, values_only=True):
        label = str(row[1] or "").strip()
        account_found |= number in label
        found = re.findall(r"\d{2}\.\d{2}\.\d{4}", label)
        if not dates and len(found) == 2:
            dates = found
        if label in ("Входящий остаток", "Поступления", "Расходы", "Исходящий остаток"):
            totals[label] = money(row[3], allow_zero=True)
    if not account_found or len(dates) != 2 or len(totals) != 4:
        raise ValueError("Не удалось прочитать период и четыре итога на листе «Выписка».")
    return (iso_date(dates[0]), iso_date(dates[1]), totals["Входящий остаток"],
            totals["Поступления"], totals["Расходы"], totals["Исходящий остаток"])


def parse(raw, money):
    try:
        with ZipFile(BytesIO(raw)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 24_000_000:
                raise ValueError("Распакованный XLSX превышает 24 МБ. Разбейте выписку на периоды.")
        workbook = load_workbook(BytesIO(raw), data_only=True, read_only=True, keep_links=False)
        try:
            sheets = [s for s in workbook if s.title.startswith("Операции ")]
            if len(sheets) != 1:
                raise ValueError("Выберите XLSX Точки с листами «Операции» и «Выписка» одного счёта.")
            sheet = sheets[0]
            sheet.reset_dimensions()
            entries = list(read_operations(sheet, money))
            numbers = {number for number, _ in entries}
            if len(numbers) != 1:
                raise ValueError("В файле должны быть операции ровно одного счёта.")
            number = numbers.pop()
            totals_sheet = workbook[f"Выписка {number}"]
            totals_sheet.reset_dimensions()
            start, end, opening, incoming, outgoing, closing = read_totals(totals_sheet, number, money)
        finally:
            workbook.close()
    except (BadZipFile, InvalidFileException, ParseError, DefusedXmlException, KeyError, OSError,
            RuntimeError, NotImplementedError, ArithmeticError) as exc:
        raise ValueError("Не удалось прочитать XLSX Точки и его контрольные итоги.") from exc
    operations = [operation for _, operation in entries]
    if (not all(start <= operation.day <= end for operation in operations)
            or sum(max(operation.amount, 0) for operation in operations) != incoming
            or sum(max(-operation.amount, 0) for operation in operations) != outgoing
            or opening + incoming - outgoing != closing):
        raise ValueError("Операции не совпадают с периодом или итогами банковской выписки.")
    return Statement(number, start, end, opening, incoming, outgoing, closing, operations)


def hints(description, amount):
    purpose = description.casefold().replace("ё", "е").strip()
    if re.search(r"\b(?:депозит\w*|овернайт|между своими счетами|перевод собственных средств)\b", purpose):
        return None, None, "transfer"
    document = "advance" if re.search(r"\b(?:аванс\w*|предоплат\w*)\b", purpose) else None
    project = "Ро-бот" if re.search(r"\bро[– -]бот\b", purpose) else None
    article = None
    if amount < 0:
        if purpose.startswith("комиссия") or re.search(r"\bбанковская комиссия\b", purpose):
            return "Банковские комиссии", project or "Офис", document
        for pattern, category in (
            (r"единый налоговый платеж|^налог\s|страховые взносы", "Налоги"),
            (r"заработн\w+ плат|^зарплат", "ФОТ"),
            (r"\bдизайн\w*\b", "Дизайн"),
            (r"\bхостинг\w*\b", "Инфраструктура"),
            (r"\bаренд\w*\b.{0,32}\bофис\w*\b", "Офисные расходы"),
            (r"\bдивиденд\w*\b", "Дивиденды"),
        ):
            if re.search(pattern, purpose):
                article = category
                break
    elif re.search(r"\bлицензи\w*\b", purpose):
        article = "Лицензии"
    return article, project, document
