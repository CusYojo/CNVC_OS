import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";


const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));


function candidateRoots() {
  return [...new Set([
    process.env.PDF_TO_PPT_ARTIFACT_TOOL_ROOT,
    process.env.ARTIFACT_TOOL_NODE_PROJECT_ROOT,
    process.env.AI_PDF_TO_PPT_NODE_PROJECT_ROOT,
    process.cwd(),
    scriptDirectory,
  ].filter(Boolean).map((root) => path.resolve(root)))];
}


function loadPackage(packageName) {
  const attempts = [];
  for (const root of candidateRoots()) {
    try {
      const projectRequire = createRequire(path.join(root, "package.json"));
      const loaded = projectRequire(packageName);
      return { loaded: loaded.default || loaded, root, attempts };
    } catch (error) {
      attempts.push(`${root}: ${error.code || error.message}`);
    }
  }
  return { loaded: null, root: null, attempts };
}


function selectBackend() {
  const requested = String(
    process.env.AI_PDF_TO_PPT_BUILDER_BACKEND || "auto",
  ).trim().toLowerCase();
  if (!["auto", "artifact-tool", "pptxgenjs"].includes(requested)) {
    throw new Error(
      "AI_PDF_TO_PPT_BUILDER_BACKEND 必须是 auto、artifact-tool 或 pptxgenjs",
    );
  }

  if (requested !== "pptxgenjs") {
    const artifact = loadPackage("@oai/artifact-tool");
    if (artifact.loaded) {
      return {
        name: "artifact-tool",
        module: artifact.loaded,
        root: artifact.root,
      };
    }
    if (requested === "artifact-tool") {
      throw new Error(
        "无法加载 @oai/artifact-tool；请将 PDF_TO_PPT_ARTIFACT_TOOL_ROOT "
        + "指向包含 node_modules/@oai/artifact-tool 的运行时目录。已尝试："
        + artifact.attempts.join("；"),
      );
    }
  }

  const pptxgenjs = loadPackage("pptxgenjs");
  if (pptxgenjs.loaded) {
    return {
      name: "pptxgenjs",
      module: pptxgenjs.loaded,
      root: pptxgenjs.root,
    };
  }
  throw new Error(
    "无法加载 PPTX 构建后端；Codex 环境请配置 "
    + "PDF_TO_PPT_ARTIFACT_TOOL_ROOT，兼容部署请配置 "
    + "AI_PDF_TO_PPT_NODE_PROJECT_ROOT。已尝试："
    + pptxgenjs.attempts.join("；"),
  );
}


const selectedBackend = selectBackend();
export const runtimeBackend = selectedBackend.name;


export function portableTypeface(value) {
  const requested = String(value || "Noto Sans CJK SC");
  if (process.platform === "darwin" && /^Noto Sans CJK/i.test(requested)) {
    return "PingFang SC";
  }
  if (process.platform === "win32" && /^Noto Sans CJK/i.test(requested)) {
    return "Microsoft YaHei";
  }
  return requested;
}


function colorWithTransparency(color, transparencyValue = 0, fallback = "000000") {
  const normalized = hexColor(color, fallback);
  const transparencyNumber = Number(transparencyValue || 0);
  const opacity = Math.max(0, Math.min(100, 100 - transparencyNumber));
  if (opacity >= 100) return `#${normalized}`;
  if (opacity <= 0) return "none";
  return `#${normalized}/${opacity}`;
}


function artifactFill(value, fallback = "FFFFFF") {
  if (value === "none" || value?.type === "none") return "none";
  if (typeof value === "string") {
    return value.startsWith("#") ? value : `#${hexColor(value, fallback)}`;
  }
  if (value && typeof value === "object") {
    const color = value.color || value.fill || fallback;
    return colorWithTransparency(color, value.transparency, fallback);
  }
  return `#${hexColor(fallback, fallback)}`;
}


function artifactLine(value = {}) {
  const hidden = (
    value.fill === "none"
    || value.color === "none"
    || Number(value.width || value.weight || 0) <= 0
    || Number(value.transparency || 0) >= 100
  );
  return {
    style: {
      dash: "dashed",
      dashed: "dashed",
      dot: "dotted",
      dotted: "dotted",
    }[value.dash || value.style] || "solid",
    fill: hidden
      ? "none"
      : colorWithTransparency(
        value.color || value.fill,
        value.transparency,
        "000000",
      ),
    width: hidden
      ? 0
      : Math.max(0.1, Number(value.width || value.weight || 1) * 96 / 72),
  };
}


