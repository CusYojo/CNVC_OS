import fs from "node:fs/promises";
import path from "node:path";
import PptxGenJS from "pptxgenjs";


export function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`缺少必需参数：${name}`);
  }
  return path.resolve(process.argv[index + 1]);
}


export function optionalArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1])
    : fallback;
}


export function hexColor(value, fallback = "000000") {
  const normalized = String(value || fallback)
    .replace(/^#/, "")
    .split("/")[0]
    .toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}


export function transparency(opacity = 1) {
  return Math.max(0, Math.min(100, Math.round((1 - Number(opacity || 0)) * 100)));
}


export function svgData(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}


export function createPresentation(pageWidth, pageHeight) {
  const slideWidth = 13.333333;
  const slideHeight = slideWidth * pageHeight / pageWidth;
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "PDF_TEMPLATE",
    width: slideWidth,
    height: slideHeight,
  });
  pptx.layout = "PDF_TEMPLATE";
  pptx.author = "Cybernaut";
  pptx.subject = "PDF template converted to editable PPTX";
  pptx.company = "Cybernaut";
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: "Noto Sans CJK SC",
    bodyFontFace: "Noto Sans CJK SC",
    lang: "zh-CN",
  };
  return {
    pptx,
    slideWidth,
    slideHeight,
    unit: slideWidth / pageWidth,
  };
}


export function imageReplacementFor(element, index, pageOverride = {}) {
  const assetName = path.basename(element.asset || "");
  return (pageOverride.imageReplacements || []).find((replacement) => (
    (replacement.sourceAsset && replacement.sourceAsset === element.asset)
    || (
      replacement.sourceAssetName
      && replacement.sourceAssetName === assetName
    )
    || (
      Number.isInteger(replacement.elementIndex)
      && replacement.elementIndex === index
    )
  ));
}


export async function ensureOutput(output) {
  await fs.mkdir(path.dirname(output), { recursive: true });
}


export { PptxGenJS };
