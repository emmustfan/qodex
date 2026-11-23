"""Produce a spreadsheet from the already selected report rows."""

import math
from io import BytesIO

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font

REPORTS = {"cash": "БДДС", "profit": "БДР", "distribution": "Прибыль"}


def excel_text(value, length):
    return ILLEGAL_CHARACTERS_RE.sub("", value)[:length]


def workbook(payload):
    report = payload["report"]
    if report not in REPORTS:
        raise ValueError("Выберите финансовый отчёт.")
    sheets = payload["sheets"]
    if not isinstance(sheets, list) or not 1 <= len(sheets) <= 5:
        raise ValueError("Нет отчёта для выгрузки.")
    book = Workbook()
    book.remove(book.active)
    for index, sheet in enumerate(sheets, 1):
        heading, rows = sheet["heading"], sheet["rows"]
        if not isinstance(heading, str) or not isinstance(rows, list) or len(rows) > 10_000:
            raise ValueError("Проверьте данные отчёта.")
        out = book.create_sheet(REPORTS[report] + (f" {index}" if index > 1 else ""))
        out.append([excel_text(heading, 200)])
        out["A1"].data_type = "s"
        out["A1"].font = Font(bold=True)
        out.append([excel_text(str(payload["scope"]), 500)])
        out["A2"].data_type = "s"
        for number, row in enumerate(rows, 3):
            if not isinstance(row, list) or len(row) > 20:
                raise ValueError("Проверьте столбцы отчёта.")
            for column, value in enumerate(row, 1):
                if isinstance(value, str):
                    cell = out.cell(number, column, excel_text(value, 1000))
                    cell.data_type = "s"  # Literal content, including labels starting with =.
                elif type(value) in (int, float) and math.isfinite(value):
                    out.cell(number, column, value).number_format = '#,##0.00;[Red]-#,##0.00'
                else:
                    raise ValueError("Проверьте значения отчёта.")
        out.freeze_panes = "B4"
        out.column_dimensions["A"].width = 48
        for column in "BCDEFGHIJKLMNOPQRST":
            out.column_dimensions[column].width = 21
    output = BytesIO()
    book.save(output)
    return output.getvalue()