function artifactPosition(value = {}) {
  return {
    left: Number(value.x || 0),
    top: Number(value.y || 0),
    width: Math.max(0.01, Number(value.w || 0.01)),
    height: Math.max(0.01, Number(value.h || 0.01)),
    rotation: Number(value.rotate || 0),
  };
}


function artifactTextStyle(options = {}) {
  const margin = Array.isArray(options.margin)
    ? options.margin
    : [options.margin || 0, options.margin || 0, options.margin || 0, options.margin || 0];
  return {
    typeface: portableTypeface(options.fontFace),
    fontSizePt: Math.max(1, Number(options.fontSize || 14)),
    bold: Boolean(options.bold),
    italic: Boolean(options.italic),
    color: colorWithTransparency(
      options.color,
      options.transparency,
      "202020",
    ),
    alignment: options.align || "left",
    verticalAlignment: options.valign === "mid"
      ? "middle"
      : (options.valign || "top"),
    autoFit: options.fit === "none" ? "none" : "shrinkText",
    wrap: options.wrap === false ? "none" : "square",
    insets: {
      top: Number(margin[0] || 0),
      right: Number(margin[1] || 0),
      bottom: Number(margin[2] || 0),
      left: Number(margin[3] || 0),
    },
  };
}


function structuredText(value) {
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((item) => ({
    run: String(item?.text ?? ""),
    textStyle: {
      typeface: portableTypeface(item?.options?.fontFace),
      fontSize: `${Math.max(1, Number(item?.options?.fontSize || 14))}pt`,
      bold: Boolean(item?.options?.bold),
      italic: Boolean(item?.options?.italic),
      color: colorWithTransparency(
        item?.options?.color,
        item?.options?.transparency,
        "202020",
      ),
    },
  }));
}


function imageContentType(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  }[extension] || "image/png";
}


class ArtifactElementAdapter {
  constructor(element) {
    this.element = element;
  }
}


class ArtifactSlideAdapter {
  constructor(slide) {
    this.slide = slide;
  }

  set background(value) {
    this.slide.background.fill = artifactFill(value?.color || value, "FFFFFF");
  }

  addShape(geometry, options = {}) {
    const shape = this.slide.shapes.add({
      geometry: String(geometry || "rect"),
      name: options.objectName,
      position: artifactPosition(options),
      fill: artifactFill(options.fill || "none"),
      line: artifactLine(options.line || {}),
    });
    return new ArtifactElementAdapter(shape);
  }

  addText(value, options = {}) {
    const shape = this.slide.shapes.add({
      geometry: "textbox",
      name: options.objectName,
      position: artifactPosition(options),
      fill: "none",
      line: { style: "solid", fill: "none", width: 0 },
    });
    shape.text = structuredText(value);
    shape.text.style = artifactTextStyle(options);
    return new ArtifactElementAdapter(shape);
  }

  addImage(options = {}) {
    const source = options.data
      ? { dataUrl: options.data }
      : {
        blob: fs.readFileSync(path.resolve(options.path)),
        contentType: imageContentType(options.path),
      };
    const image = this.slide.images.add({
      ...source,
      name: options.objectName,
      alt: options.altText || "",
      fit: "contain",
      position: artifactPosition(options),
    });
    if (Number(options.rotate || 0)) image.rotation = Number(options.rotate);
    try {
      if (options.objectName) image.name = options.objectName;
    } catch {
      // Older artifact-tool releases may not expose a writable image name.
    }
    return new ArtifactElementAdapter(image);
  }

  addTable(rows, options = {}) {
    const values = Array.isArray(rows) ? rows : [];
    const rowCount = Math.max(1, values.length);
    const columnCount = Math.max(
      1,
      ...values.map((row) => Array.isArray(row) ? row.length : 0),
    );
    const position = artifactPosition(options);
    const table = this.slide.tables.add({
      rows: rowCount,
      columns: columnCount,
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height,
      values,
      name: options.objectName,
    });
    try {
      table.borders.assign(artifactLine({
        style: options.border?.type || "solid",
        fill: options.border?.color || "B7C9DE",
        width: options.border?.pt || 1,
      }));
      table.cells.block({
        row: 0,
        column: 0,
        rowCount,
        columnCount,
      }).assign({
        fill: artifactFill(options.fill || "FFFFFF"),
        textStyle: {
          typeface: portableTypeface(options.fontFace),
          fontSizePt: Math.max(1, Number(options.fontSize || 12)),
          color: artifactFill(options.color || "202020", "202020"),
        },
        margins: Number(options.margin || 2),
      });
    } catch {
      // Content remains editable even if an older runtime lacks bulk style APIs.
    }
    try {
      if (options.objectName) table.name = options.objectName;
    } catch {
      // Name assignment is best effort across artifact-tool releases.
    }
    return new ArtifactElementAdapter(table);
  }

