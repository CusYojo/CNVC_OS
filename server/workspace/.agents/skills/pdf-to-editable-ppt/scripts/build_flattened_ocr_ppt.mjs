import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";


function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`缺少必需参数：${name}`);
  }
  return path.resolve(process.argv[index + 1]);
}


function optionalArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1])
    : fallback;
}


const MODEL_PATH = requiredArg("--model");
const FINAL_PPTX = requiredArg("--output");
const RENDER_DIR = optionalArg(
  "--render-dir",
  path.join(path.dirname(MODEL_PATH), "artifact-renders"),
);
const OVERRIDES_PATH = optionalArg("--overrides");
const OVERRIDES_BASE_DIR = OVERRIDES_PATH
  ? path.dirname(OVERRIDES_PATH)
  : process.cwd();


async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}


function insideRegion(item, region) {
  const centerX = item.left + item.width / 2;
  const centerY = item.top + item.height / 2;
  return (
    centerX >= region.left
    && centerX <= region.left + region.width
    && centerY >= region.top
    && centerY <= region.top + region.height
  );
}


function addText(slide, item, pageNumber, index, style = {}) {
  const widthMultiplier = item.width > 600 ? 1 : 1.1;
  const extraWidth = item.width > 600 ? 0 : 8;
  const fontSize = item.font_size * (style.fontScale || 1);
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: `ocr-text-p${String(pageNumber).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
    position: {
      left: item.left - 1,
      top: item.top - 1,
      width: Math.min(
        style.slideWidth - item.left + 1,
        item.width * widthMultiplier + extraWidth,
      ),
      height: Math.max(item.height * 1.35 + 4, fontSize * 1.3),
    },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = item.text;
  shape.text.style = {
    fontSize,
    bold: item.bold,
    typeface: item.font,
    color: item.color,
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "shrinkText",
    wrap: "none",
    lineSpacing: 1,
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
}


function addOverrideText(slide, item, index) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: item.name || `override-text-${index + 1}`,
    position: item.position,
    fill: item.fill ?? "none",
    line: item.line ?? { style: "solid", fill: "none", width: 0 },
  });
  shape.text = String(item.text ?? "");
  shape.text.style = {
    fontSize: 16,
    typeface: "Microsoft YaHei",
    color: "#000000",
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "shrinkText",
    wrap: "none",
    lineSpacing: 1,
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
    ...(item.textStyle || {}),
  };
  return shape;
}


function addShape(slide, shape, index) {
  const facade = slide.shapes.add({
    geometry: shape.geometry || "rect",
    name: shape.name || `override-shape-${index + 1}`,
    position: shape.position,
    fill: shape.fill ?? "white",
    line: shape.line ?? { style: "solid", fill: "none", width: 0 },
    ...(shape.borderRadius ? { borderRadius: shape.borderRadius } : {}),
    ...(shape.customPaths ? { customPaths: shape.customPaths } : {}),
  });
  if (shape.text !== undefined && shape.text !== null) {
    facade.text = String(shape.text);
    facade.text.style = {
      fontSize: 16,
      typeface: "Microsoft YaHei",
      color: "#000000",
      alignment: "center",
      verticalAlignment: "middle",
      autoFit: "shrinkText",
      wrap: "none",
      lineSpacing: 1,
      insets: { left: 2, right: 2, top: 1, bottom: 1 },
      ...(shape.textStyle || {}),
    };
  }
  return facade;
}


function resolveAsset(assetPath) {
  if (!assetPath) {
    throw new Error("图标或覆盖图片缺少 asset 路径");
  }
  return path.isAbsolute(assetPath)
    ? assetPath
    : path.resolve(OVERRIDES_BASE_DIR, assetPath);
}


async function addIconCover(slide, icon, index) {
  if (!icon.cover) return;
  const cover = icon.cover === true
    ? {
        position: icon.position,
        fill: icon.backgroundFill || "white",
        line: { style: "solid", fill: "none", width: 0 },
      }
    : icon.cover;
  if (cover.asset) {
    const coverBytes = await fs.readFile(resolveAsset(cover.asset));
    slide.images.add({
      blob: coverBytes,
      contentType: cover.contentType || "image/png",
      alt: cover.alt || `${icon.name || `icon-${index + 1}`} 的背景修补图`,
      fit: cover.fit || "cover",
      position: cover.position || icon.position,
    });
    return;
  }
  slide.shapes.add({
    geometry: cover.geometry || "rect",
    name: cover.name || `${icon.name || `icon-${index + 1}`}-cover`,
    position: cover.position || icon.position,
    fill: cover.fill || icon.backgroundFill || "white",
    line: cover.line || { style: "solid", fill: "none", width: 0 },
  });
}


function partPosition(icon, part) {
  if (part === icon) return icon.position;
  if (!part.position) return icon.position;
  if (part.absolute === true) return part.position;
  return {
    left: icon.position.left + (part.position.left || 0),
    top: icon.position.top + (part.position.top || 0),
    width: part.position.width ?? icon.position.width,
    height: part.position.height ?? icon.position.height,
    ...(part.position.rotation !== undefined
      ? { rotation: part.position.rotation }
      : {}),
  };
}


function addNativeIconPart(slide, icon, part, iconIndex, partIndex) {
  const shape = slide.shapes.add({
    geometry: part.geometry || icon.geometry || "rect",
    name:
      part.name
      || `${icon.name || `icon-${iconIndex + 1}`}-part-${partIndex + 1}`,
    position: partPosition(icon, part),
    fill: part.fill ?? icon.fill ?? "none",
    line:
      part.line
      ?? icon.line
      ?? { style: "solid", fill: "none", width: 0 },
    ...(part.customPaths || icon.customPaths
      ? { customPaths: part.customPaths || icon.customPaths }
      : {}),
  });
  const text = part.text ?? icon.text;
  if (text !== undefined && text !== null) {
    shape.text = String(text);
    shape.text.style = {
      fontSize: 16,
      alignment: "center",
      verticalAlignment: "middle",
      autoFit: "shrinkText",
      wrap: "none",
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      ...(icon.textStyle || {}),
      ...(part.textStyle || {}),
    };
  }
}


async function addEditableIcon(slide, icon, index) {
  const mode = icon.mode || "native";
  if (mode === "native" || mode === "shape") {
    const parts = icon.parts?.length ? icon.parts : [icon];
    for (const [partIndex, part] of parts.entries()) {
      addNativeIconPart(slide, icon, part, index, partIndex);
    }
    return;
  }
  if (mode !== "svg" && mode !== "image" && mode !== "raster") {
    throw new Error(`不支持的图标模式：${mode}`);
  }
  const bytes = icon.svg
    ? Buffer.from(icon.svg, "utf8")
    : await fs.readFile(resolveAsset(icon.asset));
  const contentType =
    icon.contentType
    || (mode === "svg" || icon.svg ? "image/svg+xml" : "image/png");
  const image = slide.images.add({
    blob: bytes,
    contentType,
    alt:
      icon.alt
      || `${icon.name || `icon-${index + 1}`}，独立可编辑图标对象`,
    fit: icon.fit || "contain",
    position: icon.position,
  });
  if (icon.rotation) image.rotation = icon.rotation;
}


function addManualTable(slide, table, tableIndex) {
  let y = table.position.top;
  for (let row = 0; row < table.values.length; row += 1) {
    let x = table.position.left;
    for (let column = 0; column < table.values[row].length; column += 1) {
      const width = table.columnWidths[column];
      const height = table.rowHeights[row];
      slide.shapes.add({
        geometry: "rect",
        name: `${table.name || `manual-table-${tableIndex + 1}`}-cell-${row + 1}-${column + 1}`,
        position: { left: x, top: y, width, height },
        fill: table.fill || "#F9FCFF",
        line: table.line || { style: "solid", fill: "#9DB8DD", width: 0.7 },
      });
      const text = slide.shapes.add({
        geometry: "textbox",
        name: `${table.name || `manual-table-${tableIndex + 1}`}-text-${row + 1}-${column + 1}`,
        position: { left: x + 2, top: y + 1, width: width - 4, height: height - 2 },
        fill: "none",
        line: { style: "solid", fill: "none", width: 0 },
      });
      text.text = String(table.values[row][column]);
      text.text.style = {
        fontSize: table.fontSize || 10,
        bold: table.headerRow !== false && row === 0,
        typeface: table.font || "Microsoft YaHei",
        color: table.color || "#172B4D",
        alignment: table.alignment || "center",
        verticalAlignment: "middle",
        autoFit: "shrinkText",
        wrap: "none",
        insets: { left: 0, right: 0, top: 0, bottom: 0 },
      };
      x += width;
    }
    y += table.rowHeights[row];
  }
}


function addNativeTable(slide, table) {
  const native = slide.tables.add({
    rows: table.values.length,
    columns: table.values[0].length,
    left: table.position.left,
    top: table.position.top,
    width: table.position.width,
    height: table.position.height,
    values: table.values,
    ...(table.columnWidths ? { columnWidths: table.columnWidths } : {}),
  });
  const range = native.cells.block({
    row: 0,
    column: 0,
    rowCount: table.values.length,
    columnCount: table.values[0].length,
  });
  range.assign({
    fill: table.fill || "#F9FCFF",
    textStyle: {
      fontSize: table.fontSize || 10,
      color: table.color || "#172B4D",
      typeface: table.font || "Microsoft YaHei",
      alignment: table.alignment || "center",
    },
    borders: table.line || { style: "solid", fill: "#9DB8DD", width: 0.7 },
    margins: table.margins || { left: 3, right: 3, top: 1, bottom: 1 },
    anchor: "middle",
  });
  if (table.rowHeights) {
    table.rowHeights.forEach((height, row) => {
      native.rows[row].height = height;
    });
  }
}


async function addOverrides(slide, pageOverride = {}) {
  for (const [index, cover] of (pageOverride.covers || []).entries()) {
    if (cover.asset) {
      const coverBytes = await fs.readFile(resolveAsset(cover.asset));
      slide.images.add({
        blob: coverBytes,
        contentType: cover.contentType || "image/png",
        alt: cover.alt || `语义重建背景修补图 ${index + 1}`,
        fit: cover.fit || "cover",
        position: cover.position,
      });
    } else {
      addShape(
        slide,
        {
          ...cover,
          name: cover.name || `semantic-cover-${index + 1}`,
          geometry: cover.geometry || "rect",
          fill: cover.fill ?? "white",
          line: cover.line ?? { style: "solid", fill: "none", width: 0 },
        },
        index,
      );
    }
  }
  for (const [index, icon] of (pageOverride.icons || []).entries()) {
    await addIconCover(slide, icon, index);
  }
  const namedShapes = new Map();
  const shapeFacades = [];
  for (const [index, shape] of (pageOverride.shapes || []).entries()) {
    const facade = addShape(slide, shape, index);
    shapeFacades.push(facade);
    if (shape.name) namedShapes.set(shape.name, facade);
  }
  const connectors = [];
  for (const [index, connector] of (pageOverride.connectors || []).entries()) {
    const from = namedShapes.get(connector.from);
    const to = namedShapes.get(connector.to);
    if (!from || !to) {
      throw new Error(
        `第 ${index + 1} 个连接线引用了不存在的节点：`
        + `${connector.from} -> ${connector.to}`,
      );
    }
    const facade = slide.shapes.connect(from, to, {
      kind: connector.kind || "elbow",
      ...(connector.fromSide ? { fromSide: connector.fromSide } : {}),
      ...(connector.toSide ? { toSide: connector.toSide } : {}),
      line: connector.line || { style: "solid", fill: "#000000", width: 1.2 },
      ...(connector.head ? { head: connector.head } : {}),
      ...(connector.tail ? { tail: connector.tail } : {}),
      ...(connector.cap ? { cap: connector.cap } : {}),
      ...(connector.join ? { join: connector.join } : {}),
    });
    if (connector.name) facade.name = connector.name;
    connectors.push(facade);
  }
  for (const connector of connectors) connector.bringToFront();
  for (const shape of shapeFacades) shape.bringToFront();
  for (const [index, item] of (pageOverride.texts || []).entries()) {
    addOverrideText(slide, item, index);
  }
  for (const chart of pageOverride.charts || []) {
    slide.charts.add(chart.type, chart.config);
  }
  for (const [index, table] of (pageOverride.tables || []).entries()) {
    if ((table.mode || "manual") === "native") addNativeTable(slide, table);
    else addManualTable(slide, table, index);
  }
  for (const [index, icon] of (pageOverride.icons || []).entries()) {
    await addEditableIcon(slide, icon, index);
  }
}


async function main() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
  const model = JSON.parse(await fs.readFile(MODEL_PATH, "utf8"));
  const overrides = OVERRIDES_PATH
    ? JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"))
    : { slides: {} };
  const presentation = Presentation.create({
    slideSize: { width: model.page_width, height: model.page_height },
  });

  for (const page of model.pages) {
    const slide = presentation.slides.add();
    slide.background.fill = "white";
    const backgroundBytes = await fs.readFile(page.background);
    slide.images.add({
      blob: backgroundBytes,
      contentType: "image/png",
      alt: `第 ${page.number} 页的装饰背景和复杂插画`,
      fit: "cover",
      position: { left: 0, top: 0, width: page.width, height: page.height },
    });

    const pageOverride = overrides.slides?.[String(page.number)] || {};
    await addOverrides(slide, pageOverride);
    const skipRegions = pageOverride.skipTextRegions || [];
    const textStyle = {
      slideWidth: page.width,
      fontScale: pageOverride.ocrFontScale || 1,
    };
    let textCount = 0;
    for (const [index, item] of page.text.entries()) {
      if (skipRegions.some((region) => insideRegion(item, region))) continue;
      addText(slide, item, page.number, index, textStyle);
      textCount += 1;
    }

    slide.speakerNotes.textFrame.setText(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- OCR 文字从同一页图片中重建；如存在原生图表、表格或独立图标，其内容也来自该页面。`,
    );
    const stem = `slide-${String(page.number).padStart(2, "0")}`;
    const preview = await presentation.export({ slide, format: "png", scale: 1 });
    await writeBlob(path.join(RENDER_DIR, `${stem}.png`), preview);
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(
      path.join(RENDER_DIR, `${stem}.layout.json`),
      await layout.text(),
    );
    console.log(`已生成 ${stem}：${textCount} 行可编辑 OCR 文字`);
  }

  const montage = await presentation.export({
    format: "webp",
    montage: true,
    scale: 0.5,
  });
  await writeBlob(path.join(RENDER_DIR, "deck-montage.webp"), montage);
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);
  console.log(`已保存 ${FINAL_PPTX}`);
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
