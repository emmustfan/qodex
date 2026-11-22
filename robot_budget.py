"""Read the saved forecast values from the three Ro-bot scenario worksheets."""

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from defusedxml.common import DefusedXmlException
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.utils.exceptions import InvalidFileException

SOURCE = "robot-xlsx"
SCENARIO_SHEETS = {
    "Консервативный": "Сценарий 50",
    "Базовый": "Сценарий 75",
    "Оптимистичный": "Сценарий 100",
}
MONTH_NAMES = "янв фев мар апр май июн июл авг сен окт ноя дек".split()
PERIODS = ["2026-11", "2026-12"] + [f"2027-{month:02}" for month in range(1, 13)]
OPERATING_ROWS = {
    14: ("Текущие клиенты", "Лицензии"),
    15: ("Новые клиенты: первый платёж", "Лицензии"),
    16: ("Новые клиенты: остаток", "Лицензии"),
    17: ("Продления лицензий", "Лицензии"),
    21: ("Эмиль: долг", "ФОТ"),
    22: ("Эмиль: процент", "Продажи"),
    23: ("Артур (разработка)", "Разработка"),
    24: ("Техподдержка", "Поддержка"),
    25: ("Помощник руководителя", "ФОТ"),
    26: ("Инфраструктура", "Инфраструктура"),
    27: ("Продажи, продвижение", "Продажи"),
    28: ("Накладные", "Офисные расходы"),
    29: ("Прямые расходы на клиентов", "Прямые расходы на клиентов"),
    30: ("Налоги", "Налоги"),
    31: ("Данил: работа", "ФОТ"),
}
FINANCING_ROWS = {40: ("Возврат Данилу", "Финансирование"), 41: ("Дивиденды", "Дивиденды")}


def parse_workbook(raw, include_financing):
    try:
        with ZipFile(BytesIO(raw)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 12_000_000:
                raise ValueError("Распакованный Excel-файл превышает 12 МБ.")
        workbook = load_workbook(BytesIO(raw), data_only=True, read_only=True, keep_links=False)
        try:
            return list(read_scenarios(workbook, include_financing))
        finally:
            workbook.close()
    except (BadZipFile, InvalidFileException, ParseError, DefusedXmlException, KeyError, OSError, RuntimeError, NotImplementedError) as exc:
        raise ValueError("Не удалось прочитать книгу XLSX.") from exc


def read_scenarios(workbook, include_financing):
    mapping = OPERATING_ROWS | (FINANCING_ROWS if include_financing else {})
    for scenario, name in SCENARIO_SHEETS.items():
        if name not in workbook:
            raise ValueError(f"В книге отсутствует лист «{name}».")
        sheet = workbook[name]
        cells = list(sheet.iter_rows(min_row=1, max_row=max(mapping), min_col=1, max_col=22))
        for row, (label, _) in mapping.items():
            if not str(cells[row - 1][0].value).startswith(label):
                raise ValueError(f"Проверьте структуру листа «{name}», строка {row}.")
        for column, period in enumerate(PERIODS, 8):
            year, month = period.split("-")
            expected = f"{MONTH_NAMES[int(month)-1]} {year[-2:]}"
            if cells[4][column].value != expected or cells[5][column].value != "прогноз":
                raise ValueError(f"Ожидалась колонка прогноза «{expected}» на листе «{name}».")
            totals = defaultdict(Decimal)
            for row, (_, article) in mapping.items():
                value = cells[row - 1][column].value
                location = f"{get_column_letter(column + 1)}{row}"
                if type(value) not in (int, float):
                    raise ValueError(f"Нет рассчитанного числа в «{name}» ({location}). Пересчитайте и сохраните Excel-файл.")
                number = Decimal(str(value))
                if not number.is_finite() or abs(number) > 100_000_000_000:
                    raise ValueError(f"Проверьте сумму в «{name}» ({location}).")
                totals[article] += number if row < 18 else -number
            for article, amount in totals.items():
                cents = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                if cents:
                    yield period, article, cents, scenario
