#!/usr/bin/env python3
"""Repair flattened OCR backgrounds and text colors for dark Gorden slides."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


DROP_TEXT = {"|", "a", "=", "会", "_4", "fia", "| [>] eve", "•", "¥", "！", "晶", "IP"}

EXACT = {
    1: {
        "灵动力投资建议书": "智灵动力投资建议书",
        "智灵动力 (北京 ) 科技有限公司": "智灵动力（北京）科技有限公司",
        "从产品能力 、 商业验证到交易可行性的五页判断": "从产品能力、商业验证到交易可行性的五页判断",
        "内部讨论稿 | 年 8 月": "内部讨论稿｜2026年8月",
    },
    2: {
        "(01 公司已形成三条产品线 ， 但底层技术与业务归属仍需核": "01 公司已形成三条产品线，但底层技术与业务归属仍需核实",
        "一官方定位 : 科创研究与文创视听智能体 “一": "官方定位：科创研究与文创视听智能体",
        "e 数字人智能体": "数字人智能体",
        "Al-AutoResearch": "AI-AutoResearch",
        "自进化 Al 框架": "自进化 AI 框架",
        "O 关键判断 : 产品矩阵可核对 ， 技术权属 、 测斌结果与业务资产归属仍需专项核实": "关键判断：产品矩阵可核对，技术权属、测试结果与业务资产归属仍需专项核实",
        "司官网 、 华为云 、 项目会议纪要 、 算法工厂技术材料": "公司官网、华为云、项目会议纪要、算法工厂技术材料",
    },
    3: {
        "02 | 商业化信号已出现 ， 但合同 、 验收与回款仍需穿透核实": "02 商业化信号已出现，但合同、验收与回款仍需穿透核实",
        "FDE | 2026 年 5 月启动商业化": "FDE｜2026年5月启动商业化",
        "算法优化 | 在谈项目": "算法优化｜在谈项目",
        "。 成素科技 : 约 180 万元": "成泰科技：约180万元",
        "e £8: 60 万元 ， 流程推进中 ， 已完成 Demo": "集鑫：60万元，流程推进中，已完成 Demo",
        "500 元 /分钟": "500元/分钟",
        "10000 分钟": "10000分钟",
    },
    4: {
        "03) | 高人力成本本加交易口径冲突 ， 现金流安全边界尚不清晰": "03 高人力成本叠加交易口径冲突，现金流安全边界尚不清晰",
        "082 1384": "138人",
        "(人当前人员规模": "当前人员规模",
        "约 2400 万元 /年": "约2400万元/年",
        "现金流安排 (管理层口径 )": "现金流安排（管理层口径）",
        "| 老股东拟提供 1000 万元借款": "老股东拟提供1000万元借款",
        "| 管理层称可覆盖约半年现金需求": "管理层称可覆盖约半年现金需求",
        "| 借款协议 、 期限 、 利率与提款条件尚待核实": "借款协议、期限、利率与提款条件尚待核实",
        "10 亿 -15 亿元": "10亿-15亿元",
        "| (1) 投资影响 : 审计财务 、 现金流水平和正式条款明确前 ， 估值合理性无法判断": "投资影响：审计财务、现金流水平和正式条款明确前，估值合理性无法判断",
        "国来源 : 项目会议纪要 、 投资中台项目记录": "来源：项目会议纪要、投资中台项目记录",
    },
    5: {
        "04 | 暂不形成确定性投资结论 ， 五项事实决定交易是否成立": "04 暂不形成确定性投资结论，五项事实决定交易是否成立",
        "B 技术材料显示算法优化": "技术材料显示算法优化",
        "结论 : 五项关键事实明确前 ， 不对估值和投资金额作确定性判断": "结论：五项关键事实明确前，不对估值和投资金额作确定性判断",
        "[WO 责任声明 : 本材料仅供内部审议 ， 不构成最终投资决策": "责任声明：本材料仅供内部审议，不构成最终投资决策",
        "[2) 来源 : 公司官网 、 项目会议纪要 、 投资中台项目记录": "来源：公司官网、项目会议纪要、投资中台项目记录",
    },
}


def color_hex(pixels: np.ndarray) -> str:
    if pixels.size == 0:
        return "#E6F1FF"
    brightness = pixels.max(axis=1)
    cutoff = np.percentile(brightness, 65)
    selected = pixels[brightness >= cutoff]
    bgr = np.median(selected, axis=0).astype(int)
    rgb = [int(bgr[2]), int(bgr[1]), int(bgr[0])]
    if max(rgb) < 105:
        rgb = [230, 241, 255]
    return "#%02X%02X%02X" % tuple(rgb)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--background-dir", required=True)
    parser.add_argument("--preserve-source-background", action="store_true")
    parser.add_argument("--background-mode", choices=("inpaint", "flat", "source"), default="inpaint")
    args = parser.parse_args()

    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    background_dir = Path(args.background_dir).resolve()
    background_dir.mkdir(parents=True, exist_ok=True)
    model = json.loads(source.read_text(encoding="utf-8"))

    for page in model["pages"]:
        page_no = int(page["number"])
        image = cv2.imread(str(Path(page["source_image"])), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"cannot read {page['source_image']}")
        height, width = image.shape[:2]
        slide_w, slide_h = float(page["width"]), float(page["height"])
        mask = np.zeros((height, width), dtype=np.uint8)
        flat_cleaned = image.copy()
        kept = []
        for item in page["text"]:
            raw = item["text"].strip()
            if raw in DROP_TEXT or (len(raw) <= 2 and not raw.isdigit()):
                continue
            item["text"] = EXACT.get(page_no, {}).get(raw, raw)
            x0 = max(0, int(round(item["left"] / slide_w * width)))
            y0 = max(0, int(round(item["top"] / slide_h * height)))
            x1 = min(width, int(round((item["left"] + item["width"]) / slide_w * width)))
            y1 = min(height, int(round((item["top"] + item["height"]) / slide_h * height)))
            if x1 <= x0 or y1 <= y0:
                continue
            crop = image[y0:y1, x0:x1]
            border = np.concatenate((crop[:2].reshape(-1, 3), crop[-2:].reshape(-1, 3), crop[:, :2].reshape(-1, 3), crop[:, -2:].reshape(-1, 3)), axis=0)
            bg = np.median(border, axis=0)
            flat_cleaned[y0:y1, x0:x1] = bg.astype(np.uint8)
            distance = np.linalg.norm(crop.astype(np.float32) - bg.astype(np.float32), axis=2)
            bright = crop.max(axis=2)
            local = (((distance > 34) & (bright > 70)) | (bright > 175)).astype(np.uint8) * 255
            local = cv2.morphologyEx(local, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
            local = cv2.dilate(local, np.ones((2, 2), np.uint8), iterations=1)
            mask[y0:y1, x0:x1] = np.maximum(mask[y0:y1, x0:x1], local)
            item["color"] = color_hex(crop[local > 0])
            item["font"] = "Arial Unicode MS"
            item["bold"] = bool(item.get("bold") or item.get("text_role") in {"slide-title", "display-title"})
            kept.append(item)
        mode = "source" if args.preserve_source_background else args.background_mode
        if mode == "source":
            cleaned = image
        elif mode == "flat":
            cleaned = flat_cleaned
        else:
            cleaned = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
        clean_path = background_dir / f"slide-{page_no:02d}-glyph-clean.png"
        if not cv2.imwrite(str(clean_path), cleaned):
            raise RuntimeError(f"cannot write {clean_path}")
        page["background"] = str(clean_path)
        page["text"] = kept

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