  addChart(type, data, options = {}) {
    const categories = data?.[0]?.labels || [];
    const series = (data || []).map((item) => ({
      name: String(item.name || "Series"),
      values: (item.values || []).map(Number),
    }));
    const chart = this.slide.charts.add(String(type || "bar"), {
      name: options.objectName,
      position: artifactPosition(options),
      categories: categories.map(String),
      series,
      hasLegend: options.showLegend !== false,
      dataLabels: options.showValue
        ? { showValue: true, position: "outEnd" }
        : undefined,
      doughnutOptions: String(type) === "doughnut"
        ? { holeSize: Number(options.holeSize || 50) }
        : undefined,
    });
    try {
      if (options.objectName) chart.name = options.objectName;
    } catch {
      // Name assignment is best effort across artifact-tool releases.
    }
    return new ArtifactElementAdapter(chart);
  }

  connectShapes(from, to, options = {}) {
    const source = from instanceof ArtifactElementAdapter ? from.element : from;
    const target = to instanceof ArtifactElementAdapter ? to.element : to;
    const connector = this.slide.shapes.connect(source, target, {
      kind: options.kind || "straight",
      fromSide: options.fromSide || "right",
      toSide: options.toSide || "left",
      line: artifactLine(options.line || {}),
      // Skill contract: head is the target end and tail is the source end.
      // artifact-tool serializes these two OOXML ends in the opposite order.
      head: options.tail,
      tail: options.head,
      cap: options.cap,
      join: options.join,
    });
    try {
      if (options.name) connector.name = options.name;
    } catch {
      // Connector names are best effort across artifact-tool releases.
    }
    return new ArtifactElementAdapter(connector);
  }

  addNotes(value) {
    this.slide.speakerNotes.textFrame.setText(String(value || ""));
    this.slide.speakerNotes.setVisible(true);
  }
}


class ArtifactPresentationAdapter {
  constructor(presentation, PresentationFile) {
    this.presentation = presentation;
    this.PresentationFile = PresentationFile;
    this.backend = "artifact-tool";
    this.supportsAttachedConnectors = true;
    this.ShapeType = new Proxy({}, { get: (_target, property) => String(property) });
    this.ChartType = new Proxy({}, { get: (_target, property) => String(property) });
  }

  addSlide() {
    return new ArtifactSlideAdapter(this.presentation.slides.add());
  }

  async writeFile({ fileName }) {
    await fsp.mkdir(path.dirname(fileName), { recursive: true });
    const exported = await this.PresentationFile.exportPptx(this.presentation);
    await exported.save(fileName);
  }
}


function createArtifactPresentation(pageWidth, pageHeight) {
  const { Presentation, PresentationFile } = selectedBackend.module;
  const slideWidth = 1280;
  const slideHeight = slideWidth * pageHeight / pageWidth;
  const presentation = Presentation.create({
    slideSize: { width: slideWidth, height: slideHeight },
  });
  return {
    pptx: new ArtifactPresentationAdapter(presentation, PresentationFile),
    slideWidth,
    slideHeight,
    unit: slideWidth / pageWidth,
  };
}


function createPptxGenJsPresentation(pageWidth, pageHeight) {
  const PptxGenJSClass = selectedBackend.module;
  const slideWidth = 13.333333;
  const slideHeight = slideWidth * pageHeight / pageWidth;
  const pptx = new PptxGenJSClass();
  pptx.defineLayout({
    name: "PDF_TEMPLATE",
    width: slideWidth,
    height: slideHeight,
  });
  pptx.layout = "PDF_TEMPLATE";
  pptx.author = "Codex";
  pptx.subject = "PDF template converted to editable PPTX";
  pptx.company = "";
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: portableTypeface("Noto Sans CJK SC"),
    bodyFontFace: portableTypeface("Noto Sans CJK SC"),
    lang: "zh-CN",
  };
  pptx.backend = "pptxgenjs";
  pptx.supportsAttachedConnectors = false;
  return {
    pptx,
    slideWidth,
    slideHeight,
    unit: slideWidth / pageWidth,
  };
}


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
  return selectedBackend.name === "artifact-tool"
    ? createArtifactPresentation(pageWidth, pageHeight)
    : createPptxGenJsPresentation(pageWidth, pageHeight);
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
  await fsp.mkdir(path.dirname(output), { recursive: true });
}


export const PptxGenJS = selectedBackend.name === "pptxgenjs"
  ? selectedBackend.module
  : null;
