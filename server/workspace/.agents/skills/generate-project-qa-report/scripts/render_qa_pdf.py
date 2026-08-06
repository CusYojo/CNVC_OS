#!/usr/bin/env python3
"""把直接问答式 Markdown 报告渲染为正式中文 PDF。"""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import paragraph as reportlab_paragraph
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    KeepTogether,
    ListFlowable,
    ListItem,
    LongTable,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    TableStyle,
)

# ReportLab's default CJK kinsoku list omits several Simplified Chinese
# full-width punctuation marks. Extend it so punctuation cannot be stranded.
reportlab_paragraph.ALL_CANNOT_START += "，；：！？）》】”’％"


LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)]+)\)")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
CODE_RE = re.compile(r"`([^`]+)`")
Q_RE = re.compile(r"^##\s+Q(\d+)[：:]\s*(.+)$")
TABLE_TITLE_RE = re.compile(r"^表\s*\d+[：:]\s*.+$")
NOTE_RE = re.compile(r"^(?:来源|数据来源|注)[：:]\s*.+$")


def register_fonts() -> tuple[str, str, str, str, str]:
    regular_candidates = [
        (Path("/System/Library/Fonts/Supplemental/Songti.ttc"), 6),
        (Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"), 0),
        (Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"), 0),
        (Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"), 0),
    ]
    bold_candidates = [
        (Path("/System/Library/Fonts/STHeiti Medium.ttc"), 0),
        (Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"), 0),
        (Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"), 0),
        (Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"), 0),
    ]
    title_candidates = [
        (Path("/System/Library/Fonts/Supplemental/Songti.ttc"), 1),
        *bold_candidates,
    ]
    latin_candidates = [
        Path("/System/Library/Fonts/Supplemental/Times New Roman.ttf"),
        Path("/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf"),
        Path("/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf"),
    ]
    latin_bold_candidates = [
        Path("/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"),
        Path("/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold.ttf"),
        Path("/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf"),
    ]

    regular_choice = next(
        ((path, index) for path, index in regular_candidates if path.exists()),
        None,
    )
    bold_choice = next(
        ((path, index) for path, index in bold_candidates if path.exists()),
        None,
    )
    title_choice = next(
        ((path, index) for path, index in title_candidates if path.exists()),
        None,
    )
    latin_path = next((item for item in latin_candidates if item.exists()), None)
    latin_bold_path = next((item for item in latin_bold_candidates if item.exists()), None)
    if (
        regular_choice is None
        or bold_choice is None
        or title_choice is None
        or latin_path is None
        or latin_bold_path is None
    ):
        raise FileNotFoundError(
            "未找到必需的中文字体和 Times 兼容字体。请安装 Noto Serif/Sans CJK、"
            "Liberation Serif，或提供受支持的系统字体。"
        )

    regular_path, regular_index = regular_choice
    bold_path, bold_index = bold_choice
    title_path, title_index = title_choice
    pdfmetrics.registerFont(
        TTFont("QACJK", str(regular_path), subfontIndex=regular_index)
    )
    pdfmetrics.registerFont(
        TTFont("QACJK-Bold", str(bold_path), subfontIndex=bold_index)
    )
    pdfmetrics.registerFont(
        TTFont("QATitle", str(title_path), subfontIndex=title_index)
    )
    pdfmetrics.registerFontFamily(
        "QACJK",
        normal="QACJK",
        bold="QACJK-Bold",
        italic="QACJK",
        boldItalic="QACJK-Bold",
    )
    pdfmetrics.registerFont(TTFont("QALatin", str(latin_path)))
    pdfmetrics.registerFont(TTFont("QALatin-Bold", str(latin_bold_path)))
    pdfmetrics.registerFontFamily(
        "QALatin",
        normal="QALatin",
        bold="QALatin-Bold",
        italic="QALatin",
        boldItalic="QALatin-Bold",
    )
    return "QACJK", "QACJK-Bold", "QATitle", "QALatin", "QALatin-Bold"


LATIN_RUN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9&/+.,:%_™-]*")
TOKEN_RE = re.compile(r"@@QA_TOKEN_\d+@@")


def plain_markup(text: str, latin_font: str = "QALatin") -> str:
    parts = LATIN_RUN_RE.split(text)
    runs = LATIN_RUN_RE.findall(text)
    output: list[str] = []
    for index, part in enumerate(parts):
        escaped = html.escape(part)
        escaped = re.sub(
            r"([\u3400-\u9fff])([，。；：！？、）】》”’])",
            r"<nobr>\1\2</nobr>",
            escaped,
        )
        escaped = re.sub(
            r"([（【《“‘])([\u3400-\u9fff])",
            r"<nobr>\1\2</nobr>",
            escaped,
        )
        output.append(escaped)
        if index < len(runs):
            output.append(
                f'<nobr><font name="{latin_font}">{html.escape(runs[index])}</font></nobr>'
            )
    return "".join(output)


def inline_markup(
    text: str,
    latin_font: str = "QALatin",
    latin_bold_font: str = "QALatin-Bold",
) -> str:
    text = text.translate(str.maketrans({"—": "-", "–": "-", "‑": "-", "−": "-"}))
    tokens: list[tuple[str, str]] = []

    def stash(pattern: re.Pattern[str], replacement) -> None:
        nonlocal text

        def save(match: re.Match[str]) -> str:
            value = replacement(match)
            token = f"@@QA_TOKEN_{len(tokens)}@@"
            tokens.append((token, value))
            return token

        text = pattern.sub(save, text)

    stash(
        LINK_RE,
        lambda match: (
            f'<link href="{html.escape(match.group(2), quote=True)}" '
            f'color="#315B83"><u>{plain_markup(match.group(1), latin_font)}</u></link>'
        ),
    )
    stash(
        BOLD_RE,
        lambda match: f"<b>{plain_markup(match.group(1), latin_bold_font)}</b>",
    )
    stash(
        CODE_RE,
        lambda match: plain_markup(match.group(1), latin_font),
    )
    token_map = dict(tokens)
    return "".join(
        token_map.get(part, plain_markup(part, latin_font))
        for part in TOKEN_RE.split(text)
        if part
    ) if not tokens else "".join(
        token_map.get(part, plain_markup(part, latin_font))
        for part in re.split(f"({TOKEN_RE.pattern})", text)
        if part
    )


def visible_weight(text: str) -> float:
    clean = re.sub(r"\[[^\]]+\]\([^)]+\)", "", text)
    clean = re.sub(r"[*_`<>]", "", clean)
    return max(2.0, sum(1.0 if ord(char) < 128 else 1.75 for char in clean))


def table_widths(rows: list[list[str]], available: float) -> list[float]:
    columns = max(len(row) for row in rows)
    scores: list[float] = []
    for index in range(columns):
        values = [row[index] if index < len(row) else "" for row in rows]
        longest = max(visible_weight(value) for value in values)
        scores.append(min(24.0, max(5.0, longest)))
    total = sum(scores)
    widths = [available * score / total for score in scores]
    minimum = 28 * mm / 10
    widths = [max(minimum, width) for width in widths]
    scale = available / sum(widths)
    return [width * scale for width in widths]


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def plain_cell_text(text: str) -> str:
    text = LINK_RE.sub(r"\1", text)
    return re.sub(r"[*_`]", "", text).strip()


def is_numeric_cell(text: str) -> bool:
    value = plain_cell_text(text).replace(" ", "")
    return bool(
        re.fullmatch(
            r"[-+]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?"
            r"(?:%|万元|亿元|元|万|亿|年|月|日|Q\d|E)?",
            value,
        )
    )


def parse_table(lines: list[str], styles: dict[str, ParagraphStyle], available: float) -> LongTable:
    raw_rows: list[list[str]] = []
    for line in lines:
        stripped = line.strip().strip("|")
        raw_rows.append([cell.strip() for cell in stripped.split("|")])
    raw_rows = [row for row in raw_rows if not is_separator_row(row)]
    columns = max(len(row) for row in raw_rows)
    normalized = [row + [""] * (columns - len(row)) for row in raw_rows]

    data = []
    for row_index, row in enumerate(normalized):
        rendered_row = []
        for column_index, cell in enumerate(row):
            if row_index == 0:
                style = styles["table_header"]
            elif is_numeric_cell(cell):
                style = styles["table_numeric"]
            elif column_index > 0 and len(plain_cell_text(cell)) <= 4:
                style = styles["table_center"]
            else:
                style = styles["table"]
            rendered_row.append(
                Paragraph(
                    inline_markup(
                        cell,
                        "QALatin-Bold" if row_index == 0 else "QALatin",
                    ),
                    style,
                )
            )
        data.append(rendered_row)

    table = LongTable(
        data,
        colWidths=table_widths(normalized, available),
        repeatRows=1,
        hAlign="LEFT",
        splitByRow=1,
    )
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#3F5870")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "QACJK-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#AEB9C4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for row_index in range(1, len(data)):
        if row_index % 2 == 0:
            commands.append(("BACKGROUND", (0, row_index), (-1, row_index), colors.HexColor("#F3F6F8")))
    table.setStyle(TableStyle(commands))
    return table


def build_styles(regular: str, bold: str, title_font: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN",
            parent=base["Title"],
            fontName=title_font,
            fontSize=20,
            leading=24,
            alignment=TA_CENTER,
            wordWrap="CJK",
            textColor=colors.HexColor("#20364B"),
            spaceAfter=18,
        ),
        "q": ParagraphStyle(
            "QuestionCN",
            parent=base["Heading2"],
            fontName=bold,
            fontSize=14,
            leading=21,
            textColor=colors.HexColor("#26445F"),
            wordWrap="CJK",
            spaceBefore=12,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "SubheadingCN",
            parent=base["Heading3"],
            fontName=bold,
            fontSize=11,
            leading=18,
            textColor=colors.HexColor("#34495E"),
            wordWrap="CJK",
            spaceBefore=8,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=10.5,
            leading=20,
            alignment=TA_JUSTIFY,
            wordWrap="CJK",
            textColor=colors.HexColor("#222222"),
            firstLineIndent=2 * 10.5,
            spaceAfter=0,
            allowWidows=0,
            allowOrphans=0,
        ),
        "conclusion": ParagraphStyle(
            "ConclusionCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=10.5,
            leading=20,
            alignment=TA_JUSTIFY,
            wordWrap="CJK",
            textColor=colors.HexColor("#182E42"),
            backColor=colors.HexColor("#EEF3F7"),
            borderColor=colors.HexColor("#9FB2C3"),
            borderWidth=0.6,
            borderPadding=7,
            spaceAfter=6,
        ),
        "bullet": ParagraphStyle(
            "BulletCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=10.5,
            leading=18,
            alignment=TA_LEFT,
            wordWrap="CJK",
            leftIndent=0,
            firstLineIndent=0,
            spaceAfter=0,
        ),
        "quote": ParagraphStyle(
            "QuoteCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=10,
            leading=18,
            leftIndent=10,
            rightIndent=5,
            wordWrap="CJK",
            borderColor=colors.HexColor("#7E95AA"),
            borderWidth=0,
            borderLeft=2,
            borderPadding=6,
            textColor=colors.HexColor("#536273"),
            backColor=colors.HexColor("#F7F9FA"),
            spaceAfter=6,
        ),
        "table": ParagraphStyle(
            "TableCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=9,
            leading=14,
            alignment=TA_LEFT,
            wordWrap="CJK",
            textColor=colors.HexColor("#222222"),
        ),
        "table_title": ParagraphStyle(
            "TableTitleCN",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=10.5,
            leading=16,
            alignment=TA_CENTER,
            wordWrap="CJK",
            textColor=colors.HexColor("#273B4D"),
            spaceBefore=4,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "note": ParagraphStyle(
            "SourceNoteCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=9,
            leading=14,
            alignment=TA_LEFT,
            wordWrap="CJK",
            textColor=colors.HexColor("#667684"),
            spaceBefore=2,
            spaceAfter=6,
        ),
        "table_center": ParagraphStyle(
            "TableCenterCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=9,
            leading=14,
            alignment=TA_CENTER,
            wordWrap="CJK",
            textColor=colors.HexColor("#222222"),
        ),
        "table_numeric": ParagraphStyle(
            "TableNumericCN",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=9,
            leading=14,
            alignment=TA_RIGHT,
            wordWrap="CJK",
            textColor=colors.HexColor("#222222"),
        ),
        "table_header": ParagraphStyle(
            "TableHeaderCN",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=9,
            leading=14,
            alignment=TA_CENTER,
            wordWrap="CJK",
            textColor=colors.white,
        ),
    }


def markdown_story(markdown: str, styles: dict[str, ParagraphStyle], available: float):
    lines = markdown.splitlines()
    story = []
    index = 0
    pending_list: list[tuple[str, str]] = []

    def flush_list() -> None:
        nonlocal pending_list
        if not pending_list:
            return
        ordered = pending_list[0][0] == "ordered"
        items = [
            ListItem(Paragraph(inline_markup(text), styles["bullet"]), leftIndent=9)
            for _, text in pending_list
        ]
        list_options = {
            "bulletType": "1" if ordered else "bullet",
            "leftIndent": 14,
            "bulletFontName": "QACJK",
            "bulletFontSize": 9,
            "spaceAfter": 0,
        }
        if ordered:
            list_options["start"] = "1"
        else:
            list_options["start"] = "-"
        story.append(ListFlowable(items, **list_options))
        pending_list = []

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if not stripped:
            flush_list()
            index += 1
            continue

        if stripped.startswith("|") and "|" in stripped[1:]:
            flush_list()
            table_lines = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index])
                index += 1
            story.extend([Spacer(1, 3), parse_table(table_lines, styles, available), Spacer(1, 7)])
            continue

        unordered = re.match(r"^[-*]\s+(.+)$", stripped)
        ordered = re.match(r"^\d+[.、]\s+(.+)$", stripped)
        if unordered or ordered:
            match = unordered or ordered
            pending_list.append(("ordered" if ordered else "bullet", match.group(1)))
            index += 1
            continue
        flush_list()

        if stripped.startswith("# "):
            story.append(
                Paragraph(
                    inline_markup(stripped[2:].strip(), "QALatin-Bold"),
                    styles["title"],
                )
            )
        elif Q_RE.match(stripped):
            question_match = Q_RE.match(stripped)
            if question_match and int(question_match.group(1)) > 1:
                story.append(CondPageBreak(120 * mm))
            next_index = index + 1
            while next_index < len(lines) and not lines[next_index].strip():
                next_index += 1
            if next_index < len(lines):
                next_text = lines[next_index].strip()
                if next_text.startswith("**结论：**") or next_text.startswith("**结论:**"):
                    story.append(
                        KeepTogether(
                            [
                                Paragraph(
                                    inline_markup(stripped[3:].strip(), "QALatin-Bold"),
                                    styles["q"],
                                ),
                                Paragraph(inline_markup(next_text), styles["conclusion"]),
                            ]
                        )
                    )
                    index = next_index
                else:
                    story.append(
                        Paragraph(
                            inline_markup(stripped[3:].strip(), "QALatin-Bold"),
                            styles["q"],
                        )
                    )
            else:
                story.append(
                    Paragraph(
                        inline_markup(stripped[3:].strip(), "QALatin-Bold"),
                        styles["q"],
                    )
                )
        elif stripped.startswith("### "):
            story.append(CondPageBreak(105 * mm))
            story.append(
                Paragraph(
                    inline_markup(stripped[4:].strip(), "QALatin-Bold"),
                    styles["h3"],
                )
            )
        elif TABLE_TITLE_RE.match(stripped):
            story.append(
                Paragraph(
                    inline_markup(stripped, "QALatin-Bold"),
                    styles["table_title"],
                )
            )
        elif NOTE_RE.match(stripped):
            story.append(Paragraph(inline_markup(stripped), styles["note"]))
        elif stripped.startswith("> "):
            story.append(KeepTogether([Paragraph(inline_markup(stripped[2:].strip()), styles["quote"])]))
        elif stripped.startswith("**结论：**") or stripped.startswith("**结论:**"):
            story.append(KeepTogether([Paragraph(inline_markup(stripped), styles["conclusion"])]))
        elif stripped in {"---", "***"}:
            story.append(Spacer(1, 6))
        else:
            story.append(KeepTogether([Paragraph(inline_markup(stripped), styles["body"])]))
        index += 1

    flush_list()
    return story


def draw_page(canvas, doc) -> None:
    canvas.saveState()
    page_width, page_height = A4
    if doc.page > 1:
        canvas.setStrokeColor(colors.HexColor("#C5CDD4"))
        canvas.setLineWidth(0.35)
        canvas.line(doc.leftMargin, page_height - 20 * mm, page_width - doc.rightMargin, page_height - 20 * mm)
        canvas.setFont("QACJK", 9)
        canvas.setFillColor(colors.HexColor("#647484"))
        canvas.drawString(doc.leftMargin, page_height - 16 * mm, doc.header_text)
    canvas.setFont("QACJK", 9)
    canvas.setFillColor(colors.HexColor("#788692"))
    canvas.drawRightString(page_width - doc.rightMargin, 16 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def render(markdown_path: Path, output_path: Path) -> None:
    markdown = markdown_path.read_text(encoding="utf-8")
    h1 = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
    if not h1:
        raise ValueError("Markdown 必须包含报告一级标题。")
    if not re.search(r"^##\s+Q1[：:]", markdown, re.MULTILINE):
        raise ValueError("Markdown 必须包含直接进入的 Q1 章节。")

    regular, bold, title_font, _, _ = register_fonts()
    styles = build_styles(regular, bold, title_font)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    doc = BaseDocTemplate(
        str(output_path),
        pagesize=A4,
        leftMargin=31.8 * mm,
        rightMargin=30 * mm,
        topMargin=27 * mm,
        bottomMargin=28 * mm,
        title=h1.group(1).strip(),
        author="Codex",
        subject="项目 Q&A 报告",
    )
    project_name = re.sub(
        r"(?:(?:标准版)?(?:内部版?|仅供内部使用)?\s*)?Q&A\s*报告$",
        "",
        h1.group(1).strip(),
    ).strip()
    doc.header_text = f"{project_name}｜Q&A"
    frame = Frame(
        doc.leftMargin,
        doc.bottomMargin,
        doc.width,
        doc.height,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
        id="qa-content",
    )
    doc.addPageTemplates(
        [
            PageTemplate(
                id="qa-pages",
                frames=[frame],
                onPage=draw_page,
                pagesize=A4,
            )
        ]
    )
    story = markdown_story(markdown, styles, doc.width)
    doc.build(story)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", type=Path, help="已经校验的直接问答式 Markdown 输入。")
    parser.add_argument("pdf", type=Path, help="输出 PDF 路径。")
    args = parser.parse_args()
    render(args.markdown.resolve(), args.pdf.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
