import fs from "node:fs/promises";
import {
  createPresentation,
  ensureOutput,
  hexColor,
  requiredArg,
} from "./public_pptx_runtime.mjs";


const MODEL_PATH = requiredArg("--model");
const FINAL_PPTX = requiredArg("--output");


async function main() {
  await ensureOutput(FINAL_PPTX);
  const model = JSON.parse(await fs.readFile(MODEL_PATH, "utf8"));
  const { pptx, slideWidth, slideHeight } = createPresentation(
    model.page_width,
    model.page_height,
  );
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
      const verticalText = item.vertical
        ? String(item.text || "").split("").join("\n")
        : String(item.text || "");
      slide.addText(verticalText, {
        x: Math.max(0, item.left * scale - 0.01),
        y: Math.max(0, item.top * scale - 0.01),
        w: Math.max(0.08, item.width * scale * (item.vertical ? 1.2 : 1.08)),
        h: Math.max(0.08, item.height * scale * 1.3),
        fontFace: item.font || "Noto Sans CJK SC",
        fontSize: Math.max(7.5, Number(item.font_size || 10)),
        bold: Boolean(item.bold),
        color: hexColor(item.color, "172033"),
        margin: 0,
        fit: "shrink",
        valign: "top",
        breakLine: false,
        objectName:
          `ocr-text-p${String(page.number).padStart(2, "0")}`
          + `-${String(index + 1).padStart(3, "0")}`,
      });
    }
    slide.addNotes(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- 背景由原页清除文字后生成，文字由 OCR 元素化重建。`,
    );
    console.log(`已生成第 ${page.number} 页，${page.text.length} 行 OCR 文字`);
  }
  await pptx.writeFile({ fileName: FINAL_PPTX, compression: true });
  console.log(`已保存 ${FINAL_PPTX}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
