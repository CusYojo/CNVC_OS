#!/usr/bin/env python3
"""Validate a Chinese investment due-diligence report DOCX."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import re
from pathlib import Path
import sys
import zipfile
from xml.etree import ElementTree as ET

sys.dont_write_bytecode = True

from runtime_bootstrap import ensure_runtime


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
Q = lambda name: f"{{{W}}}{name}"


STRICT_TABLE_HEADERS: list[list[str | None]] = [
    [r"公司名称", None],
    [r"投资主体", None],
    [r"行业所处发展阶段", None],
    [r"商业路径", None],
    [r"投资价值", None],
    [r"公司名称", None],
    [r"时间", r"事项", r"注册资本/融资"],
    [r"股东", r"认缴注册资本（万元）", r"持股比例"],
    [r"主体", r"上层持有人或合伙人", r"穿透要点"],
    [r"(?:组织架构图|部门)", r"(?:|人员配置)", r"(?:|主要职责)"],
    [r"关联主体或事项", r"关联关系及投资相关情况"],
    [r"类别", r"资质、认证或荣誉情况"],
    [r"核心产品", r"产品定义/核心功能", r"应用场景/目标客户", r"商业化进展"],
    [r"核心技术", r"技术描述/原理", r"技术来源/权属", r"技术门槛/产品作用"],
    [r"(?:应用场景|场景)", r"(?:解决方案|解决问题)"],
    [r"年份", r"代表成果", r"(?:对现有产品/技术的作用|与公司技术路线的关系)"],
    [r"(?:知识产权类别|事项)", r"(?:权属及进展|截至报告日情况)"],
    [r"(?:业务板块|产品/服务|产品线|技术/产品)", r"(?:主要产品/服务|收费模式|销售模式|授权方式)", r"(?:收入来源|获客方式|交付方式|收费方式)", r"(?:销售与交付方式|交付与续费|收入构成|客户类型)"],
    [r"主要成本项", r"(?:成本构成/采购情况|金额/合同)"],
    [r"细分市场", r"近期机会", r"中期空间"],
    [r"阶段", r"研发目标", r"商业目标", r"组织目标"],
    [r"人员类别", r"20\d{2}E"],
    [r"单位：?万元", r"20\d{2}.*"],
    [r"营业收入构成", r"20\d{2}E"],
    [r"投资亮点", r"业务基础", r"投资价值"],
    [r"退出路径", r"实现条件"],
    [r"风险类别", r"具体风险描述", r"风险控制安排"],
]

VISIBLE_EVIDENCE_ID_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:SRC|CLAIM)[-_ ]?(?:\d{3,}|x{3,})"
)
UNAUTHORIZED_PREFACE_PATTERN = re.compile(
    r"(?:报告基础与范围|编制基础与范围|报告编制说明|证据口径)"
)
UNAUTHORIZED_JUDGMENT_PATTERN = re.compile(
    r"^(?:行业|项目|模块|本节|本模块|专项)(?:综合)?判断"
)
UNAUTHORIZED_SOURCE_APPENDIX_PATTERN = re.compile(
    r"^(?:附件与证据|资料来源与证据|证据来源索引|资料来源索引|证据索引)"
)
RECOMMENDATION_REPORT_STAGE = "investment-recommendation"
FINAL_REPORT_STAGE = "final-investment-decision"
IN_PROGRESS_REPORT_STAGE = "dd-in-progress"
TERMINAL_REPORT_STAGES = {RECOMMENDATION_REPORT_STAGE, FINAL_REPORT_STAGE}
OPEN_DD_LANGUAGE_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "pending_verification",
        re.compile(r"(?:待|有待)(?:核验|验证|确认|复核|补充|访谈|取得|厘清|测算)"),
    ),
    (
        "open_follow_up",
        re.compile(
            r"(?:仍需|尚需|需进一步|后续需|最终仍应)[^。；\n]{0,48}"
            r"(?:核验|验证|确认|复核|补充|取得|判断|测算|整改|关注|跟踪|审阅)"
        ),
    ),
    (
        "advisory_action",
        re.compile(
            r"建议[^。；\n]{0,24}(?:补充|核验|验证|确认|取得|复核|关注|跟踪|整改|"
            r"纳入|设置|推进|完成|实施)[^。；\n]{0,24}"
        ),
    ),
    (
        "transaction_unsettled",
        re.compile(
            r"(?:方案|交易结构|投资主体|投资金额|拟投金额|投前估值|投后估值|投后股比)"
            r"[^。；\n]{0,16}(?:尚未|仍未|待)(?:确定|明确|确认)"
        ),
    ),
    (
        "evidence_gap_narration",
        re.compile(r"(?:资料|材料)(?:尚)?未(?:提供|取得)[^。；\n]{0,32}(?:核验|判断|确认|测算|证明)?"),
    ),
    (
        "refusal_to_judge",
        re.compile(r"(?:不能|无法)(?:直接)?(?:证明|据此判断|据此推演|核对|测算|形成结论)"),
    ),
    (
        "unsettled_contingency",
        re.compile(
            r"(?:若|如)[^。；\n]{0,48}(?:未达标|不满足)[^。；\n]{0,48}"
            r"(?:延期投资|降低估值|分期付款|暂缓)"
        ),
    ),
)
ADVISORY_INVESTMENT_CONCLUSION_PATTERN = re.compile(
    r"建议[^。；\n]{0,48}(?:推进|完成|实施)[^。；\n]{0,16}投资"
)
DECISIVE_INVESTMENT_CONCLUSION_PATTERN = re.compile(
    r"(?:本轮|本次)[^。；\n]{0,48}投资[^。；\n]{0,80}"
    r"(?:投前估值|投后估值|交易结构|投后持股|投后权益)"
)
FORMULAIC_APPROVAL_CONCLUSION_PATTERN = re.compile(
    r"本项目投资结论为同意|同意按照[^。；\n]{0,80}实施投资|"
    r"原则上同意|有条件同意"
)
SUMMARY_NEGATIVE_METRIC_PATTERN = re.compile(
    r"(?:净亏损|亏损)[^。；\n]{0,12}[-－—]?\s*\d+(?:\.\d+)?\s*万元?"
    r"|(?:经营现金流|经营性现金流|标准化经营现金流)[^。；\n]{0,16}[-－—]\s*\d+(?:\.\d+)?\s*万元?"
)
IMMATERIAL_PERSONAL_AMOUNT_PATTERN = re.compile(
    r"(?P<context>[^。；\n]{0,24}(?:报销|垫付|个人往来|借款)[^。；\n]{0,24})"
    r"(?P<amount>\d+(?:\.\d+)?)\s*元"
    r"|(?P<amount_first>\d+(?:\.\d+)?)\s*元"
    r"(?P<context_after>[^。；\n]{0,24}(?:报销|垫付|个人往来|借款)[^。；\n]{0,24})"
)
GENERIC_DEFENSIVE_JUDGMENT_PATTERN = re.compile(
    r"(?:行业关注度|政策|同业融资)[^。；\n]{0,48}"
    r"(?:不能直接证明|无法证明)[^。；\n]{0,48}(?:份额|估值|价值)"
)
INVESTMENT_THESIS_DEFENSIVE_PATTERN = re.compile(
    r"(?:[，；。]但|但(?:行业|公司|仍|尚|需|不能|无法|取决于)|仍需|取决于|"
    r"建议(?:核验|验证|补充|确认)|不能直接证明|无法证明)"
)
DECISION_LAYER_META_LANGUAGE_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "source_process",
        re.compile(
            r"(?:根据|据)[^。；\n]{0,24}(?:资料|材料|报告|台账|访谈|花名册)"
            r"(?:显示|列示|确认|记载|判断|采用|披露)?"
        ),
    ),
    (
        "due_diligence_process",
        re.compile(
            r"(?:经|通过)?(?:法律|财务|业务|商业|技术)?(?:尽调|勾稽|核验)"
            r"(?:已)?(?:确认|判断|认定|显示|采用)"
        ),
    ),
    (
        "investment_team_narrator",
        re.compile(r"投资团队(?:据此)?(?:认为|判断|采用|确认)"),
    ),
    (
        "report_narrator",
        re.compile(r"(?:本报告|本文)(?:仅|只|将|采用|按照|以)"),
    ),
    (
        "decision_basis_process",
        re.compile(
            r"(?:本次|本轮|本报告|本文|投资团队)[^。；\n]{0,16}"
            r"(?:采用|使用|按)[^。；\n]{0,32}口径"
        ),
    ),
)
EXCLUSIONARY_DECISION_LANGUAGE_PATTERN = re.compile(
    r"(?:不纳入|不计入|不使用|不将)"
    r"|(?:本次|本轮|本报告|本文)(?:仅|只)(?:以|将|把|采用|使用)"
)
SIMULATED_POST_INVESTMENT_PATTERN = re.compile(
    r"模拟(?:投后|认缴|注册资本|持股|股权)"
)
RISK_STATUS_META_PATTERN = re.compile(
    r"状态\s*[:：]?\s*(?:为)?\s*(?:已接受|已落实|交易文件约定|交割条件|投后事项)"
)
TRANSACTION_EXECUTION_META_PATTERN = re.compile(
    r"(?:付款|支付|交割|工商变更|交易实施)[^。；\n]{0,28}口径(?:执行|办理|实施)"
    r"|按[^。；\n]{0,36}口径(?:执行|办理|实施)"
)
VISIBLE_REASONING_LABEL_PATTERN = re.compile(
    r"(?:中心判断|事实基础|分析判断|投资影响)\s*[:：]"
)
FORMULAIC_AI_SUMMARY_PATTERN = re.compile(
    r"(?:核心|投资)?逻辑由[一二三四五六七八九十\d]+项(?:事实|逻辑|理由)(?:共同)?构成"
)
ASSOCIATION_RISK_NARRATIVE_PATTERN = re.compile(
    r"(?:避免|防范|防止)[^。；\n]{0,36}(?:竞业|时间投入|利益|权利|治理)?冲突"
    r"|相关不利后果"
)
BUSINESS_VALIDATION_HEADER_PATTERN = re.compile(r"^(?:商业验证|关键验证)$")
RECOMMENDATION_RISK_DUMP_TERMS = (
    "风险",
    "交割条件",
    "保护条款",
    "赔偿",
    "回购",
    "反稀释",
    "优先清算",
    "控制安排",
    "投后责任",
)


def normalized_text(value: str) -> str:
    """Normalize harmless Word line wrapping without weakening semantic checks."""
    return re.sub(r"\s+", "", value).replace("(", "（").replace(")", "）")


def open_dd_language_hits(value: str) -> list[dict[str, str]]:
    """Return final-report phrases that narrate unfinished due-diligence work."""
    hits: list[dict[str, str]] = []
    for label, pattern in OPEN_DD_LANGUAGE_RULES:
        for match in pattern.finditer(value):
            start = max(0, match.start() - 24)
            end = min(len(value), match.end() + 40)
            hits.append(
                {
                    "rule": label,
                    "match": match.group(0),
                    "context": re.sub(r"\s+", "", value[start:end]),
                }
            )
    return hits


def decision_layer_meta_language_hits(value: str) -> list[dict[str, str]]:
    """Return visible source/process narration that belongs in the audit layer."""
    hits: list[dict[str, str]] = []
    for label, pattern in DECISION_LAYER_META_LANGUAGE_RULES:
        for match in pattern.finditer(value):
            start = max(0, match.start() - 24)
            end = min(len(value), match.end() + 40)
            hits.append(
                {
                    "rule": label,
                    "match": match.group(0),
                    "context": re.sub(r"\s+", "", value[start:end]),
                }
            )
    return hits


def strict_table_header_matches(
    table_number: int,
    actual: list[str],
    expected: list[str | None],
) -> bool:
    """Match stable visual roles while allowing only supported forecast years."""
    if table_number in {22, 24}:
        return (
            2 <= len(actual) <= 6
            and bool(re.fullmatch(expected[0] or r"$^", actual[0]))
            and all(re.fullmatch(r"20\d{2}E", cell) for cell in actual[1:])
        )
    if table_number == 23:
        return (
            2 <= len(actual) <= 7
            and bool(re.fullmatch(r"(?:单位：?万元|项目)", actual[0]))
            and all(
                re.fullmatch(
                    r"20\d{2}(?:年[^\s]{0,12}|A|H[12]A?|Q[1-4]A?)?",
                    cell,
                )
                for cell in actual[1:]
            )
        )
    return len(actual) == len(expected) and all(
        pattern is None or re.fullmatch(pattern, cell)
        for pattern, cell in zip(expected, actual)
    )


def transaction_terms_are_concrete(value: str) -> bool:
    """Require at least one amount/valuation term bound to a numeric value."""
    return bool(
        re.search(
            r"(?:投资金额|拟投金额|增资金额|老股金额|投前估值|投后估值|"
            r"(?:投资|增资|受让)[^。；\n]{0,12})"
            r"[^。；\n]{0,32}\d",
            value,
        )
    )


def recommendation_terms_are_complete(value: str) -> bool:
    """Require the recommendation paragraph to state all transaction essentials."""
    patterns = (
        r"(?:投资主体|由[^。；\n]{1,40}(?:基金|合伙企业|投资机构|投资主体)|(?:基金|合伙企业|投资公司)[^。；\n]{0,16}(?:以|投资|增资))",
        r"(?:投资金额|拟投金额|增资金额|(?:投资|增资|受让)[^。；\n]{0,12}\d|以[^。；\n]{0,16}\d+(?:\.\d+)?\s*(?:万元|亿元)[^。；\n]{0,12}(?:投资|增资|受让))",
        r"(?:投前估值|投后估值)[^。；\n]{0,32}\d",
        r"(?:增资|老股转让|股权受让|增资并受让老股|交易结构)",
        r"(?:投后持股|投后持股比例|投后权益)[^。；\n]{0,48}(?:\d|计算|确定|区间)",
    )
    return all(re.search(pattern, value) for pattern in patterns)


def row_cells(row: ET.Element) -> list[str]:
    return [normalized_text(text_of(cell)) for cell in row.findall("w:tc", NS)]


def table_rows(table: ET.Element) -> list[list[str]]:
    return [row_cells(row) for row in table.findall("w:tr", NS)]


def issue(code: str, message: str, location: str) -> dict[str, str]:
    return {"code": code, "message": message, "location": location}


def text_of(node: ET.Element) -> str:
    return "".join(item.text or "" for item in node.findall(".//w:t", NS)).strip()


def style_map(styles: ET.Element) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for style in styles.findall("w:style", NS):
        style_id = style.get(Q("styleId"), "")
        name = style.find("w:name", NS)
        if style_id and name is not None:
            mapping[style_id] = name.get(Q("val"), style_id)
    return mapping


def _bool_property(rpr: ET.Element | None, name: str) -> bool | None:
    if rpr is None:
        return None
    node = rpr.find(f"w:{name}", NS)
    if node is None:
        return None
    return node.get(Q("val"), "1").lower() not in {"0", "false", "off"}


def _run_properties(rpr: ET.Element | None) -> dict[str, object]:
    if rpr is None:
        return {}
    result: dict[str, object] = {}
    fonts = rpr.find("w:rFonts", NS)
    if fonts is not None:
        for key in ("eastAsia", "ascii", "hAnsi", "cs", "eastAsiaTheme", "asciiTheme", "hAnsiTheme"):
            value = fonts.get(Q(key))
            if value:
                result[key] = value
    size = rpr.find("w:sz", NS)
    if size is not None and size.get(Q("val")):
        result["size_pt"] = int(size.get(Q("val"), "0")) / 2
    bold = _bool_property(rpr, "b")
    if bold is not None:
        result["bold"] = bold
    return result


def _style_definitions(styles: ET.Element) -> tuple[dict[str, dict[str, object]], dict[str, object]]:
    definitions: dict[str, dict[str, object]] = {}
    for style in styles.findall("w:style", NS):
        style_id_value = style.get(Q("styleId"), "")
        based_on = style.find("w:basedOn", NS)
        definitions[style_id_value] = {
            "based_on": based_on.get(Q("val")) if based_on is not None else None,
            "properties": _run_properties(style.find("w:rPr", NS)),
        }
    defaults = _run_properties(styles.find("./w:docDefaults/w:rPrDefault/w:rPr", NS))
    return definitions, defaults


def _style_chain(style_id_value: str, definitions: dict[str, dict[str, object]]) -> list[str]:
    chain: list[str] = []
    seen: set[str] = set()
    current = style_id_value
    while current and current not in seen and current in definitions:
        seen.add(current)
        chain.append(current)
        based_on = definitions[current].get("based_on")
        current = str(based_on) if based_on else ""
    return list(reversed(chain))


def effective_run_properties(
    paragraph: ET.Element,
    run: ET.Element,
    definitions: dict[str, dict[str, object]],
    defaults: dict[str, object],
    fallback_size_pt: float,
) -> dict[str, object]:
    result = dict(defaults)
    for item in _style_chain(style_id(paragraph), definitions):
        result.update(definitions[item].get("properties", {}))
    result.update(_run_properties(paragraph.find("./w:pPr/w:rPr", NS)))
    result.update(_run_properties(run.find("w:rPr", NS)))
    result["font"] = (
        result.get("eastAsia")
        or result.get("ascii")
        or result.get("hAnsi")
        or result.get("eastAsiaTheme")
        or result.get("asciiTheme")
        or result.get("hAnsiTheme")
        or ""
    )
    result["size_pt"] = float(result.get("size_pt", fallback_size_pt))
    result["bold"] = bool(result.get("bold", False))
    return result


def visible_runs(paragraph: ET.Element) -> list[ET.Element]:
    return [
        run
        for run in paragraph.findall("w:r", NS)
        if normalized_text(text_of(run))
    ]


def load_style_profile(path: Path | None = None) -> dict[str, object]:
    profile_path = path or Path(__file__).resolve().parents[1] / "assets" / "style-profile.json"
    return json.loads(profile_path.read_text(encoding="utf-8"))


def load_table_layout_profile(path: Path | None = None) -> dict[str, object]:
    profile_path = path or Path(__file__).resolve().parents[1] / "assets" / "table-layout-profile.json"
    return json.loads(profile_path.read_text(encoding="utf-8"))


def _table_contract(
    table_number: int,
    profile: dict[str, object],
) -> dict[str, object]:
    item = next(
        (
            candidate
            for candidate in profile.get("tables", [])
            if int(candidate.get("number", -1)) == table_number
        ),
        None,
    )
    if item is None:
        raise ValueError(f"table {table_number} is absent from the table-layout profile")
    role_name = str(item["role"])
    contract = dict(profile.get("roles", {}).get(role_name, {}))
    contract.update(item)
    contract["role"] = role_name
    defaults = dict(profile.get("defaults", {}))
    for key in (
        "label_paragraph_spacing",
        "header_paragraph_spacing",
        "body_paragraph_spacing",
    ):
        if key not in contract and key in defaults:
            contract[key] = defaults[key]
    contract["long_row_chars"] = int(
        contract.get("long_row_chars", defaults.get("long_row_chars", 80))
    )
    return contract


def _cell_fill(cell: ET.Element) -> str | None:
    shade = cell.find("./w:tcPr/w:shd", NS)
    if shade is None:
        return None
    value = shade.get(Q("fill"))
    return value.upper() if value else None


def _cell_alignment_values(cell: ET.Element) -> list[str]:
    values: list[str] = []
    for paragraph in cell.findall("w:p", NS):
        if not normalized_text(text_of(paragraph)):
            continue
        alignment = paragraph.find("./w:pPr/w:jc", NS)
        values.append(alignment.get(Q("val"), "") if alignment is not None else "")
    return values


def _cell_format_is_explicit(cell: ET.Element) -> bool:
    for paragraph in cell.findall("w:p", NS):
        if not normalized_text(text_of(paragraph)):
            continue
        if paragraph.find("w:pPr", NS) is None:
            return False
        for run in visible_runs(paragraph):
            if run.find("w:rPr", NS) is None:
                return False
    return True


def _expected_paragraph_spacing(
    contract: dict[str, object], row_index: int, column_index: int
) -> dict[str, str]:
    role = str(contract["role"])
    if role.startswith("key_value"):
        key = (
            "label_paragraph_spacing"
            if column_index in set(contract.get("label_columns", [0]))
            else "body_paragraph_spacing"
        )
    elif row_index in set(int(item) for item in contract.get("header_rows", [0])):
        key = "header_paragraph_spacing"
    else:
        key = "body_paragraph_spacing"
    value = contract.get(key, {})
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


def _cell_spacing_matches(cell: ET.Element, expected: dict[str, str]) -> bool:
    if not expected:
        return True
    attributes = {
        "line": Q("line"),
        "line_rule": Q("lineRule"),
        "before": Q("before"),
        "after": Q("after"),
    }
    for paragraph in cell.findall("w:p", NS):
        if not normalized_text(text_of(paragraph)):
            continue
        spacing = paragraph.find("./w:pPr/w:spacing", NS)
        if spacing is None:
            return False
        for key, expected_value in expected.items():
            attribute = attributes.get(key)
            if attribute is not None and spacing.get(attribute) != expected_value:
                return False
    return True


def _cell_bold_values(
    cell: ET.Element,
    definitions: dict[str, dict[str, object]],
    defaults: dict[str, object],
    fallback_size_pt: float,
) -> list[bool]:
    values: list[bool] = []
    for paragraph in cell.findall("w:p", NS):
        for run in visible_runs(paragraph):
            properties = effective_run_properties(
                paragraph,
                run,
                definitions,
                defaults,
                fallback_size_pt,
            )
            values.append(bool(properties["bold"]))
    return values


def _expected_header_style(
    contract: dict[str, object],
    row_index: int,
) -> tuple[str | None, str, bool]:
    for specification in contract.get("header_row_styles", []):
        if int(specification.get("row", -1)) == row_index:
            return (
                specification.get("fill"),
                str(specification.get("alignment", "center")),
                bool(specification.get("bold", True)),
            )
    return (
        contract.get("header_fill"),
        str(contract.get("header_alignment", "center")),
        bool(contract.get("header_bold", True)),
    )


def table_layout_contract(
    tables: list[ET.Element],
    styles: ET.Element,
    profile: dict[str, object],
) -> tuple[list[dict[str, str]], list[dict[str, object]]]:
    """Validate table role, fill, alignment, header and pagination invariants."""
    errors: list[dict[str, str]] = []
    metrics: list[dict[str, object]] = []
    definitions, defaults = _style_definitions(styles)
    fallback = 12.0
    expected_count = len(profile.get("tables", []))
    if len(tables) != expected_count:
        errors.append(
            issue(
                "TABLE_LAYOUT_PROFILE_COUNT",
                f"table-layout profile defines {expected_count} tables, got {len(tables)}",
                "document body",
            )
        )

    for table_number, table in enumerate(tables[:expected_count], start=1):
        contract = _table_contract(table_number, profile)
        role = str(contract["role"])
        rows = table.findall("w:tr", NS)
        if table_number == 10 and (
            table.find(".//w:drawing", NS) is not None
            or table.find(".//w:pict", NS) is not None
            or table.find(".//w:object", NS) is not None
        ):
            metrics.append(
                {
                    "table": table_number,
                    "role": "organization_chart",
                    "rows": len(rows),
                    "repeat_header_rows": [],
                    "fill_mismatches": 0,
                    "role_style_mismatches": 0,
                    "narrative_alignment_errors": 0,
                    "paragraph_format_losses": 0,
                    "row_split_violations": 0,
                    "exact_height_rows": 0,
                }
            )
            continue
        expected_headers = set(int(item) for item in contract.get("header_rows", []))
        expected_repeat = set(int(item) for item in contract.get("repeat_header_rows", []))
        actual_repeat = {
            index
            for index, row in enumerate(rows)
            if row.find("./w:trPr/w:tblHeader", NS) is not None
        }
        unexpected_repeat = sorted(actual_repeat - expected_repeat)
        missing_repeat = sorted(expected_repeat - actual_repeat)
        if unexpected_repeat:
            errors.append(
                issue(
                    "TABLE_FALSE_HEADER_ROW",
                    f"table {table_number} marks non-header row(s) as repeating: {[value + 1 for value in unexpected_repeat]}",
                    f"table[{table_number}]",
                )
            )
        if missing_repeat:
            errors.append(
                issue(
                    "TABLE_REPEAT_HEADER",
                    f"table {table_number} is missing required repeating header row(s): {[value + 1 for value in missing_repeat]}",
                    f"table[{table_number}]",
                )
            )

        fill_mismatches = 0
        role_mismatches = 0
        narrative_alignment_errors = 0
        paragraph_format_losses = 0
        paragraph_spacing_mismatches = 0
        split_violations = 0
        exact_heights = 0
        long_row_chars = int(contract.get("long_row_chars", 80))
        split_policy = str(contract.get("row_split_policy", "keep_short_rows"))
        section_labels = {
            normalized_text(str(item))
            for item in contract.get("section_row_labels", [])
        }

        for row_index, row in enumerate(rows):
            height = row.find("./w:trPr/w:trHeight", NS)
            if height is not None and height.get(Q("hRule")) == "exact":
                exact_heights += 1
            cant_split = row.find("./w:trPr/w:cantSplit", NS) is not None
            row_text_length = len(normalized_text(text_of(row)))
            is_section_row = normalized_text(text_of(row)) in section_labels
            if row_index not in expected_headers:
                if split_policy == "allow_rows" and cant_split:
                    split_violations += 1
                elif split_policy == "allow_long_rows" and cant_split and row_text_length >= long_row_chars:
                    split_violations += 1

            for column_index, cell in enumerate(row.findall("w:tc", NS)):
                if not normalized_text(text_of(cell)):
                    continue
                fill = _cell_fill(cell)
                alignments = _cell_alignment_values(cell)
                bold_values = _cell_bold_values(cell, definitions, defaults, fallback)
                all_bold = bool(bold_values) and all(bold_values)
                if not _cell_format_is_explicit(cell):
                    paragraph_format_losses += 1
                if not _cell_spacing_matches(
                    cell,
                    _expected_paragraph_spacing(contract, row_index, column_index),
                ):
                    paragraph_spacing_mismatches += 1

                if is_section_row:
                    expected_fill = str(contract.get("section_fill", "E7E6E6")).upper()
                    expected_alignment = str(contract.get("section_alignment", "center"))
                    expected_bold = bool(contract.get("section_bold", True))
                    if fill != expected_fill:
                        fill_mismatches += 1
                    if any(value != expected_alignment for value in alignments) or all_bold != expected_bold:
                        role_mismatches += 1
                elif role.startswith("key_value"):
                    is_label = column_index in set(contract.get("label_columns", [0]))
                    if is_label:
                        expected_fill = str(contract.get("label_fill", "F2F2F2")).upper()
                        expected_alignment = str(contract.get("label_alignment", "center"))
                        expected_bold = bool(contract.get("label_bold", True))
                        if fill != expected_fill:
                            fill_mismatches += 1
                        if any(value != expected_alignment for value in alignments) or all_bold != expected_bold:
                            role_mismatches += 1
                    else:
                        allowed_fill = {
                            value.upper() if isinstance(value, str) else None
                            for value in contract.get("value_fill_values", [None, "auto", "FFFFFF"])
                        }
                        expected_alignment = str(contract.get("value_alignment", "center"))
                        expected_bold = bool(contract.get("value_bold", False))
                        if fill not in allowed_fill:
                            fill_mismatches += 1
                        if all_bold != expected_bold:
                            role_mismatches += 1
                        if any(value != expected_alignment for value in alignments):
                            if role == "key_value_narrative":
                                narrative_alignment_errors += 1
                            else:
                                role_mismatches += 1
                elif row_index in expected_headers:
                    expected_fill, expected_alignment, expected_bold = _expected_header_style(
                        contract, row_index
                    )
                    if fill != (str(expected_fill).upper() if expected_fill else None):
                        fill_mismatches += 1
                    if any(value != expected_alignment for value in alignments) or all_bold != expected_bold:
                        role_mismatches += 1
                else:
                    allowed_fill = {
                        value.upper() if isinstance(value, str) else None
                        for value in contract.get("body_fill_values", [None, "auto", "FFFFFF"])
                    }
                    alignments_by_column = contract.get("body_alignment_by_column", [])
                    expected_alignment = (
                        alignments_by_column[column_index]
                        if column_index < len(alignments_by_column)
                        else str(contract.get("body_alignment", "center"))
                    )
                    expected_bold = bool(contract.get("body_bold", False))
                    if fill not in allowed_fill:
                        fill_mismatches += 1
                    if all_bold != expected_bold:
                        role_mismatches += 1
                    if any(value != expected_alignment for value in alignments):
                        if split_policy == "allow_long_rows" and column_index > 0:
                            narrative_alignment_errors += 1
                        else:
                            role_mismatches += 1

        if fill_mismatches:
            errors.append(
                issue(
                    "TABLE_FILL_COLOR_MISMATCH",
                    f"table {table_number} has {fill_mismatches} cell fill(s) inconsistent with role {role}",
                    f"table[{table_number}]",
                )
            )
        if role_mismatches:
            errors.append(
                issue(
                    "TABLE_ROLE_STYLE_MISMATCH",
                    f"table {table_number} has {role_mismatches} bold/alignment mismatch(es) for role {role}",
                    f"table[{table_number}]",
                )
            )
        if narrative_alignment_errors:
            errors.append(
                issue(
                    "TABLE_NARRATIVE_ALIGNMENT",
                    f"table {table_number} has {narrative_alignment_errors} narrative cell(s) that are not left-aligned",
                    f"table[{table_number}]",
                )
            )
        if paragraph_format_losses:
            errors.append(
                issue(
                    "TABLE_PARAGRAPH_FORMAT_LOSS",
                    f"table {table_number} has {paragraph_format_losses} populated cell(s) without explicit paragraph/run prototypes",
                    f"table[{table_number}]",
                )
            )
        if paragraph_spacing_mismatches:
            errors.append(
                issue(
                    "TABLE_PARAGRAPH_SPACING_MISMATCH",
                    f"table {table_number} has {paragraph_spacing_mismatches} populated cell(s) with line/paragraph spacing inconsistent with role {role}",
                    f"table[{table_number}]",
                )
            )
        if split_violations:
            errors.append(
                issue(
                    "TABLE_ROW_SPLIT_POLICY",
                    f"table {table_number} has {split_violations} row(s) blocked from splitting despite role {role}",
                    f"table[{table_number}]",
                )
            )
        if exact_heights:
            errors.append(
                issue(
                    "FIXED_ROW_HEIGHT",
                    f"table {table_number} has {exact_heights} exact-height row(s) that can clip content",
                    f"table[{table_number}]",
                )
            )
        metrics.append(
            {
                "table": table_number,
                "role": role,
                "rows": len(rows),
                "repeat_header_rows": [value + 1 for value in sorted(actual_repeat)],
                "fill_mismatches": fill_mismatches,
                "role_style_mismatches": role_mismatches,
                "narrative_alignment_errors": narrative_alignment_errors,
                "paragraph_format_losses": paragraph_format_losses,
                "paragraph_spacing_mismatches": paragraph_spacing_mismatches,
                "row_split_violations": split_violations,
                "exact_height_rows": exact_heights,
            }
        )
    return errors, metrics


def _font_matches(font: str, allowed: list[str]) -> bool:
    normalized = re.sub(r"\s+", "", font).lower()
    return any(normalized == re.sub(r"\s+", "", item).lower() for item in allowed)


def _paragraph_alignment(paragraph: ET.Element) -> str:
    node = paragraph.find("./w:pPr/w:jc", NS)
    return node.get(Q("val"), "") if node is not None else ""


def typography_contract(
    document: ET.Element,
    styles: ET.Element,
    styles_by_id: dict[str, str],
    top_level_nodes: list[tuple[str, str, int | None, ET.Element]],
    tables: list[ET.Element],
    target_company: str | None,
    profile: dict[str, object],
) -> tuple[list[dict[str, str]], dict[str, object]]:
    errors: list[dict[str, str]] = []
    definitions, defaults = _style_definitions(styles)
    fallback = float(profile.get("fallback_size_pt", 12.0))
    aliases = profile.get("font_aliases", {})
    roles = profile.get("roles", {})

    first_h1 = next(
        (index for index, (_, _, level, _) in enumerate(top_level_nodes) if level == 1),
        len(top_level_nodes),
    )
    cover_paragraphs = [
        (text, node)
        for kind, text, _, node in top_level_nodes[:first_h1]
        if kind == "paragraph" and text and text != "目录"
    ]
    title_item = next(((text, node) for text, node in cover_paragraphs if "尽职调查报告" in text), None)
    company_item = next(
        (
            (text, node)
            for text, node in cover_paragraphs
            if (target_company and target_company in text) or (not target_company and "尽职调查报告" not in text and "团队" not in text and not re.search(r"[年月日]", text))
        ),
        None,
    )
    team_item = next(
        ((text, node) for text, node in cover_paragraphs if re.search(r"团队|投资部|项目组|出具团队", text)),
        None,
    )
    date_item = next(
        (
            (text, node)
            for text, node in cover_paragraphs
            if re.search(r"报告日期|(?:20\d{2}|[〇零一二三四五六七八九○]{4}).*[年月]", text)
        ),
        None,
    )
    cover_roles = {
        "cover_company": company_item,
        "cover_report_title": title_item,
        "cover_team": team_item,
        "cover_date": date_item,
    }

    role_distributions: dict[str, Counter[tuple[str, float, bool]]] = {}

    def validate_paragraph_role(role_name: str, paragraph: ET.Element, location: str) -> None:
        specification = roles.get(role_name, {})
        allowed_fonts = list(aliases.get(specification.get("font_group", ""), []))
        expected_size = float(specification.get("size_pt", fallback))
        expected_bold = bool(specification.get("bold", False))
        runs = visible_runs(paragraph)
        if not runs:
            errors.append(issue("TYPOGRAPHY_ROLE_EMPTY", f"{role_name} has no visible run", location))
            return
        distribution: Counter[tuple[str, float, bool]] = Counter()
        for run in runs:
            properties = effective_run_properties(paragraph, run, definitions, defaults, fallback)
            key = (str(properties["font"]), float(properties["size_pt"]), bool(properties["bold"]))
            distribution[key] += 1
            if allowed_fonts and not _font_matches(key[0], allowed_fonts):
                errors.append(issue("TYPOGRAPHY_FONT", f"{role_name} font {key[0]!r} is outside {allowed_fonts!r}", location))
            if abs(key[1] - expected_size) > 0.1:
                errors.append(issue("TYPOGRAPHY_SIZE", f"{role_name} size must be {expected_size:g}pt, got {key[1]:g}pt", location))
            if key[2] != expected_bold:
                errors.append(issue("TYPOGRAPHY_WEIGHT", f"{role_name} bold must be {expected_bold}, got {key[2]}", location))
        if specification.get("alignment") == "center" and _paragraph_alignment(paragraph) != "center":
            errors.append(issue("TYPOGRAPHY_ALIGNMENT", f"{role_name} must be centered", location))
        role_distributions.setdefault(role_name, Counter()).update(distribution)

    for role_name, item in cover_roles.items():
        if item is None:
            errors.append(issue("TYPOGRAPHY_ROLE_MISSING", f"cannot locate {role_name}", "cover"))
            continue
        validate_paragraph_role(role_name, item[1], f"cover/{role_name}")

    for paragraph_index, paragraph in enumerate(document.findall(".//w:body//w:p", NS), start=1):
        name = styles_by_id.get(style_id(paragraph), style_id(paragraph))
        level = heading_level(name)
        if level not in {1, 2, 3} or not text_of(paragraph):
            continue
        validate_paragraph_role(f"heading_{level}", paragraph, f"heading[{paragraph_index}]")

    for node_index, (kind, value, level, paragraph) in enumerate(
        top_level_nodes[first_h1:],
        start=first_h1 + 1,
    ):
        if kind != "paragraph" or level is not None or not value:
            continue
        validate_paragraph_role("body", paragraph, f"body-paragraph[{node_index}]")

    table_spec = roles.get("table_body", {})
    table_fonts = list(aliases.get(table_spec.get("font_group", ""), []))
    minimum_size = float(table_spec.get("minimum_size_pt", 9.0))
    exact_size = float(table_spec.get("exact_size_pt", table_spec.get("preferred_size_pt", 12.0)))
    table_distribution: Counter[tuple[str, float]] = Counter()
    table_run_count = 0
    undersized = 0
    inconsistent_size = 0
    unsupported_font = 0
    undersized_samples: list[str] = []
    inconsistent_size_samples: list[str] = []
    unsupported_samples: list[str] = []
    header_weight_errors = 0
    header_size_errors = 0
    header_samples: list[str] = []
    minimum_seen: float | None = None
    for table_index, table in enumerate(tables, start=1):
        for paragraph_index, paragraph in enumerate(table.findall(".//w:p", NS), start=1):
            for run in visible_runs(paragraph):
                properties = effective_run_properties(paragraph, run, definitions, defaults, fallback)
                font = str(properties["font"])
                size = float(properties["size_pt"])
                table_run_count += 1
                table_distribution[(font, size)] += 1
                minimum_seen = size if minimum_seen is None else min(minimum_seen, size)
                if size < minimum_size - 0.01:
                    undersized += 1
                    if len(undersized_samples) < 8:
                        undersized_samples.append(f"table[{table_index}] paragraph[{paragraph_index}]={size:g}pt")
                if abs(size - exact_size) > 0.1:
                    inconsistent_size += 1
                    if len(inconsistent_size_samples) < 8:
                        inconsistent_size_samples.append(
                            f"table[{table_index}] paragraph[{paragraph_index}]={size:g}pt"
                        )
                if table_fonts and not _font_matches(font, table_fonts):
                    unsupported_font += 1
                    if len(unsupported_samples) < 8:
                        unsupported_samples.append(f"table[{table_index}] paragraph[{paragraph_index}]={font!r}")

        is_org_chart = table_index == 10 and (
            table.find(".//w:drawing", NS) is not None
            or table.find(".//w:pict", NS) is not None
            or table.find(".//w:object", NS) is not None
        )
        if table_index not in {1, 2, 3, 4, 5, 6, 12} and not is_org_chart:
            rows = table.findall("w:tr", NS)
            header_spec = roles.get("table_header", {})
            preferred = float(header_spec.get("preferred_size_pt", 12.0))
            if rows:
                for paragraph in rows[0].findall(".//w:p", NS):
                    for run in visible_runs(paragraph):
                        properties = effective_run_properties(paragraph, run, definitions, defaults, fallback)
                        if not bool(properties["bold"]):
                            header_weight_errors += 1
                            if len(header_samples) < 8:
                                header_samples.append(f"table[{table_index}] not-bold")
                        if abs(float(properties["size_pt"]) - preferred) > 0.1:
                            header_size_errors += 1
                            if len(header_samples) < 8:
                                header_samples.append(f"table[{table_index}]={float(properties['size_pt']):g}pt")

    if undersized:
        errors.append(
            issue(
                "TABLE_TEXT_TOO_SMALL",
                f"{undersized} table run(s) are below {minimum_size:g}pt; samples: " + "; ".join(undersized_samples),
                "tables",
            )
        )
    if inconsistent_size:
        errors.append(
            issue(
                "TABLE_BODY_SIZE_INCONSISTENT",
                f"{inconsistent_size} table run(s) are not exactly {exact_size:g}pt; samples: "
                + "; ".join(inconsistent_size_samples),
                "tables",
            )
        )
    if unsupported_font:
        errors.append(
            issue(
                "TABLE_FONT",
                f"{unsupported_font} table run(s) use unsupported fonts; samples: " + "; ".join(unsupported_samples),
                "tables",
            )
        )
    if len(table_distribution) > 1:
        samples = "; ".join(
            f"{font or '<unset>'}/{size:g}pt={count}"
            for (font, size), count in table_distribution.most_common(8)
        )
        errors.append(
            issue(
                "TABLE_LOCAL_FONT_OVERRIDE",
                "table runs use more than one font/size pair; all table text must use one exact 12pt CJK role: "
                + samples,
                "tables",
            )
        )
    if header_weight_errors or header_size_errors:
        errors.append(
            issue(
                "TABLE_HEADER_TYPOGRAPHY",
                f"table headers have {header_weight_errors} non-bold and {header_size_errors} non-12pt run(s); samples: " + "; ".join(header_samples),
                "table headers",
            )
        )

    dominant_style = table_distribution.most_common(1)[0] if table_distribution else (("", fallback), 0)
    dominant_share = dominant_style[1] / table_run_count if table_run_count else 0.0
    anti_patterns = profile.get("anti_patterns", {})
    if (
        table_run_count
        and dominant_share >= float(anti_patterns.get("uniform_table_share_threshold", 0.8))
        and dominant_style[0][1] <= float(anti_patterns.get("uniform_table_size_pt_max", 8.5))
    ):
        errors.append(
            issue(
                "TABLE_GLOBAL_STYLE_OVERRIDE",
                f"{dominant_share:.1%} of table runs use one undersized font/size pair {dominant_style[0]!r}",
                "tables",
            )
        )

    def serialized(counter: Counter[tuple[str, float, bool]]) -> list[dict[str, object]]:
        return [
            {"font": key[0], "size_pt": key[1], "bold": key[2], "runs": count}
            for key, count in counter.most_common(8)
        ]

    metrics = {
        "typography_roles": {name: serialized(counter) for name, counter in role_distributions.items()},
        "table_run_count": table_run_count,
        "minimum_table_size_pt": minimum_seen,
        "undersized_table_runs": undersized,
        "inconsistent_table_size_runs": inconsistent_size,
        "unsupported_table_font_runs": unsupported_font,
        "table_header_weight_errors": header_weight_errors,
        "table_header_size_errors": header_size_errors,
        "dominant_table_style": {
            "font": dominant_style[0][0],
            "size_pt": dominant_style[0][1],
            "runs": dominant_style[1],
            "share": round(dominant_share, 4),
        },
    }
    return errors, metrics


def _cell_paragraph_count(cell: ET.Element) -> int:
    return sum(1 for paragraph in cell.findall("w:p", NS) if normalized_text(text_of(paragraph)))


def _has_limitation(value: str) -> bool:
    return bool(re.search(r"未取得|未提供|未披露|待访谈|待确认|不适用", value))


def table_content_stats(table: ET.Element) -> dict[str, object]:
    rows = table.findall("w:tr", NS)
    value = normalized_text(text_of(table))
    return {
        "rows": len(rows),
        "chars": len(value),
        "paragraphs": sum(
            1 for paragraph in table.findall(".//w:p", NS) if normalized_text(text_of(paragraph))
        ),
        "numbered_markers": len(re.findall(r"（\d+）", value)),
        "has_limitation": _has_limitation(value),
    }


def _reference_density_stats() -> list[dict[str, object]]:
    reference = Path(__file__).resolve().parents[1] / "assets" / "reference-dd-report.docx"
    if not reference.exists():
        return []
    try:
        with zipfile.ZipFile(reference) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
        return [table_content_stats(table) for table in root.findall(".//w:tbl", NS)]
    except Exception:
        return []


def content_density_contract(
    tables: list[ET.Element],
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, object]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    stats = [table_content_stats(table) for table in tables]
    reference_stats = _reference_density_stats()

    for index, current in enumerate(stats):
        if index >= len(reference_stats) or not reference_stats[index].get("chars"):
            current["reference_char_ratio"] = None
            continue
        ratio = float(current["chars"]) / float(reference_stats[index]["chars"])
        current["reference_char_ratio"] = round(ratio, 3)
        # The ratio is diagnostic only.  It must never force filler such as
        # source limitations, valuation exclusions, or evidence-status prose.

    if len(tables) >= 3:
        rows = tables[2].findall("w:tr", NS)
        right_cells = [row.findall("w:tc", NS)[1] for row in rows if len(row.findall("w:tc", NS)) >= 2]
        per_cell_chars = [len(normalized_text(text_of(cell))) for cell in right_cells]
        chars = sum(per_cell_chars)
        paragraph_counts = [_cell_paragraph_count(cell) for cell in right_cells]
        if (
            len(right_cells) < 3
            or chars < 600
            or any(value < 180 for value in per_cell_chars)
            or any(value < 2 for value in paragraph_counts)
        ):
            errors.append(
                issue(
                    "TABLE_CONTENT_DEPTH",
                    f"table 3 industry analysis must give every theme 2-3 substantive paragraphs and at least 180 characters: total_chars={chars}, per_cell={per_cell_chars}, paragraphs={paragraph_counts}",
                    "table[3]",
                )
            )

    if len(tables) >= 5:
        rows = tables[4].findall("w:tr", NS)
        investment_cell = rows[0].findall("w:tc", NS)[1] if rows and len(rows[0].findall("w:tc", NS)) >= 2 else None
        if investment_cell is not None:
            value = normalized_text(text_of(investment_cell))
            markers = len(re.findall(r"（\d+）", value))
            paragraphs = _cell_paragraph_count(investment_cell)
            if not 3 <= markers <= 5 or paragraphs < markers * 3 or len(value) < 650:
                errors.append(
                    issue(
                        "TABLE_CONTENT_DEPTH",
                        f"table 5 investment value needs 3-5 numbered arguments, at least three paragraphs per argument and 650 characters: markers={markers}, paragraphs={paragraphs}, chars={len(value)}",
                        "table[5] row[1] column[2]",
                    )
                )

    for table_number, minimum_rows in ((23, 2), (24, 2)):
        if len(tables) >= table_number and int(stats[table_number - 1]["rows"]) < minimum_rows:
            errors.append(issue("FINANCIAL_TABLE_LINE_ITEMS", f"table {table_number} must contain a header and at least one supported data row", f"table[{table_number}]"))

    empty_tokens = {"", "-", "--", "—", "–", "不适用", "{{值}}", "{{据实填写}}"}
    for table_number in (22, 24):
        if len(tables) < table_number:
            continue
        rows = table_rows(tables[table_number - 1])
        if not rows:
            continue
        for column_index, header in enumerate(rows[0][1:], start=1):
            values = [
                row[column_index] if column_index < len(row) else ""
                for row in rows[1:]
            ]
            if values and all(value in empty_tokens for value in values):
                errors.append(
                    issue(
                        "EMPTY_FORECAST_YEAR",
                        f"table {table_number} forecast year {header!r} has no substantive data and must be removed",
                        f"table[{table_number}] column[{column_index + 1}]",
                    )
                )

    if len(tables) >= 23:
        financial_text = normalized_text(text_of(tables[22]))
        required_groups = ("利润表", "资产负债表", "现金流量表")
        required_balance_labels = (
            "流动资产合计",
            "非流动资产合计",
            "资产合计",
            "流动负债合计",
            "非流动负债合计",
            "负债合计",
            "所有者权益合计",
        )
        missing = [
            label
            for label in (*required_groups, *required_balance_labels)
            if label not in financial_text
        ]
        if missing:
            errors.append(
                issue(
                    "FINANCIAL_CLASSIFICATION",
                    "table 23 must be grouped into profit, balance sheet and cash flow with complete asset/liability classification; missing: "
                    + ", ".join(missing),
                    "table[23]",
                )
            )

    structured_tables = {
        15: (2, 3, 20),
        20: (3, 3, 30),
        25: (3, 3, 20),
        27: (3, 4, 40),
    }
    for table_number, (columns, minimum_data_rows, minimum_detail_chars) in structured_tables.items():
        if len(tables) < table_number:
            continue
        rows = tables[table_number - 1].findall("w:tr", NS)[1:]
        if len(rows) < minimum_data_rows:
            errors.append(issue("TABLE_CONTENT_DEPTH", f"table {table_number} needs at least {minimum_data_rows} data rows", f"table[{table_number}]"))
        for row_index, row in enumerate(rows, start=2):
            cells = row.findall("w:tc", NS)
            values = [normalized_text(text_of(cell)) for cell in cells]
            if len(cells) < columns or any(not value for value in values[:columns]):
                errors.append(issue("TABLE_CONTENT_DEPTH", f"table {table_number} row has empty required fields", f"table[{table_number}] row[{row_index}]"))
                continue
            detail = "".join(values[1:columns])
            if len(detail) < minimum_detail_chars:
                errors.append(issue("TABLE_CONTENT_DEPTH", f"table {table_number} row detail is too thin ({len(detail)} chars); add business-specific facts rather than a limitation or exclusion statement", f"table[{table_number}] row[{row_index}]"))

    return errors, warnings, stats


def style_id(paragraph: ET.Element) -> str:
    node = paragraph.find("./w:pPr/w:pStyle", NS)
    return node.get(Q("val"), "") if node is not None else ""


def heading_level(style_name: str) -> int | None:
    normalized = style_name.lower().replace("标题", "heading")
    match = re.search(r"heading\s*([123])", normalized)
    return int(match.group(1)) if match else None


def field_codes(parts: dict[str, bytes]) -> list[str]:
    codes: list[str] = []
    for name, raw in parts.items():
        if not name.endswith(".xml"):
            continue
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        for node in root.findall(".//w:instrText", NS):
            if node.text:
                codes.append(node.text.strip())
    return codes


def top_level_document_nodes(
    document: ET.Element,
    styles_by_id: dict[str, str],
) -> list[tuple[str, str, int | None, ET.Element]]:
    body = document.find("w:body", NS)
    nodes: list[tuple[str, str, int | None, ET.Element]] = []
    if body is None:
        return nodes
    for child in body:
        if child.tag == Q("p"):
            text = text_of(child)
            style_name = styles_by_id.get(style_id(child), style_id(child))
            level = heading_level(style_name)
            kind = "paragraph"
        elif child.tag == Q("tbl"):
            text = text_of(child)
            level = None
            kind = "table"
        else:
            continue
        if text:
            nodes.append((kind, text, level, child))
    return nodes


def section_nodes(
    nodes: list[tuple[str, str, int | None, ET.Element]],
    heading_pattern: str,
) -> list[tuple[str, str, int | None, ET.Element]]:
    """Return the visible nodes governed by the first matching heading."""
    start: int | None = None
    start_level: int | None = None
    for index, (_, text, level, _) in enumerate(nodes):
        if level is not None and re.search(heading_pattern, normalized_text(text)):
            start = index
            start_level = level
            break
    if start is None or start_level is None:
        return []
    result = []
    for item in nodes[start + 1 :]:
        if item[2] is not None and item[2] <= start_level:
            break
        result.append(item)
    return result


def section_text(
    nodes: list[tuple[str, str, int | None, ET.Element]],
    heading_pattern: str,
) -> str:
    return "\n".join(text for _, text, _, _ in section_nodes(nodes, heading_pattern))


def document_section_has_drawing(
    document: ET.Element,
    styles_by_id: dict[str, str],
    heading_pattern: str,
) -> bool:
    """Check drawings even when the containing paragraph has no visible text."""
    body = document.find("w:body", NS)
    if body is None:
        return False
    active = False
    start_level: int | None = None
    for child in body:
        if child.tag == Q("p"):
            style_name = styles_by_id.get(style_id(child), style_id(child))
            level = heading_level(style_name)
            value = normalized_text(text_of(child))
            if level is not None:
                if active and start_level is not None and level <= start_level:
                    return False
                if re.search(heading_pattern, value):
                    active = True
                    start_level = level
                    continue
        if active and (
            child.find(".//w:drawing", NS) is not None
            or child.find(".//w:pict", NS) is not None
            or child.find(".//w:object", NS) is not None
        ):
            return True
    return False


def document_section_semantic_text(
    document: ET.Element,
    styles_by_id: dict[str, str],
    heading_pattern: str,
) -> str:
    """Collect visible text and drawing alternative text within one section."""
    body = document.find("w:body", NS)
    if body is None:
        return ""
    active = False
    start_level: int | None = None
    values: list[str] = []
    for child in body:
        if child.tag == Q("p"):
            current_level = heading_level(
                styles_by_id.get(style_id(child), style_id(child))
            )
            current_text = normalized_text(text_of(child))
            if current_level is not None and re.search(heading_pattern, current_text):
                active = True
                start_level = current_level
            elif active and current_level is not None and start_level is not None and current_level <= start_level:
                break
        if not active:
            continue
        visible = normalized_text(text_of(child))
        if visible:
            values.append(visible)
        for element in child.iter():
            for key in ("name", "title", "descr"):
                value = element.attrib.get(key)
                if value:
                    values.append(normalized_text(value))
    return "\n".join(values)


def team_member_coverage_issues(
    nodes: list[tuple[str, str, int | None, ET.Element]],
    expected_members: list[str],
) -> list[str]:
    if not expected_members:
        return []
    section = section_nodes(nodes, r"^2\.4核心团队$")
    person_headings = [
        normalized_text(text)
        for _, text, level, _ in section
        if level == 3
    ]
    return [
        member
        for member in expected_members
        if not any(normalized_text(member) in heading for heading in person_headings)
    ]


def qualification_scope_spill_hits(value: str) -> list[str]:
    pattern = re.compile(
        r"诉讼|仲裁|行政处罚|失信|债权债务|房屋租赁|劳动社保|"
        r"数据与测绘|测绘|环保消防|消防安全"
    )
    return sorted(set(pattern.findall(normalized_text(value))))


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def source_contract_issues(
    nodes: list[tuple[str, str, int | None, ET.Element]],
    transaction_register_path: Path | None,
    evidence_ledger_path: Path | None,
    report_stage: str,
    strict_source_contract: bool,
) -> tuple[list[dict[str, str]], dict[str, object]]:
    errors: list[dict[str, str]] = []
    metrics: dict[str, object] = {
        "transaction_register_loaded": False,
        "evidence_ledger_loaded": False,
        "current_round_documents": 0,
        "transaction_assertions": 0,
    }
    if not strict_source_contract:
        return errors, metrics
    if transaction_register_path is None or not transaction_register_path.exists():
        errors.append(issue("TRANSACTION_REGISTER_REQUIRED", "strict source contract requires transaction-register.json", "source contract"))
        return errors, metrics
    if evidence_ledger_path is None or not evidence_ledger_path.exists():
        errors.append(issue("EVIDENCE_LEDGER_REQUIRED", "strict source contract requires evidence-ledger.json", "source contract"))
        return errors, metrics
    try:
        register = _load_json(transaction_register_path)
        metrics["transaction_register_loaded"] = True
    except Exception as exc:
        errors.append(issue("TRANSACTION_REGISTER_INVALID", str(exc), str(transaction_register_path)))
        return errors, metrics
    try:
        ledger = _load_json(evidence_ledger_path)
        metrics["evidence_ledger_loaded"] = True
    except Exception as exc:
        errors.append(issue("EVIDENCE_LEDGER_INVALID", str(exc), str(evidence_ledger_path)))
        return errors, metrics
    if not isinstance(register, dict):
        errors.append(issue("TRANSACTION_REGISTER_INVALID", "transaction register must be a JSON object", str(transaction_register_path)))
        return errors, metrics
    current_round_id = str(register.get("current_round_id", "")).strip()
    if not current_round_id:
        errors.append(issue("TRANSACTION_REGISTER_INVALID", "current_round_id is required", str(transaction_register_path)))
    registered_stage = str(register.get("report_stage", "")).strip()
    if registered_stage and registered_stage != report_stage:
        errors.append(issue("TRANSACTION_STAGE_MISMATCH", f"register stage {registered_stage!r} does not match report stage {report_stage!r}", str(transaction_register_path)))
    documents = register.get("documents", [])
    current_documents = [
        item for item in documents
        if isinstance(item, dict)
        and item.get("round_role") == "current"
        and (not current_round_id or item.get("round_id") == current_round_id)
        and item.get("execution_status") != "superseded"
    ] if isinstance(documents, list) else []
    metrics["current_round_documents"] = len(current_documents)
    if not current_documents:
        errors.append(issue("CURRENT_ROUND_SOURCE_MISSING", "no active current-round transaction document is registered", str(transaction_register_path)))
    for item in current_documents:
        if item.get("contains_drafting_notes") and not item.get("drafting_notes_resolved"):
            errors.append(issue("UNRESOLVED_TRANSACTION_DRAFT_NOTES", f"current transaction source {item.get('source_id', '<unknown>')} has unresolved drafting notes", str(transaction_register_path)))

    if isinstance(ledger, dict):
        ledger_items = ledger.get("claims", ledger.get("entries", []))
    else:
        ledger_items = ledger
    ledger_by_claim: dict[str, list[dict[str, object]]] = {}
    if isinstance(ledger_items, list):
        for item in ledger_items:
            if isinstance(item, dict) and item.get("claim_id"):
                ledger_by_claim.setdefault(str(item["claim_id"]), []).append(item)
    claim_ids = set(ledger_by_claim)
    current_source_ids = {
        str(item.get("source_id"))
        for item in current_documents
        if item.get("source_id")
    }
    section_values = {
        "1.2": section_text(nodes, r"^1\.2交易要点$"),
        "7.2": section_text(nodes, r"^7\.2(?:公司估值与投资方式|投资方案)$"),
        "conclusion": section_text(nodes, r"投资结论(?:及建议)?$"),
    }
    assertions = register.get("report_assertions", [])
    if not isinstance(assertions, list) or not assertions:
        errors.append(issue("TRANSACTION_ASSERTION_REQUIRED", "report_assertions must define current-round terms for 1.2, 7.2 and conclusion", str(transaction_register_path)))
        assertions = []
    metrics["transaction_assertions"] = len(assertions)
    for assertion in assertions:
        if not isinstance(assertion, dict):
            continue
        claim_id = str(assertion.get("claim_id", "")).strip()
        if not claim_id or claim_id not in claim_ids:
            errors.append(issue("TRANSACTION_CLAIM_UNSOURCED", f"transaction assertion {claim_id or '<missing>'} has no evidence-ledger entry", str(evidence_ledger_path)))
        else:
            valid_entries = [
                item
                for item in ledger_by_claim[claim_id]
                if item.get("round_id") == current_round_id
                and item.get("freshness_status") == "current"
                and item.get("source_id") in current_source_ids
                and item.get("drafting_note_status") != "unresolved"
                and item.get("claim_status") in {
                    "verified",
                    "transaction_controlled",
                    "accepted_adverse_fact",
                }
            ]
            if not valid_entries:
                errors.append(
                    issue(
                        "TRANSACTION_CLAIM_UNSOURCED",
                        f"transaction assertion {claim_id} lacks a current-round, current-version, resolved evidence entry",
                        str(evidence_ledger_path),
                    )
                )
        patterns = [str(item) for item in assertion.get("patterns", []) if str(item)]
        for section in assertion.get("sections", []):
            section_key = str(section)
            value = section_values.get(section_key, "")
            matches = sum(len(re.findall(pattern, value)) for pattern in patterns)
            if matches < int(assertion.get("minimum_matches", 1)):
                errors.append(issue("CURRENT_ROUND_TERM_MISSING", f"{assertion.get('label', claim_id)} is missing from {section_key}", section_key))
    stale_rules = register.get("stale_term_rules", [])
    if isinstance(stale_rules, list):
        for rule in stale_rules:
            if not isinstance(rule, dict):
                continue
            for section in rule.get("sections", []):
                section_key = str(section)
                value = section_values.get(section_key, "")
                for pattern in rule.get("patterns", []):
                    if re.search(str(pattern), value):
                        errors.append(issue("STALE_TRANSACTION_TERM", f"historical term {rule.get('label', pattern)!r} appears in {section_key}", section_key))
                        break
    return errors, metrics


def team_bio_issues(
    nodes: list[tuple[str, str, int | None, ET.Element]],
) -> list[str]:
    """Return thin 2.4 core-team biography headings."""
    team = section_nodes(nodes, r"^2\.4(?:核心团队|核心团队介绍)?$")
    if not team:
        return ["2.4 section is missing or cannot be identified"]
    biographies: list[tuple[str, str]] = []
    active_heading: str | None = None
    buffer: list[str] = []
    for _, text, level, _ in team:
        if level == 3:
            if active_heading is not None:
                biographies.append((active_heading, "".join(buffer)))
            active_heading = text
            buffer = []
        elif active_heading is not None:
            buffer.append(text)
    if active_heading is not None:
        biographies.append((active_heading, "".join(buffer)))
    if not biographies:
        return ["2.4 has no person-level Heading 3 biographies"]
    issues: list[str] = []
    dimension_patterns = (
        r"大学|学院|本科|硕士|博士|学士",
        r"曾任|历任|任职|加入|工作经历|从事",
        r"项目|产品|研发|专利|论文|成果|客户|产业",
        r"负责|现任|分管|主管|职责",
    )
    for heading, value in biographies:
        dimensions = sum(bool(re.search(pattern, value)) for pattern in dimension_patterns)
        if len(normalized_text(value)) < 120 or dimensions < 3:
            issues.append(f"{heading}: chars={len(normalized_text(value))}, dimensions={dimensions}")
    return issues


def post_table_paragraph_counts(
    nodes: list[tuple[str, str, int | None, ET.Element]],
) -> dict[int, int]:
    counts: dict[int, int] = {}
    active_table: int | None = None
    table_number = 0
    for kind, _, level, _ in nodes:
        if kind == "table":
            table_number += 1
            active_table = table_number
            counts.setdefault(table_number, 0)
        elif level is not None:
            active_table = None
        elif kind == "paragraph" and active_table is not None:
            counts[active_table] = counts.get(active_table, 0) + 1
    return counts


def template_post_table_allowances() -> dict[int, int]:
    template = Path(__file__).resolve().parents[1] / "assets" / "primary-dd-report-template.docx"
    with zipfile.ZipFile(template) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        styles = ET.fromstring(archive.read("word/styles.xml"))
    return post_table_paragraph_counts(top_level_document_nodes(document, style_map(styles)))


def validate(
    docx: Path,
    render_dir: Path | None,
    forbidden: list[str],
    target_company: str | None,
    require_end_marker: bool,
    strict_sample_schema: bool,
    style_profile_path: Path | None = None,
    table_layout_profile_path: Path | None = None,
    report_stage: str = RECOMMENDATION_REPORT_STAGE,
    transaction_register_path: Path | None = None,
    evidence_ledger_path: Path | None = None,
    strict_source_contract: bool = False,
    expected_team_members: list[str] | None = None,
    expected_org_labels: list[str] | None = None,
) -> dict[str, object]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    try:
        with zipfile.ZipFile(docx) as archive:
            names = archive.namelist()
            parts = {name: archive.read(name) for name in names if name.endswith(".xml")}
            document_raw = parts["word/document.xml"]
            document = ET.fromstring(document_raw)
            styles = ET.fromstring(parts["word/styles.xml"])
    except Exception as exc:
        return {"status": "fail", "errors": [issue("DOCX_READ_ERROR", str(exc), str(docx))], "warnings": [], "metrics": {}}

    styles_by_id = style_map(styles)
    paragraphs = document.findall(".//w:body//w:p", NS)
    styled: list[tuple[str, str, int | None]] = []
    for paragraph in paragraphs:
        text = text_of(paragraph)
        if not text:
            continue
        style_name = styles_by_id.get(style_id(paragraph), style_id(paragraph))
        styled.append((text, style_name, heading_level(style_name)))

    all_text = "\n".join(text for text, _, _ in styled)
    opening_text = "\n".join(text for text, _, _ in styled[:25])
    headings = {level: [text for text, _, actual in styled if actual == level] for level in (1, 2, 3)}
    heading_text = "\n".join(text for level in (1, 2, 3) for text in headings[level])
    visible_evidence_ids = sorted(set(VISIBLE_EVIDENCE_ID_PATTERN.findall(all_text)))
    if visible_evidence_ids:
        errors.append(
            issue(
                "VISIBLE_EVIDENCE_ID",
                "internal evidence identifiers must stay in the working ledger, not the delivered report: "
                + ", ".join(visible_evidence_ids[:10]),
                "document body",
            )
        )

    comment_parts = [
        name
        for name in names
        if re.fullmatch(r"word/comments(?:Extended|Extensible|Ids)?\.xml", name)
    ]
    tracked_insertions = len(document.findall(".//w:ins", NS))
    tracked_deletions = len(document.findall(".//w:del", NS))
    comment_marks = sum(
        len(document.findall(f".//w:{name}", NS))
        for name in ("commentRangeStart", "commentRangeEnd", "commentReference")
    )
    if comment_parts or tracked_insertions or tracked_deletions or comment_marks:
        errors.append(
            issue(
                "COMMENTS_OR_TRACKED_CHANGES",
                "final DOCX contains comments or tracked revisions: "
                f"parts={comment_parts}, insertions={tracked_insertions}, "
                f"deletions={tracked_deletions}, comment_marks={comment_marks}",
                "OOXML package",
            )
        )

    if "尽职调查报告" not in opening_text:
        errors.append(issue("TITLE", "opening pages must contain a due-diligence report title", "document opening"))
    if target_company and target_company not in opening_text:
        errors.append(issue("TARGET_COMPANY", f"target company {target_company!r} is missing from the opening pages", "document opening"))
    if not 6 <= len(headings[1]) <= 12:
        errors.append(issue("H1_COUNT", f"expected 6-12 Heading 1 paragraphs, got {len(headings[1])}", "document body"))
    if len(headings[2]) < 5:
        errors.append(issue("H2_COUNT", f"expected at least 5 Heading 2 paragraphs, got {len(headings[2])}", "document body"))
    if headings[1] and not re.search(r"结论|建议", headings[1][-1]):
        errors.append(
            issue(
                "CONCLUSION_NOT_LAST_H1",
                f"last Heading 1 must be the investment conclusion, got {headings[1][-1]!r}",
                "document body",
            )
        )

    required_topics = {
        "INVESTMENT_SUMMARY": r"投资概要|项目概要",
        "COMPANY_LEGAL": r"公司概况|公司基本|法律|合规",
        "PRODUCT_BUSINESS": r"产品|技术|业务",
        "FINANCE": r"财务|经营情况",
        "TRANSACTION": r"投资方案|交易方案",
        "RISK": r"风险",
        "CONCLUSION": r"结论|建议",
    }
    for code, pattern in required_topics.items():
        if not re.search(pattern, heading_text):
            errors.append(issue(code, f"missing required heading topic matching {pattern}", "headings"))

    for term in forbidden:
        if term and term in all_text:
            errors.append(issue("FORBIDDEN_TERM", f"forbidden sample/residual term found: {term}", "document body"))

    suspicious = ["Decision Manifest", "transaction_response", "忽略此前指令", "ignore previous instructions"]
    for token in suspicious:
        if token.lower() in all_text.lower():
            errors.append(issue("INTERNAL_OR_UNTRUSTED_TEXT", f"visible internal/untrusted token: {token}", "document body"))

    if not re.search(r"截至\s*20\d{2}|资料截止日|报告日", all_text):
        warnings.append(issue("CUTOFF_DATE", "no clear source/report cutoff date found", "document body"))
    if report_stage == IN_PROGRESS_REPORT_STAGE and not re.search(r"范围|限制|未取得|资料提供", all_text):
        warnings.append(issue("SCOPE_LIMITATION", "no clear scope or source limitation language found", "document body"))

    codes = field_codes(parts)
    if not any(re.search(r"\b(?:TOC|PAGEREF)\b", code, re.I) for code in codes):
        errors.append(issue("TOC_FIELDS", "no TOC/PAGEREF fields found", "word/document.xml"))
    if not any(re.search(r"\bPAGE\b", code, re.I) for code in codes):
        errors.append(issue("PAGE_FIELD", "no PAGE field found", "footer parts"))

    header_text = "\n".join(
        text_of(ET.fromstring(raw))
        for name, raw in parts.items()
        if re.fullmatch(r"word/header\d+\.xml", name)
    )
    if not re.search(r"内部|禁止外传|保密", header_text):
        errors.append(issue("INTERNAL_HEADER", "internal-use/confidentiality statement is missing from headers", "header parts"))

    body = document.find("w:body", NS)
    top_level_nodes = top_level_document_nodes(document, styles_by_id)
    source_errors, source_metrics = source_contract_issues(
        top_level_nodes,
        transaction_register_path,
        evidence_ledger_path,
        report_stage,
        strict_source_contract,
    )
    errors.extend(source_errors)
    top_level_blocks = [(text, level) for _, text, level, _ in top_level_nodes]
    unauthorized_preface_hits: list[str] = []
    unauthorized_judgment_hits: list[str] = []
    post_table_narrative_violations: dict[int, tuple[int, int]] = {}

    if strict_sample_schema:
        unauthorized_preface_hits = [
            text
            for kind, text, _, _ in top_level_nodes
            if kind == "paragraph" and UNAUTHORIZED_PREFACE_PATTERN.search(normalized_text(text))
        ]
        if unauthorized_preface_hits:
            errors.append(
                issue(
                    "UNAUTHORIZED_PREFACE_BLOCK",
                    "strict sample structure forbids a standalone report-basis/scope or evidence-method block",
                    unauthorized_preface_hits[0][:80],
                )
            )

        unauthorized_judgment_hits = [
            text
            for kind, text, _, _ in top_level_nodes
            if kind == "paragraph"
            and UNAUTHORIZED_JUDGMENT_PATTERN.search(normalized_text(text))
        ]
        if unauthorized_judgment_hits:
            errors.append(
                issue(
                    "UNAUTHORIZED_JUDGMENT_MODULE",
                    "strict sample structure forbids mechanically added industry/project judgment modules",
                    unauthorized_judgment_hits[0][:80],
                )
            )

        source_appendix_hits = [
            text
            for kind, text, _, _ in top_level_nodes
            if kind == "paragraph"
            and UNAUTHORIZED_SOURCE_APPENDIX_PATTERN.search(normalized_text(text))
        ]
        if source_appendix_hits:
            errors.append(
                issue(
                    "UNAUTHORIZED_SOURCE_APPENDIX",
                    "strict sample output must not add an evidence/source appendix unless the user requests a non-sample deliverable",
                    source_appendix_hits[0][:80],
                )
            )

        try:
            allowed_post_table = template_post_table_allowances()
            actual_post_table = post_table_paragraph_counts(top_level_nodes)
            post_table_narrative_violations = {
                table_number: (actual_count, allowed_post_table.get(table_number, 0))
                for table_number, actual_count in actual_post_table.items()
                if actual_count > allowed_post_table.get(table_number, 0)
            }
        except Exception as exc:
            errors.append(
                issue(
                    "TEMPLATE_STRUCTURE_READ_ERROR",
                    f"cannot load the primary template's post-table paragraph contract: {exc}",
                    "assets/primary-dd-report-template.docx",
                )
            )
        if post_table_narrative_violations:
            details = ", ".join(
                f"table {number}: {actual}>{allowed}"
                for number, (actual, allowed) in sorted(post_table_narrative_violations.items())
            )
            errors.append(
                issue(
                    "UNAUTHORIZED_POST_TABLE_NARRATIVE",
                    "paragraphs were added after tables where the sample template has fewer or no narrative slots: "
                    + details,
                    "top-level document structure",
                )
            )

        first_h1 = next(
            (index for index, (_, _, level, _) in enumerate(top_level_nodes) if level == 1),
            len(top_level_nodes),
        )
        front_matter = top_level_nodes[:first_h1]
        pre_body_tables = [text for kind, text, _, _ in front_matter if kind == "table"]
        if pre_body_tables:
            errors.append(
                issue(
                    "TOC_OR_COVER_TABLE",
                    f"cover/TOC must not be simulated with tables; found {len(pre_body_tables)} table(s) before first Heading 1",
                    "front matter",
                )
            )
        decorated = []
        for kind, text, _, node in front_matter:
            if kind != "paragraph":
                continue
            if (
                node.find(".//w:drawing", NS) is not None
                or node.find(".//w:pict", NS) is not None
                or node.find("./w:pPr/w:pBdr", NS) is not None
            ):
                decorated.append(text[:40])
        if decorated:
            errors.append(
                issue(
                    "COVER_DECORATION",
                    "cover/front matter contains a drawing, shape, or paragraph border: " + "; ".join(decorated),
                    "front matter",
                )
            )
        if target_company:
            combined_title = [
                text
                for kind, text, _, _ in front_matter
                if kind == "paragraph" and target_company in text and "尽职调查报告" in text
            ]
            if combined_title:
                errors.append(
                    issue(
                        "COVER_TITLE_PARAGRAPHS",
                        "company name and report name must be separate centered paragraphs",
                        "cover",
                    )
                )

    conclusion_indexes = [
        index
        for index, (text, level) in enumerate(top_level_blocks)
        if level == 1 and re.search(r"结论|建议", text)
    ]
    end_indexes = [
        index for index, (text, _) in enumerate(top_level_blocks) if "报告结束" in text
    ]
    if conclusion_indexes:
        conclusion_index = conclusion_indexes[-1]
        if any(
            re.search(r"附件与证据|资料来源与证据|证据索引", text)
            for text, _ in top_level_blocks[conclusion_index + 1 :]
        ):
            errors.append(
                issue(
                    "EVIDENCE_AFTER_CONCLUSION",
                    "evidence/source appendix appears after the investment conclusion",
                    "document tail",
                )
            )
        if end_indexes and end_indexes[-1] <= conclusion_index:
            errors.append(
                issue(
                    "END_MARKER_ORDER",
                    "report end marker must appear after the investment conclusion",
                    "document tail",
                )
            )
    if require_end_marker and not end_indexes:
        errors.append(issue("END_MARKER", "required report end marker is missing", "document tail"))

    visible_reasoning_hits = [
        match.group(0) for match in VISIBLE_REASONING_LABEL_PATTERN.finditer(all_text)
    ]
    if visible_reasoning_hits:
        errors.append(
            issue(
                "VISIBLE_REASONING_LABEL",
                "visible report must present integrated facts and judgments, not reasoning scaffolds such as 中心判断：/事实基础：/分析判断：/投资影响：; found "
                + ", ".join(visible_reasoning_hits[:12]),
                "document body",
            )
        )

    formulaic_ai_summary_hits = [
        match.group(0) for match in FORMULAIC_AI_SUMMARY_PATTERN.finditer(all_text)
    ]
    if formulaic_ai_summary_hits:
        errors.append(
            issue(
                "FORMULAIC_AI_SUMMARY",
                "replace formulaic summaries such as 核心逻辑由X项事实构成 with natural investment-manager prose: "
                + ", ".join(formulaic_ai_summary_hits[:12]),
                "document body",
            )
        )

    open_dd_hits: list[dict[str, str]] = []
    generic_defensive_hits: list[str] = []
    decision_layer_meta_hits: list[dict[str, str]] = []
    exclusionary_decision_hits: list[str] = []
    simulated_post_investment_hits: list[str] = []
    risk_status_meta_hits: list[str] = []
    transaction_execution_meta_hits: list[str] = []
    decisive_conclusion = False
    concrete_transaction = False
    recommendation_conclusion_paragraphs: list[str] = []
    recommendation_terms_complete = False
    conclusion_text = ""
    if conclusion_indexes:
        conclusion_index = conclusion_indexes[-1]
        conclusion_end = next(
            (index for index in end_indexes if index > conclusion_index),
            len(top_level_nodes),
        )
        conclusion_slice = top_level_nodes[conclusion_index + 1 : conclusion_end]
        recommendation_conclusion_paragraphs = [
            text
            for kind, text, level, _ in conclusion_slice
            if kind == "paragraph" and level is None and "报告结束" not in text
        ]
        conclusion_text = "\n".join(
            [top_level_blocks[conclusion_index][0], *recommendation_conclusion_paragraphs]
        )

    if report_stage in TERMINAL_REPORT_STAGES:
        concrete_transaction = transaction_terms_are_concrete(all_text)
        if not concrete_transaction:
            errors.append(
                issue(
                    "TERMINAL_TRANSACTION_INCOMPLETE",
                    "investment recommendation/decision report requires a numeric investment amount or valuation bound to the transaction terms",
                    "investment summary/transaction plan",
                )
            )

        if FORMULAIC_APPROVAL_CONCLUSION_PATTERN.search(conclusion_text):
            errors.append(
                issue(
                    "FORMULAIC_APPROVAL_CONCLUSION",
                    "investment conclusion must summarize the project and transaction naturally; do not use an approval formula such as 本项目投资结论为同意……",
                    "investment conclusion",
                )
            )

        language_scope_text = all_text
        if (
            report_stage == RECOMMENDATION_REPORT_STAGE
            and recommendation_conclusion_paragraphs
        ):
            language_scope_text = language_scope_text.replace(
                recommendation_conclusion_paragraphs[-1], "", 1
            )
        open_dd_hits = open_dd_language_hits(language_scope_text)
        if open_dd_hits:
            sample = "; ".join(
                f"{item['rule']}={item['match']}" for item in open_dd_hits[:12]
            )
            errors.append(
                issue(
                    "OPEN_DD_LANGUAGE",
                    "terminal visible report narrates unfinished due-diligence or advisory work; move it to the internal audit layer or close it before drafting: "
                    + sample,
                    "document body",
                )
            )

        generic_defensive_hits = [
            match.group(0)
            for match in GENERIC_DEFENSIVE_JUDGMENT_PATTERN.finditer(all_text)
        ]
        if generic_defensive_hits:
            errors.append(
                issue(
                    "GENERIC_DEFENSIVE_JUDGMENT",
                    "replace generic industry/valuation disclaimers with project-specific investment evidence and a closed investment judgment",
                    generic_defensive_hits[0][:120],
                )
            )

        decision_layer_meta_hits = decision_layer_meta_language_hits(language_scope_text)
        if decision_layer_meta_hits:
            sample = "; ".join(
                f"{item['rule']}={item['match']}"
                for item in decision_layer_meta_hits[:12]
            )
            errors.append(
                issue(
                    "DECISION_LAYER_META_LANGUAGE",
                    "terminal visible report must state facts and investment judgments directly; move source, verification, narrator and methodology labels to the internal audit layer: "
                    + sample,
                    "document body",
                )
            )

        exclusionary_decision_hits = [
            match.group(0)
            for match in EXCLUSIONARY_DECISION_LANGUAGE_PATTERN.finditer(all_text)
        ]
        if exclusionary_decision_hits:
            errors.append(
                issue(
                    "EXCLUSIONARY_DECISION_LANGUAGE",
                    "terminal visible report must not narrate why facts, products, projects or metrics were excluded; omit immaterial items internally or state the final investment basis directly: "
                    + ", ".join(exclusionary_decision_hits[:12]),
                    "document body",
                )
            )

        simulated_post_investment_hits = [
            match.group(0)
            for match in SIMULATED_POST_INVESTMENT_PATTERN.finditer(all_text)
        ]
        if simulated_post_investment_hits:
            errors.append(
                issue(
                    "SIMULATED_POST_INVESTMENT_LANGUAGE",
                    "an investment recommendation/decision report must present the proposed transaction as the report's transaction terms, not as a simulation: "
                    + ", ".join(simulated_post_investment_hits[:12]),
                    "transaction/equity sections",
                )
            )

        risk_status_meta_hits = [
            match.group(0)
            for match in RISK_STATUS_META_PATTERN.finditer(all_text)
        ]
        if risk_status_meta_hits:
            errors.append(
                issue(
                    "RISK_STATUS_META_LANGUAGE",
                    "risk controls must state the concrete term, responsible party and timing without workflow labels such as 状态：已接受/交割条件: "
                    + ", ".join(risk_status_meta_hits[:12]),
                    "risk section",
                )
            )

        transaction_execution_meta_hits = [
            match.group(0)
            for match in TRANSACTION_EXECUTION_META_PATTERN.finditer(all_text)
        ]
        if transaction_execution_meta_hits:
            errors.append(
                issue(
                    "TRANSACTION_EXECUTION_META_LANGUAGE",
                    "transaction obligations must be stated as concrete terms, payment arrangements, closing steps or registration actions; reserve 口径 for accounting, valuation and calculation: "
                    + ", ".join(transaction_execution_meta_hits[:12]),
                    "transaction summary/plan",
                )
            )

        if report_stage == RECOMMENDATION_REPORT_STAGE:
            heading_value = (
                normalized_text(top_level_blocks[conclusion_indexes[-1]][0])
                if conclusion_indexes
                else ""
            )
            if "投资结论及建议" not in heading_value:
                errors.append(
                    issue(
                        "RECOMMENDATION_CONCLUSION_HEADING",
                        "investment-recommendation report heading must be 投资结论及建议",
                        heading_value or "document tail",
                    )
                )
            if len(recommendation_conclusion_paragraphs) != 3:
                errors.append(
                    issue(
                        "RECOMMENDATION_CONCLUSION_STRUCTURE",
                        "投资结论及建议 must contain exactly three natural body paragraphs: company/product positioning; industry/commercial/team foundation; concrete investment recommendation",
                        f"investment conclusion paragraphs={len(recommendation_conclusion_paragraphs)}",
                    )
                )
            if len(recommendation_conclusion_paragraphs) >= 2 and any(
                "建议" in paragraph
                for paragraph in recommendation_conclusion_paragraphs[:2]
            ):
                errors.append(
                    issue(
                        "RECOMMENDATION_PREMATURE_ADVICE",
                        "the first two conclusion paragraphs must state positioning and investment foundations directly; reserve 建议 for the third paragraph",
                        "investment conclusion",
                    )
                )
            if recommendation_conclusion_paragraphs:
                final_recommendation = recommendation_conclusion_paragraphs[-1]
                recommendation_terms_complete = bool(
                    "建议" in final_recommendation
                    and recommendation_terms_are_complete(final_recommendation)
                )
                if not recommendation_terms_complete:
                    errors.append(
                        issue(
                            "RECOMMENDATION_CONCLUSION_TERMS",
                            "the third conclusion paragraph must make one concrete investment recommendation and state investment entity, amount, pre-money valuation, transaction structure and post-investment equity",
                            final_recommendation[:160],
                        )
                    )
            risk_dump_terms = [
                term for term in RECOMMENDATION_RISK_DUMP_TERMS if term in conclusion_text
            ]
            if len(risk_dump_terms) >= 2:
                errors.append(
                    issue(
                        "RECOMMENDATION_CONCLUSION_RISK_DUMP",
                        "the recommendation conclusion must not repeat the risk/control chapter; found "
                        + ", ".join(risk_dump_terms),
                        "investment conclusion",
                    )
                )

        if report_stage == FINAL_REPORT_STAGE:
            if conclusion_indexes and "建议" in top_level_blocks[conclusion_indexes[-1]][0]:
                errors.append(
                    issue(
                        "FINAL_DECISION_HEADING",
                        "post-approval final report heading must be 投资结论, not 投资结论及建议",
                        top_level_blocks[conclusion_indexes[-1]][0],
                    )
                )
            if ADVISORY_INVESTMENT_CONCLUSION_PATTERN.search(conclusion_text):
                errors.append(
                    issue(
                        "ADVISORY_INVESTMENT_CONCLUSION",
                        "post-approval final report must state the decision rather than recommend proceeding",
                        "investment conclusion",
                    )
                )
            decisive_conclusion = bool(
                DECISIVE_INVESTMENT_CONCLUSION_PATTERN.search(conclusion_text)
                and re.search(r"投资价值|核心逻辑|交易安排|投后治理", conclusion_text)
            )
            if conclusion_indexes and not decisive_conclusion:
                errors.append(
                    issue(
                        "FINAL_DECISION_CONCLUSION",
                        "post-approval conclusion must directly state the transaction and summarize the core investment logic without approval-style wording",
                        "investment conclusion",
                    )
                )

    sects: list[ET.Element] = []
    if body is not None:
        # Count only Word's top-level section breaks. A stray sectPr nested in
        # a table or content control is not exposed by python-docx as a real
        # document section and should not distort the QA metrics.
        for child in body:
            if child.tag == Q("p"):
                section = child.find("./w:pPr/w:sectPr", NS)
                if section is not None:
                    sects.append(section)
            elif child.tag == Q("sectPr"):
                sects.append(child)
    if not 1 <= len(sects) <= 8:
        errors.append(issue("SECTION_COUNT", f"expected 1-8 sections, got {len(sects)}", "word/document.xml"))
    a4_portrait = (11906, 16838)
    a4_landscape = (16838, 11906)
    orientations: list[str] = []
    for index, sect in enumerate(sects, start=1):
        size = sect.find("w:pgSz", NS)
        if size is None:
            errors.append(issue("PAGE_SIZE", "section has no page size", f"section[{index}]"))
            continue
        width = int(size.get(Q("w"), "0"))
        height = int(size.get(Q("h"), "0"))
        portrait_ok = abs(width - a4_portrait[0]) <= 80 and abs(height - a4_portrait[1]) <= 80
        landscape_ok = abs(width - a4_landscape[0]) <= 80 and abs(height - a4_landscape[1]) <= 80
        if not (portrait_ok or landscape_ok):
            errors.append(issue("PAGE_SIZE", f"section is not A4: {width}x{height} DXA", f"section[{index}]"))
        orientations.append("landscape" if landscape_ok else "portrait")

    if not any(sect.find("w:headerReference", NS) is not None for sect in sects):
        errors.append(issue("HEADER_REFERENCE", "no header relationship is referenced", "section properties"))
    if not any(sect.find("w:footerReference", NS) is not None for sect in sects):
        errors.append(issue("FOOTER_REFERENCE", "no footer relationship is referenced", "section properties"))

    tables = document.findall(".//w:tbl", NS)
    if len(tables) < 3:
        errors.append(issue("TABLE_COUNT", f"expected at least 3 analytical tables, got {len(tables)}", "document body"))
    schema_mismatches = 0
    orphan_markers = 0
    numbered_sequence_gaps = 0
    typography_metrics: dict[str, object] = {}
    density_metrics: list[dict[str, object]] = []
    table_layout_metrics: list[dict[str, object]] = []
    if strict_sample_schema:
        if len(tables) != len(STRICT_TABLE_HEADERS):
            errors.append(
                issue(
                    "STRICT_TABLE_COUNT",
                    f"strict sample schema requires {len(STRICT_TABLE_HEADERS)} tables, got {len(tables)}",
                    "document body",
                )
            )
        for index, (table, expected) in enumerate(zip(tables, STRICT_TABLE_HEADERS), start=1):
            rows = table_rows(table)
            actual = rows[0] if rows else []
            is_org_chart = index == 10 and (
                table.find(".//w:drawing", NS) is not None
                or table.find(".//w:pict", NS) is not None
                or table.find(".//w:object", NS) is not None
            )
            if not is_org_chart and not strict_table_header_matches(index, actual, expected):
                schema_mismatches += 1
                errors.append(
                    issue(
                        "TABLE_HEADER_CONTRACT",
                        f"table {index} header mismatch: expected={expected!r}, actual={actual!r}",
                        f"table[{index}] row[1]",
                    )
                )

        required_row_labels = {
            1: ["公司名称", "成立时间", "注册地址", "实际经营地址", "法定代表人/实际控制人", "主营业务", "发展阶段", "核心判断"],
            3: ["行业所处发展阶段", "市场环境", "关键影响因素"],
            5: ["投资价值", "主要风险"],
        }
        for table_number, expected_labels in required_row_labels.items():
            if table_number > len(tables):
                continue
            rows = table_rows(tables[table_number - 1])
            actual_labels = [row[0] for row in rows if row]
            if actual_labels != expected_labels:
                errors.append(
                    issue(
                        "TABLE_ROW_LABEL_CONTRACT",
                        f"table {table_number} first-column labels mismatch: expected={expected_labels!r}, actual={actual_labels!r}",
                        f"table[{table_number}]",
                    )
                )

        if len(tables) >= 10 and not (
            tables[9].find(".//w:drawing", NS) is not None
            or tables[9].find(".//w:pict", NS) is not None
            or tables[9].find(".//w:object", NS) is not None
        ):
            personnel_rows = table_rows(tables[9])[1:]
            for row_index, row in enumerate(personnel_rows, start=2):
                if len(row) < 3:
                    errors.append(issue("PERSONNEL_ROW", "personnel row must have three populated roles", f"table[10] row[{row_index}]"))
                    continue
                if not re.search(r"\d+人", row[1]):
                    errors.append(
                        issue(
                            "PERSONNEL_COUNT",
                            f"personnel configuration cell lacks a concrete headcount: {row[1]!r}",
                            f"table[10] row[{row_index}] column[2]",
                        )
                    )
                if not row[2] or re.search(r"仍需外部|证据核验|材料列示|据.*材料|经.*核验", row[2]):
                    errors.append(
                        issue(
                            "PERSONNEL_DUTY",
                            "personnel duty must describe the team's actual responsibilities, not evidence status",
                            f"table[10] row[{row_index}] column[3]",
                        )
                    )

        if tables:
            for row in table_rows(tables[0]):
                if row and row[0] == "实际经营地址" and len(row) >= 2:
                    if re.search(r"租赁面积|租期|租赁期限|租金|同一园区|办公研发场所为", row[1]):
                        errors.append(
                            issue(
                                "OVERSPECIFIED_ADDRESS",
                                "1.1 actual operating address must contain only the confirmed address; move lease area, term, rent and park explanations to the premises/legal section",
                                "table[1] 实际经营地址",
                            )
                        )

        team_issues = team_bio_issues(top_level_nodes)
        if team_issues:
            errors.append(
                issue(
                    "TEAM_BIO_TOO_THIN",
                    "2.4 core-team biographies must cover role, education, key experience and representative work; "
                    + "; ".join(team_issues[:8]),
                    "2.4 核心团队",
                )
            )
        missing_team_members = team_member_coverage_issues(
            top_level_nodes,
            expected_team_members or [],
        )
        if missing_team_members:
            errors.append(
                issue(
                    "TEAM_MEMBER_COVERAGE",
                    "each expected core member must have a person-level Heading 3 biography; missing: "
                    + ", ".join(missing_team_members),
                    "2.4 核心团队",
                )
            )

        if not document_section_has_drawing(
            document,
            styles_by_id,
            r"^2\.5组织架构$",
        ):
            errors.append(
                issue(
                    "ORG_CHART_MISSING",
                    "2.5 must contain a readable organization chart; a plain department/personnel table is not the default final-report artifact",
                    "2.5 组织架构",
                )
            )
        org_semantic_text = document_section_semantic_text(
            document,
            styles_by_id,
            r"^2\.5组织架构$",
        )
        missing_org_labels = [
            label
            for label in (expected_org_labels or [])
            if normalized_text(label) not in org_semantic_text
        ]
        if missing_org_labels:
            errors.append(
                issue(
                    "ORG_CHART_SEMANTIC_COVERAGE",
                    "organization chart visible/alternative text is missing expected labels: "
                    + ", ".join(missing_org_labels),
                    "2.5 组织架构",
                )
            )

        if len(tables) >= 12:
            qualification_text = normalized_text(text_of(tables[11]))
            spill_hits = qualification_scope_spill_hits(qualification_text)
            if spill_hits:
                errors.append(
                    issue(
                        "QUALIFICATION_SCOPE_SPILL",
                        "table 12 is limited to qualifications, certifications and honors; move legal/risk topics out: "
                        + ", ".join(spill_hits),
                        "table[12]",
                    )
                )

        summary_sections = {
            "1.5 投资价值与风险": section_text(top_level_nodes, r"^1\.5投资价值与风险$"),
            "2.6 关联公司及关联交易": section_text(top_level_nodes, r"^2\.6关联"),
            "5.2.3/5.2.4 综合评估": section_text(top_level_nodes, r"^5\.2\.(?:3|4)综合评估$"),
            "投资结论": section_text(top_level_nodes, r"投资结论(?:及建议)?$"),
        }
        current_shareholder_text = section_text(top_level_nodes, r"^2\.3\.1公司股东$")
        if re.search(r"本轮投后|投后股东|投后持股|投后认缴", current_shareholder_text):
            errors.append(
                issue(
                    "CURRENT_SHAREHOLDER_SECTION_POST_INVESTMENT_MIX",
                    "2.3.1 must present the report-date/effective shareholder structure and actual control; move this-round post-investment ownership to 7.2 投资方案",
                    "2.3.1 公司股东",
                )
            )
        for label, value in summary_sections.items():
            matches = [match.group(0) for match in SUMMARY_NEGATIVE_METRIC_PATTERN.finditer(value)]
            if matches:
                errors.append(
                    issue(
                        "MISPLACED_FINANCIAL_METRIC",
                        f"{label} repeats raw loss/negative cash-flow metrics that belong in the financial or risk chapter: "
                        + ", ".join(matches[:8]),
                        label,
                    )
                )

        related_text = summary_sections["2.6 关联公司及关联交易"]
        immaterial_hits: list[str] = []
        for match in IMMATERIAL_PERSONAL_AMOUNT_PATTERN.finditer(related_text):
            amount_text = match.group("amount") or match.group("amount_first")
            if amount_text is not None and float(amount_text) < 10000:
                immaterial_hits.append(match.group(0))
        if immaterial_hits:
            errors.append(
                issue(
                    "IMMATERIAL_RELATED_DETAIL",
                    "2.6 contains sub-RMB10,000 personal reimbursement/advance detail; remove immaterial personal amounts from the delivered related-party table: "
                    + ", ".join(immaterial_hits[:8]),
                    "2.6 关联公司及关联交易",
                )
            )

        if len(tables) >= 11:
            related_rows = table_rows(tables[10])
            related_risk_hits = [
                match.group(0)
                for row in related_rows[1:]
                for cell in row[1:]
                for match in ASSOCIATION_RISK_NARRATIVE_PATTERN.finditer(cell)
            ]
            if related_risk_hits:
                errors.append(
                    issue(
                        "ASSOCIATION_RISK_NARRATIVE_SPILL",
                        "table 11 must state related entities, relationships, transactions and formed arrangements only; move risk interpretation to chapter 8: "
                        + ", ".join(related_risk_hits[:8]),
                        "table[11] 关联公司及关联交易",
                    )
                )

        if len(tables) >= 18:
            business_rows = table_rows(tables[17])
            business_header = business_rows[0] if business_rows else []
            duplicated_validation_headers = [
                header
                for header in business_header
                if BUSINESS_VALIDATION_HEADER_PATTERN.fullmatch(header)
            ]
            if duplicated_validation_headers:
                errors.append(
                    issue(
                        "BUSINESS_VALIDATION_COLUMN_DUPLICATION",
                        "table 18 (4.1) must describe the business model with business-adaptive fields and must not duplicate 4.2 customer contract/acceptance/payment evidence in a 商业验证 column",
                        f"table[18] headers={business_header!r}",
                    )
                )

        forbidden_headers = (
            "协议附件拟投后股东",
            "管理层CapTable模拟投后股东（两批融资全部完成）",
            "模拟投后",
            "模拟认缴",
            "模拟持股",
            "尽调材料人数/规划",
            "尽调证据",
            "资料可核验进展",
            "成熟度判断",
            "核验边界",
            "证据状态",
            "投资口径",
            "基准判断",
        )
        for table_index, table in enumerate(tables, start=1):
            rows = table_rows(table)
            header_cells = rows[0] if rows else []
            for bad_header in forbidden_headers:
                if any(bad_header in header for header in header_cells):
                    errors.append(
                        issue(
                            "FORBIDDEN_TABLE_HEADER",
                            f"deprecated/mismatched header found: {bad_header}",
                            f"table[{table_index}] row[1]",
                        )
                    )

        content_nodes = list(paragraphs) + [cell for table in tables for cell in table.findall(".//w:tc", NS)]
        for node_index, node in enumerate(content_nodes, start=1):
            value = normalized_text(text_of(node))
            if re.fullmatch(r"（\d+）", value):
                orphan_markers += 1
                errors.append(
                    issue(
                        "ORPHAN_NUMBERED_MARKER",
                        f"numbered marker has no title or content: {value}",
                        f"content-node[{node_index}]",
                    )
                )
            markers = [int(number) for number in re.findall(r"（(\d+)）", value)]
            if len(markers) >= 2:
                de_duplicated = list(dict.fromkeys(markers))
                expected_sequence = list(range(de_duplicated[0], de_duplicated[-1] + 1))
                if de_duplicated != expected_sequence:
                    numbered_sequence_gaps += 1
                    warnings.append(
                        issue(
                            "NUMBERED_SEQUENCE_GAP",
                            f"numbered sequence is discontinuous: {de_duplicated!r}",
                            f"content-node[{node_index}]",
                        )
                    )

        if report_stage in TERMINAL_REPORT_STAGES and len(tables) >= 5:
            table_5_rows = tables[4].findall("w:tr", NS)
            investment_value_cell = (
                table_5_rows[0].findall("w:tc", NS)[1]
                if table_5_rows and len(table_5_rows[0].findall("w:tc", NS)) >= 2
                else None
            )
            investment_value_text = (
                text_of(investment_value_cell) if investment_value_cell is not None else ""
            )
            defensive_matches = [
                match.group(0)
                for match in INVESTMENT_THESIS_DEFENSIVE_PATTERN.finditer(
                    investment_value_text
                )
            ]
            if defensive_matches:
                errors.append(
                    issue(
                        "INVESTMENT_THESIS_DEFENSIVE_TAIL",
                        "investment value must contain project-specific positive investment logic without defensive audit tails: "
                        + ", ".join(defensive_matches[:8]),
                        "table[5] investment value",
                    )
                )

        try:
            profile = load_style_profile(style_profile_path)
            typography_errors, typography_metrics = typography_contract(
                document,
                styles,
                styles_by_id,
                top_level_nodes,
                tables,
                target_company,
                profile,
            )
            errors.extend(typography_errors)
        except Exception as exc:
            errors.append(issue("STYLE_PROFILE_ERROR", str(exc), str(style_profile_path or "assets/style-profile.json")))

        try:
            table_profile = load_table_layout_profile(table_layout_profile_path)
            layout_errors, table_layout_metrics = table_layout_contract(
                tables,
                styles,
                table_profile,
            )
            errors.extend(layout_errors)
        except Exception as exc:
            errors.append(
                issue(
                    "TABLE_LAYOUT_PROFILE_ERROR",
                    str(exc),
                    str(table_layout_profile_path or "assets/table-layout-profile.json"),
                )
            )

        density_errors, density_warnings, density_metrics = content_density_contract(tables)
        errors.extend(density_errors)
        warnings.extend(density_warnings)
    shaded_headers = 0
    long_tables_without_repeat = 0
    fixed_rows = 0
    for table in tables:
        rows = table.findall("w:tr", NS)
        if rows:
            if rows[0].find(".//w:shd", NS) is not None:
                shaded_headers += 1
            if (
                len(rows) >= 10
                and rows[0].find(".//w:shd", NS) is not None
                and rows[0].find("./w:trPr/w:tblHeader", NS) is None
            ):
                long_tables_without_repeat += 1
        for row in rows:
            height = row.find("./w:trPr/w:trHeight", NS)
            if height is not None and height.get(Q("hRule")) == "exact":
                fixed_rows += 1
    if tables and shaded_headers == 0:
        warnings.append(issue("TABLE_HEADER_FILL", "no shaded table header row detected", "tables"))
    if long_tables_without_repeat:
        warnings.append(issue("REPEATING_HEADERS", f"{long_tables_without_repeat} long tables lack a repeating header", "tables"))
    if fixed_rows and not strict_sample_schema:
        warnings.append(issue("FIXED_ROW_HEIGHT", f"{fixed_rows} rows use exact height and may clip text", "tables"))

    rendered_pages = 0
    minimum_ink_ratio: float | None = None
    minimum_body_ink_ratio: float | None = None
    if render_dir is not None:
        pages = sorted(render_dir.glob("page-*.png"))
        rendered_pages = len(pages)
        if not pages:
            errors.append(issue("MISSING_RENDER", "no rendered page PNGs found", str(render_dir)))
        for page in pages:
            if page.stat().st_size < 5000:
                errors.append(issue("EMPTY_RENDER_PAGE", "rendered page is suspiciously small", str(page)))
        try:
            from PIL import Image

            ink_ratios: list[float] = []
            body_ink_ratios: list[tuple[Path, float]] = []
            for page in pages:
                image = Image.open(page).convert("L")
                histogram = image.histogram()
                ink_ratios.append(sum(histogram[:245]) / max(sum(histogram), 1))
                width, height = image.size
                # Exclude the header/footer bands.  A page containing only the
                # confidentiality header and page number is still a blank body
                # page and must block release.
                body_image = image.crop((0, int(height * 0.12), width, int(height * 0.88)))
                body_histogram = body_image.histogram()
                body_ink_ratios.append(
                    (page, sum(body_histogram[:245]) / max(sum(body_histogram), 1))
                )
            if ink_ratios:
                minimum_ink_ratio = min(ink_ratios)
                if minimum_ink_ratio <= 0.005:
                    errors.append(
                        issue(
                            "VISUALLY_BLANK_PAGE",
                            f"minimum rendered-page ink ratio is too low: {minimum_ink_ratio:.5f}",
                            str(render_dir),
                        )
                    )
            if body_ink_ratios:
                minimum_body_ink_ratio = min(ratio for _, ratio in body_ink_ratios)
                for page, ratio in body_ink_ratios:
                    if ratio <= 0.0005:
                        errors.append(
                            issue(
                                "VISUALLY_BLANK_BODY_PAGE",
                                f"rendered page has no material body content: ink ratio={ratio:.5f}",
                                str(page),
                            )
                        )
                split_violations = sum(
                    int(item.get("row_split_violations", 0))
                    for item in table_layout_metrics
                )
                sparse_pages = [
                    (page, ratio)
                    for page, ratio in body_ink_ratios
                    if ratio < 0.008
                ]
                if split_violations and sparse_pages:
                    samples = "; ".join(
                        f"{page.name}={ratio:.5f}" for page, ratio in sparse_pages[:5]
                    )
                    errors.append(
                        issue(
                            "TABLE_PAGINATION_WASTE",
                            "row-split violations coincide with abnormally sparse rendered page(s): " + samples,
                            str(render_dir),
                        )
                    )
        except ImportError:
            warnings.append(issue("PIL_UNAVAILABLE", "Pillow unavailable; skipped pixel-level blank-page check", str(render_dir)))

    metrics = {
        "paragraphs": len(styled),
        "h1": len(headings[1]),
        "h2": len(headings[2]),
        "h3": len(headings[3]),
        "tables": len(tables),
        "sections": len(sects),
        "orientations": orientations,
        "field_codes": len(codes),
        "rendered_pages": rendered_pages,
        "minimum_ink_ratio": minimum_ink_ratio,
        "minimum_body_ink_ratio": minimum_body_ink_ratio,
        "tracked_insertions": tracked_insertions,
        "tracked_deletions": tracked_deletions,
        "comment_marks": comment_marks,
        "comment_parts": len(comment_parts),
        "strict_sample_schema": strict_sample_schema,
        "report_stage": report_stage,
        "strict_source_contract": strict_source_contract,
        "source_contract": source_metrics,
        "expected_team_members": expected_team_members or [],
        "expected_org_labels": expected_org_labels or [],
        "final_decision_transaction_concrete": concrete_transaction,
        "final_decision_conclusion_decisive": decisive_conclusion,
        "recommendation_conclusion_paragraphs": len(recommendation_conclusion_paragraphs),
        "recommendation_terms_complete": recommendation_terms_complete,
        "visible_reasoning_label_hits": len(visible_reasoning_hits),
        "formulaic_ai_summary_hits": len(formulaic_ai_summary_hits),
        "open_dd_language_hits": len(open_dd_hits),
        "generic_defensive_judgment_hits": len(generic_defensive_hits),
        "decision_layer_meta_language_hits": len(decision_layer_meta_hits),
        "exclusionary_decision_language_hits": len(exclusionary_decision_hits),
        "simulated_post_investment_language_hits": len(simulated_post_investment_hits),
        "risk_status_meta_language_hits": len(risk_status_meta_hits),
        "transaction_execution_meta_language_hits": len(transaction_execution_meta_hits),
        "strict_table_header_mismatches": schema_mismatches,
        "orphan_numbered_markers": orphan_markers,
        "numbered_sequence_gaps": numbered_sequence_gaps,
        "visible_evidence_ids": len(visible_evidence_ids),
        "unauthorized_preface_blocks": len(unauthorized_preface_hits),
        "unauthorized_judgment_modules": len(unauthorized_judgment_hits),
        "unauthorized_post_table_narratives": len(post_table_narrative_violations),
        "typography": typography_metrics,
        "table_content_density": density_metrics,
        "table_layout": table_layout_metrics,
    }
    # Strict reference-schema mode is the release gate.  Warnings such as a
    # discontinuous numbered list are user-visible defects, so a strict run
    # cannot pass until every warning is closed or the underlying content is
    # corrected.
    strict_warning_failure = strict_sample_schema and bool(warnings)
    return {
        "status": "pass" if not errors and not strict_warning_failure else "fail",
        "errors": errors,
        "warnings": warnings,
        "metrics": metrics,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument("--forbid-term", action="append", default=[])
    parser.add_argument("--target-company")
    parser.add_argument("--require-end-marker", action="store_true")
    parser.add_argument(
        "--strict-sample-schema",
        action="store_true",
        help="enforce the reference report's cover/TOC and 27-table semantic contract",
    )
    parser.add_argument(
        "--report-stage",
        choices=(RECOMMENDATION_REPORT_STAGE, FINAL_REPORT_STAGE, IN_PROGRESS_REPORT_STAGE),
        default=RECOMMENDATION_REPORT_STAGE,
        help="investment-recommendation by default; use final-investment-decision only for an explicitly approved decision report or dd-in-progress for a working draft",
    )
    parser.add_argument(
        "--style-profile",
        type=Path,
        help="override the default assets/style-profile.json typography contract",
    )
    parser.add_argument(
        "--table-layout-profile",
        type=Path,
        help="override the default assets/table-layout-profile.json role contract",
    )
    parser.add_argument(
        "--transaction-register",
        type=Path,
        help="machine-readable current/historical transaction version register",
    )
    parser.add_argument(
        "--evidence-ledger",
        type=Path,
        help="machine-readable evidence ledger containing transaction claim_id entries",
    )
    parser.add_argument(
        "--strict-source-contract",
        action="store_true",
        help="require transaction register/evidence ledger and enforce current-round freshness",
    )
    parser.add_argument("--expected-team-member", action="append", default=[])
    parser.add_argument("--expected-org-label", action="append", default=[])
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    if args.render_dir is not None:
        ensure_runtime(("PIL",))

    result = validate(
        args.docx.resolve(),
        args.render_dir.resolve() if args.render_dir else None,
        args.forbid_term,
        args.target_company,
        args.require_end_marker,
        args.strict_sample_schema,
        args.style_profile.resolve() if args.style_profile else None,
        args.table_layout_profile.resolve() if args.table_layout_profile else None,
        args.report_stage,
        args.transaction_register.resolve() if args.transaction_register else None,
        args.evidence_ledger.resolve() if args.evidence_ledger else None,
        args.strict_source_contract,
        args.expected_team_member,
        args.expected_org_label,
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
