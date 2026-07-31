import fs from "node:fs/promises";
import path from "node:path";
import {
  createPresentation,
  ensureOutput,
  hexColor,
  imageReplacementFor,
  optionalArg,
  PptxGenJS,
  requiredArg,
  svgData,
  transparency,
} from "./public_pptx_runtime.mjs";
import { applyPageOverrides } from "./semantic_overrides.mjs";


const MODEL_PATH = requiredArg("--model");
const FINAL_PPTX = requiredArg("--output");
const OVERRIDES_PATH = optionalArg("--overrides");
const BUILD_MANIFEST_PATH = optionalArg("--build-manifest");


function drawingSvg(drawing) {
  const [x0, y0, x1, y1] = drawing.bbox;
  const bleed = Math.max(1, Number(drawing.stroke_width || 0) / 2 + 0.5);
  const left = x0 - bleed;
  const top = y0 - bleed;
  const width = Math.max(0.1, x1 - x0 + bleed * 2);
  const height = Math.max(0.1, y1 - y0 + bleed * 2);
  const local = (point) => [point[0] - left, point[1] - top];
  let commands = "";
  let current = null;
  const move = (point) => {
    if (
      !current
      || Math.abs(current[0] - point[0]) > 0.01
      || Math.abs(current[1] - point[1]) > 0.01
    ) {
      commands += `M ${point[0]} ${point[1]} `;
    }
  };
  for (const item of drawing.items || []) {
    if (item.kind === "line") {
      const start = local(item.p1);
      const end = local(item.p2);
      move(start);
      commands += `L ${end[0]} ${end[1]} `;
      current = end;
    } else if (item.kind === "curve") {
      const start = local(item.p1);
      const control1 = local(item.c1);
      const control2 = local(item.c2);
      const end = local(item.p2);
      move(start);
      commands += `C ${control1[0]} ${control1[1]} ${control2[0]} ${control2[1]} ${end[0]} ${end[1]} `;
      current = end;
    } else if (item.kind === "rect") {
      const start = local([item.rect[0], item.rect[1]]);
      const end = local([item.rect[2], item.rect[3]]);
      commands += `M ${start[0]} ${start[1]} H ${end[0]} V ${end[1]} H ${start[0]} Z `;
      current = start;
    } else if (item.kind === "quad") {
      const points = item.points.map(local);
      commands += `M ${points[0][0]} ${points[0][1]} `;
      for (const point of points.slice(1)) {
        commands += `L ${point[0]} ${point[1]} `;
      }
      commands += "Z ";
      current = points[0];
    }
  }
  if (drawing.close_path) commands += "Z";
  const fill = drawing.draw_type?.includes("f")
    ? drawing.fill || "#000000"
    : "none";
  const stroke = drawing.draw_type?.includes("s")
    ? drawing.stroke || "#000000"
    : "none";
  const dashMatch = String(drawing.dashes || "").match(/\[([^\]]*)\]/);
  const dash = dashMatch && dashMatch[1].trim()
    ? ` stroke-dasharray="${dashMatch[1].trim().replace(/\s+/g, ",")}"`
    : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<path d="${commands}" fill="${fill}" fill-opacity="${Number(drawing.fill_opacity ?? 1)}" fill-rule="${drawing.even_odd ? "evenodd" : "nonzero"}"`,
    ` stroke="${stroke}" stroke-opacity="${Number(drawing.stroke_opacity ?? 1)}" stroke-width="${Number(drawing.stroke_width || 0)}"${dash}/></svg>`,
  ].join("");
  return { svg, left, top, width, height };
}


function addDrawing(slide, drawing, unit, index) {
  const vector = drawingSvg(drawing);
  slide.addImage({
    data: svgData(vector.svg),
    x: vector.left * unit,
    y: vector.top * unit,
    w: vector.width * unit,
    h: vector.height * unit,
    objectName: `pdf-vector-${String(index + 1).padStart(4, "0")}`,
  });
}


function addImage(slide, element, unit, index, replacement = null) {
  const [x0, y0, x1, y1] = element.bbox;
  const asset = replacement?.asset || element.asset;
  const width = Math.max(0.01, (x1 - x0) * unit);
  const height = Math.max(0.01, (y1 - y0) * unit);
  slide.addImage({
    path: asset,
    x: x0 * unit,
    y: y0 * unit,
    w: width,
    h: height,
    rotate: Math.abs(Number(element.rotation || 0)) < 0.05
      ? 0
      : Number(element.rotation),
    altText:
      replacement?.alt
      || `PDF 图片 ${index + 1}${replacement ? "（已复核替换槽位）" : ""}`,
    objectName: `pdf-image-${String(index + 1).padStart(4, "0")}`,
  });
}


function addText(slide, element, unit, index) {
  const [x0, y0, x1, y1] = element.bbox;
  const fontSize = Math.max(1, Number(element.font_size || 10));
  const rotation = Math.atan2(
    Number(element.direction?.[1] || 0),
    Number(element.direction?.[0] || 1),
  ) * 180 / Math.PI;
  const richRuns = Array.isArray(element.runs) && element.runs.length
    ? element.runs
      .filter((run) => String(run.text || "").length)
      .map((run) => ({
        text: String(run.text || ""),
        options: {
          fontFace: run.font || element.font || "Noto Sans CJK SC",
          fontSize: Math.max(
            1,
            Number(run.font_size || element.font_size || 10),
          ),
          bold: Boolean(run.bold),
          italic: Boolean(run.italic),
          color: hexColor(run.color || element.color),
          transparency: transparency(
            run.opacity ?? element.opacity,
          ),
          breakLine: false,
        },
      }))
    : null;
  slide.addText(richRuns || String(element.text || ""), {
    x: x0 * unit,
    y: y0 * unit,
    w: Math.max(0.04, (x1 - x0) * unit + 0.04),
    h: Math.max(fontSize / 72 * 1.25, (y1 - y0) * unit + 0.02),
    fontFace: element.font || "Noto Sans CJK SC",
    fontSize,
    bold: Boolean(element.bold),
    italic: Boolean(element.italic),
    color: hexColor(element.color),
    transparency: transparency(element.opacity),
    margin: 0,
    breakLine: false,
    fit: "shrink",
    valign: "top",
    rotate: Math.abs(rotation) > 0.05 ? rotation : 0,
    objectName: `${
      Number(element.source_line_count || 1) > 1
        ? "pdf-paragraph"
        : "pdf-text"
    }-${String(index + 1).padStart(4, "0")}`,
  });
}


async function main() {
  await ensureOutput(FINAL_PPTX);
  const model = JSON.parse(await fs.readFile(MODEL_PATH, "utf8"));
  const overrides = OVERRIDES_PATH
    ? JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"))
    : { slides: {} };
  const { pptx, unit, slideWidth } = createPresentation(
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
    slide.background = { color: "FFFFFF" };
    const pageOverride = overrides.slides?.[String(page.number)] || {};
    for (const [index, element] of page.elements.entries()) {
      if (element.kind === "drawing") {
        addDrawing(slide, element, unit, index);
      } else if (element.kind === "image") {
        addImage(
          slide,
          element,
          unit,
          index,
          imageReplacementFor(element, index, pageOverride),
        );
      } else if (element.kind === "text") {
        addText(slide, element, unit, index);
      }
    }
    buildManifest.objects.push(...applyPageOverrides({
      slide,
      pptx,
      pageOverride,
      pageNumber: page.number,
      slideWidth,
      coordinateWidth: Number(overrides.coordinateWidth || 1280),
    }));
    slide.addNotes(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- 页面文字、图片和矢量对象均从该页提取并重建。`,
    );
    console.log(
      `已生成第 ${page.number} 页，${page.elements.length} 个可编辑或可替换对象`,
    );
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
