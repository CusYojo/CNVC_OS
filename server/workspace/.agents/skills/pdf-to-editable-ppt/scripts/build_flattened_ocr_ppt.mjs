import fs from "node:fs/promises";
import path from "node:path";
import {
  createPresentation,
  ensureOutput,
  hexColor,
  optionalArg,
  requiredArg,
} from "./public_pptx_runtime.mjs";
import { applyPageOverrides } from "./semantic_overrides.mjs";


const MODEL_PATH = requiredArg("--model");
const FINAL_PPTX = requiredArg("--output");
const OVERRIDES_PATH = optionalArg("--overrides");
const BUILD_MANIFEST_PATH = optionalArg("--build-manifest");


function resolvedFontSize(item, value) {
  const calibrated = Number(value || item.ppt_font_size || 0);
  if (calibrated > 0) return Math.max(5, calibrated);
  const legacy = Number(item.font_size || 10);
  const role = item.text_role || "body";
  return Math.max(5, legacy * (
    ["display-title", "display-number"].includes(role) ? 0.98 : 0.75
  ));
}


function pointInTextRegion(item, region, page) {
  const normalized = (
    Number(region.width || 0) <= 1
    && Number(region.height || 0) <= 1
    && Number(region.x || 0) <= 1
    && Number(region.y || 0) <= 1
  );
  const factorX = normalized ? Number(page.width || 1280) : 1;
  const factorY = normalized ? Number(page.height || 720) : 1;
  const left = Number(region.x ?? region.left ?? 0) * factorX;
  const top = Number(region.y ?? region.top ?? 0) * factorY;
  const width = Number(region.width || 0) * factorX;
  const height = Number(region.height || 0) * factorY;
  const centerX = Number(item.left || 0) + Number(item.width || 0) / 2;
  const centerY = Number(item.top || 0) + Number(item.height || 0) / 2;
  return (
    centerX >= left
    && centerX <= left + width
    && centerY >= top
    && centerY <= top + height
  );
}


async function main() {
  await ensureOutput(FINAL_PPTX);
  const model = JSON.parse(await fs.readFile(MODEL_PATH, "utf8"));
  const overrides = OVERRIDES_PATH
    ? JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"))
    : { slides: {} };
  const { pptx, slideWidth, slideHeight } = createPresentation(
    model.page_width,
    model.page_height,
  );
  const buildManifest = {
    schemaVersion: "1.1",
    output: FINAL_PPTX,
    objects: [],
  };

  for (const page of model.pages) {
    const slide = pptx.addSlide();
    slide.addImage({
      path: page.background,
      x: 0,
      y: 0,
      w: slideWidth,
      h: slideHeight,
      objectName: `ocr-clean-background-${page.number}`,
      altText: `第 ${page.number} 页已清除文字的背景`,
    });
    const scale = slideWidth / page.width;
    const pageOverride = overrides.slides?.[String(page.number)] || {};
    const skipTextRegions = pageOverride.skipTextRegions || [];
    let emittedText = 0;

    for (const [index, item] of page.text.entries()) {
      if (skipTextRegions.some((region) => pointInTextRegion(item, region, page))) {
        buildManifest.objects.push({
          page: page.number,
          semanticId: null,
          type: "ocr-text",
          emitted: false,
          error: "suppressed-by-semantic-override",
          sourceIndex: index,
        });
        continue;
      }
      const textX = Math.max(0, item.left * scale - 0.01);
      const textY = Math.max(0, item.top * scale - 0.01);
      const role = item.text_role || "body";
      const isTopTitle = ["slide-title", "display-title"].includes(role);
      const widthFactor = Number(item.text_box_width_factor || 1.2);
      const preferredWidth = isTopTitle
        ? slideWidth - textX - 0.08
        : item.width * scale * (item.vertical ? 1.15 : widthFactor);
      const textWidth = Math.max(
        0.08,
        Math.min(slideWidth - textX, preferredWidth),
      );
      const groupedLineCount = Number(item.source_line_count || 1);
      const preferredHeight = (
        item.height
        * scale
        * (groupedLineCount > 1 ? 1.04 : 1.12)
      );
      const textHeight = Math.max(
        0.05,
        Math.min(slideHeight - textY - 0.02, preferredHeight),
      );
      const verticalText = item.vertical
        ? String(item.text || "").split("").join("\n")
        : String(item.text || "");
      const richText = Array.isArray(item.runs) && item.runs.length
        ? item.runs.map((run) => ({
          text: String(run.text || ""),
          options: {
            fontFace: run.font || item.font || "Noto Sans CJK SC",
            fontSize: resolvedFontSize(item, run.ppt_font_size || run.font_size),
            bold: Boolean(run.bold),
            italic: Boolean(run.italic),
            color: hexColor(run.color || item.color, "172033"),
          },
        }))
        : verticalText;
      const objectName = (
        `${groupedLineCount > 1 ? "ocr-paragraph" : "ocr-text"}`
        + `-p${String(page.number).padStart(2, "0")}`
        + `-${String(index + 1).padStart(3, "0")}`
      );
      slide.addText(richText, {
        x: textX,
        y: textY,
        w: textWidth,
        h: textHeight,
        fontFace: item.font || "Noto Sans CJK SC",
        fontSize: resolvedFontSize(item),
        bold: Boolean(item.bold),
        color: hexColor(item.color, "172033"),
        margin: 0,
        fit: "shrink",
        valign: "top",
        breakLine: false,
        objectName,
      });
      emittedText += 1;
      buildManifest.objects.push({
        page: page.number,
        semanticId: objectName,
        type: "ocr-text",
        emitted: true,
        role,
        fontFace: item.font || "Noto Sans CJK SC",
        fontSize: resolvedFontSize(item),
      });
    }

    buildManifest.objects.push(...applyPageOverrides({
      slide,
      pptx,
      pageOverride,
      pageNumber: page.number,
      slideWidth,
      coordinateWidth: Number(overrides.coordinateWidth || page.width || 1280),
      assetRoot: OVERRIDES_PATH ? path.dirname(OVERRIDES_PATH) : process.cwd(),
    }));
    slide.addNotes(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- 背景由原页清除文字后生成；文字、图标、图形、图表和表格按可编辑对象重建。`,
    );
    console.log(`已生成第 ${page.number} 页，${emittedText} 个 OCR 文字对象`);
  }

  await pptx.writeFile({ fileName: FINAL_PPTX, compression: true });
  if (BUILD_MANIFEST_PATH) {
    await ensureOutput(BUILD_MANIFEST_PATH);
    await fs.writeFile(
      BUILD_MANIFEST_PATH,
      JSON.stringify(buildManifest, null, 2),
      "utf8",
    );
  }
  console.log(`已保存 ${FINAL_PPTX}`);
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
