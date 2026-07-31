import fs from "node:fs/promises";
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

function pptFontSize(value, calibrated = false, bottomCaption = false) {
  const size = Math.max(7.5, Number(value || 10));
  if (calibrated) return size;
  const normalSize = size >= 80 ? size * 0.98 : size * 0.9;
  if (!bottomCaption) return normalSize;
  return normalSize * (size > 24 ? 0.72 : 0.8);
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
    schemaVersion: "1.0",
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
    for (const [index, item] of page.text.entries()) {
      const textX = Math.max(0, item.left * scale - 0.01);
      const textY = Math.max(0, item.top * scale - 0.01);
      const isTopTitle = (
        !item.vertical
        && Number(item.top || 0) < 100
        && Number(item.font_size || 0) >= 30
      );
      const preferredWidth = isTopTitle
        ? slideWidth - textX - 0.08
        : item.width * scale * 1.2;
      const textWidth = Math.max(
        0.08,
        Math.min(slideWidth - textX, preferredWidth),
      );
      const groupedLineCount = Number(item.source_line_count || 1);
      const bottomCaption = (
        Number(item.top || 0) > Number(page.height || 720) * 0.86
      );
      const preferredHeight = (
        item.height
        * scale
        * (groupedLineCount > 1 ? 1.04 : 1.08)
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
            fontSize: pptFontSize(
              run.font_size_pt || run.font_size || item.font_size_pt
                || item.font_size || 10,
              Boolean(
                run.font_size_pt
                || item.font_size_pt
                || item.typography_calibrated
              ),
              bottomCaption,
            ),
            bold: Boolean(run.bold),
            italic: Boolean(run.italic),
            color: hexColor(run.color || item.color, "172033"),
          },
        }))
        : verticalText;
      const objectName =
        `${
          groupedLineCount > 1
            ? "ocr-paragraph"
            : "ocr-text"
        }-p${String(page.number).padStart(2, "0")}`
        + `-${String(index + 1).padStart(3, "0")}`;
      slide.addText(richText, {
        x: textX,
        y: textY,
        w: textWidth,
        h: textHeight,
        fontFace: item.font || "Noto Sans CJK SC",
        fontSize: pptFontSize(
          item.font_size_pt || item.font_size || 10,
          Boolean(item.font_size_pt || item.typography_calibrated),
          bottomCaption,
        ),
        bold: Boolean(item.bold),
        color: hexColor(item.color, "172033"),
        margin: 0,
        fit: "shrink",
        valign: "top",
        breakLine: false,
        objectName,
      });
      buildManifest.objects.push({
        page: page.number,
        name: objectName,
        type: "texts",
        source: "ocr",
        emitted: true,
        text: verticalText,
        sourceLineCount: groupedLineCount,
        styleId: item.style_id || null,
        fontFace: item.font || "Noto Sans CJK SC",
        fontSizePt: Number(item.font_size_pt || item.font_size || 10),
        typographyCalibrated: Boolean(
          item.font_size_pt || item.typography_calibrated
        ),
      });
    }
    const pageOverride = overrides.slides?.[String(page.number)] || {};
    buildManifest.objects.push(...applyPageOverrides({
      slide,
      pptx,
      pageOverride,
      pageNumber: page.number,
      slideWidth,
      coordinateWidth: Number(overrides.coordinateWidth || 1280),
    }));
    slide.addNotes(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- 背景由原页清除文字后生成，文字由 OCR 元素化重建。`,
    );
    console.log(`已生成第 ${page.number} 页，${page.text.length} 个 OCR 文字对象`);
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
