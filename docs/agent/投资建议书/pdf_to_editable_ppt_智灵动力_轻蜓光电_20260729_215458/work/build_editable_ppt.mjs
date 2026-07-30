import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";


let SCALE = 4 / 3;

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`缺少必需参数：${name}`);
  }
  return path.resolve(process.argv[index + 1]);
}

function optionalArg(name, fallback) {
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
const OVERRIDES_PATH = optionalArg("--overrides", null);
const OVERRIDES_BASE_DIR = OVERRIDES_PATH
  ? path.dirname(OVERRIDES_PATH)
  : process.cwd();


function alphaColor(color, opacity = 1) {
  if (!color) return "none";
  if (opacity >= 0.999) return color;
  return `${color}/${Math.max(0, Math.min(100, Math.round(opacity * 100)))}`;
}


function lineStyle(dashes) {
  const match = String(dashes || "").match(/\[([^\]]*)\]/);
  if (!match || !match[1].trim()) return "solid";
  const values = match[1]
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
  if (!values.length) return "solid";
  if (values.length >= 4) return "dash-dot";
  if (values[0] <= 2) return "dotted";
  return "dashed";
}


function drawingFill(drawing) {
  return drawing.draw_type.includes("f")
    ? alphaColor(drawing.fill || "#000000", drawing.fill_opacity)
    : "none";
}


function drawingLine(drawing) {
  if (!drawing.draw_type.includes("s") || !drawing.stroke) {
    return { style: "solid", fill: "none", width: 0 };
  }
  return {
    style: lineStyle(drawing.dashes),
    fill: alphaColor(drawing.stroke, drawing.stroke_opacity),
    width: Math.max(0.12, drawing.stroke_width * SCALE),
  };
}


function localPoint(point, bbox) {
  return {
    x: (point[0] - bbox[0]) * SCALE,
    y: (point[1] - bbox[1]) * SCALE,
  };
}


function equalPoint(a, b) {
  return a && b && Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02;
}


function customCommands(drawing) {
  const commands = [];
  let current = null;
  for (const item of drawing.items) {
    if (item.kind === "line") {
      const p1 = localPoint(item.p1, drawing.bbox);
      const p2 = localPoint(item.p2, drawing.bbox);
      if (!equalPoint(current, p1)) commands.push({ moveTo: p1 });
      commands.push({ lineTo: p2 });
      current = p2;
    } else if (item.kind === "rect") {
      const [x0, y0, x1, y1] = item.rect;
      const points = [
        localPoint([x0, y0], drawing.bbox),
        localPoint([x1, y0], drawing.bbox),
        localPoint([x1, y1], drawing.bbox),
        localPoint([x0, y1], drawing.bbox),
      ];
      commands.push({ moveTo: points[0] });
      for (const point of points.slice(1)) commands.push({ lineTo: point });
      commands.push({ close: {} });
      current = points[0];
    } else if (item.kind === "quad") {
      const points = item.points.map((point) => localPoint(point, drawing.bbox));
      commands.push({ moveTo: points[0] });
      for (const point of points.slice(1)) commands.push({ lineTo: point });
      commands.push({ close: {} });
      current = points[0];
    }
  }
  if ((drawing.close_path || drawing.draw_type.includes("f")) && commands.length) {
    const last = commands.at(-1);
    if (!last.close) commands.push({ close: {} });
  }
  return commands;
}


function svgColor(color, opacity) {
  if (!color) return { color: "none", opacity: 1 };
  return { color, opacity: Number.isFinite(opacity) ? opacity : 1 };
}


function svgForDrawing(drawing) {
  const bleed = Math.max(1, (drawing.stroke_width || 0) / 2 + 0.5);
  const [x0, y0, x1, y1] = drawing.bbox;
  const left = x0 - bleed;
  const top = y0 - bleed;
  const width = Math.max(0.1, x1 - x0 + bleed * 2);
  const height = Math.max(0.1, y1 - y0 + bleed * 2);
  let commands = "";
  let current = null;
  const p = (point) => [point[0] - left, point[1] - top];
  const moveIfNeeded = (point) => {
    if (!current || Math.abs(current[0] - point[0]) > 0.01 || Math.abs(current[1] - point[1]) > 0.01) {
      commands += `M ${point[0]} ${point[1]} `;
    }
  };
  for (const item of drawing.items) {
    if (item.kind === "line") {
      const p1 = p(item.p1);
      const p2 = p(item.p2);
      moveIfNeeded(p1);
      commands += `L ${p2[0]} ${p2[1]} `;
      current = p2;
    } else if (item.kind === "curve") {
      const p1 = p(item.p1);
      const c1 = p(item.c1);
      const c2 = p(item.c2);
      const p2 = p(item.p2);
      moveIfNeeded(p1);
      commands += `C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]} `;
      current = p2;
    } else if (item.kind === "rect") {
      const [rx0, ry0, rx1, ry1] = item.rect;
      const a = p([rx0, ry0]);
      const b = p([rx1, ry1]);
      commands += `M ${a[0]} ${a[1]} H ${b[0]} V ${b[1]} H ${a[0]} Z `;
      current = a;
    } else if (item.kind === "quad") {
      const points = item.points.map(p);
      commands += `M ${points[0][0]} ${points[0][1]} `;
      for (const point of points.slice(1)) commands += `L ${point[0]} ${point[1]} `;
      commands += "Z ";
      current = points[0];
    }
  }
  if (drawing.close_path) commands += "Z";
  const fill = svgColor(
    drawing.draw_type.includes("f") ? drawing.fill || "#000000" : null,
    drawing.fill_opacity,
  );
  const stroke = svgColor(
    drawing.draw_type.includes("s") ? drawing.stroke : null,
    drawing.stroke_opacity,
  );
  const dashMatch = String(drawing.dashes || "").match(/\[([^\]]*)\]/);
  const dash = dashMatch && dashMatch[1].trim()
    ? ` stroke-dasharray="${dashMatch[1].trim().replace(/\s+/g, ",")}"`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${commands}" fill="${fill.color}" fill-opacity="${fill.opacity}" fill-rule="${drawing.even_odd ? "evenodd" : "nonzero"}" stroke="${stroke.color}" stroke-opacity="${stroke.opacity}" stroke-width="${drawing.stroke_width || 0}"${dash}/></svg>`;
  return {
    bytes: Buffer.from(svg),
    position: {
      left: left * SCALE,
      top: top * SCALE,
      width: width * SCALE,
      height: height * SCALE,
    },
  };
}


function addDrawing(slide, drawing, index) {
  const [x0, y0, x1, y1] = drawing.bbox;
  const position = {
    left: x0 * SCALE,
    top: y0 * SCALE,
    width: Math.max(0.1, (x1 - x0) * SCALE),
    height: Math.max(0.1, (y1 - y0) * SCALE),
  };
  const hasCurve = drawing.items.some((item) => item.kind === "curve");
  const multipleRects = drawing.items.filter((item) => item.kind === "rect").length > 1;
  if (hasCurve || (drawing.even_odd && multipleRects)) {
    const vector = svgForDrawing(drawing);
    slide.images.add({
      blob: vector.bytes,
      contentType: "image/svg+xml",
      alt: `PDF 矢量元素 ${index + 1}`,
      fit: "contain",
      position: vector.position,
    });
    return;
  }

  if (drawing.items.length === 1 && drawing.items[0].kind === "rect") {
    slide.shapes.add({
      geometry: "rect",
      name: `pdf-vector-${String(index + 1).padStart(4, "0")}`,
      position,
      fill: drawingFill(drawing),
      line: drawingLine(drawing),
    });
    return;
  }

  const commands = customCommands(drawing);
  if (!commands.length) return;
  slide.shapes.add({
    geometry: "custom",
    name: `pdf-vector-${String(index + 1).padStart(4, "0")}`,
    position,
    fill: drawingFill(drawing),
    line: drawingLine(drawing),
    customPaths: [
      {
        width: position.width,
        height: position.height,
        commands,
      },
    ],
  });
}


function imageReplacementFor(element, index, pageOverride = {}) {
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


async function addImage(slide, element, cache, index, replacement = null) {
  const [x0, y0, x1, y1] = element.bbox;
  let position = {
    left: x0 * SCALE,
    top: y0 * SCALE,
    width: Math.max(0.1, (x1 - x0) * SCALE),
    height: Math.max(0.1, (y1 - y0) * SCALE),
  };
  const assetPath = replacement?.asset
    ? resolveAsset(replacement.asset)
    : element.asset;
  let bytes = cache.get(assetPath);
  if (!bytes) {
    bytes = await fs.readFile(assetPath);
    cache.set(assetPath, bytes);
  }
  const rotation = Math.abs(element.rotation) < 0.05 ? 0 : element.rotation;
  if (rotation) {
    const centerX = (x0 + x1) * SCALE / 2;
    const centerY = (y0 + y1) * SCALE / 2;
    const width = element.display_width * SCALE;
    const height = element.display_height * SCALE;
    position = {
      left: centerX - width / 2,
      top: centerY - height / 2,
      width,
      height,
    };
  }
  const image = slide.images.add({
    blob: bytes,
    contentType: replacement?.contentType || element.content_type,
    alt:
      replacement?.alt
      || `PDF 图片 ${index + 1}${replacement ? "（已清除栅格文字）" : ""}`,
    fit: "cover",
    position,
  });
  if (rotation) image.rotation = rotation;
}


function addText(slide, element, index) {
  const [x0, y0, x1, y1] = element.bbox;
  const fontSize = element.font_size * SCALE;
  const rotation = Math.atan2(element.direction[1], element.direction[0]) * 180 / Math.PI;
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: `pdf-text-${String(index + 1).padStart(4, "0")}`,
    position: {
      left: x0 * SCALE,
      top: y0 * SCALE,
      width: Math.max(4, (x1 - x0) * SCALE + 4),
      height: Math.max(fontSize * 1.25, (y1 - y0) * SCALE + 2),
      ...(Math.abs(rotation) > 0.05 ? { rotation } : {}),
    },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = element.text;
  shape.text.style = {
    fontSize,
    bold: element.bold,
    italic: element.italic,
    typeface: element.font,
    color: alphaColor(element.color || "#000000", element.opacity),
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "none",
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


function addOverrideShape(slide, item, index) {
  const shape = slide.shapes.add({
    geometry: item.geometry || "rect",
    name: item.name || `override-shape-${index + 1}`,
    position: item.position,
    fill: item.fill ?? "white",
    line: item.line ?? { style: "solid", fill: "none", width: 0 },
    ...(item.borderRadius ? { borderRadius: item.borderRadius } : {}),
    ...(item.customPaths ? { customPaths: item.customPaths } : {}),
  });
  if (item.text !== undefined && item.text !== null) {
    shape.text = String(item.text);
    shape.text.style = {
      fontSize: 16,
      typeface: "Microsoft YaHei",
      color: "#000000",
      alignment: "center",
      verticalAlignment: "middle",
      autoFit: "shrinkText",
      wrap: "none",
      lineSpacing: 1,
      insets: { left: 2, right: 2, top: 1, bottom: 1 },
      ...(item.textStyle || {}),
    };
  }
  return shape;
}


async function addOverrideCover(slide, cover, index) {
  if (cover.asset) {
    const coverBytes = await fs.readFile(resolveAsset(cover.asset));
    return slide.images.add({
      blob: coverBytes,
      contentType: cover.contentType || "image/png",
      alt: cover.alt || `语义重建背景修补图 ${index + 1}`,
      fit: cover.fit || "cover",
      position: cover.position,
    });
  }
  return addOverrideShape(
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
      addOverrideText(
        slide,
        {
          name: `${table.name || `manual-table-${tableIndex + 1}`}-text-${row + 1}-${column + 1}`,
          position: { left: x + 2, top: y + 1, width: width - 4, height: height - 2 },
          text: table.values[row][column],
          textStyle: {
            fontSize: table.fontSize || 10,
            bold: table.headerRow !== false && row === 0,
            typeface: table.font || "Microsoft YaHei",
            color: table.color || "#172B4D",
            alignment: table.alignment || "center",
            verticalAlignment: "middle",
          },
        },
        row * table.values[row].length + column,
      );
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


async function addPageOverrides(slide, pageOverride = {}) {
  for (const [index, cover] of (pageOverride.covers || []).entries()) {
    await addOverrideCover(slide, cover, index);
  }
  for (const [index, icon] of (pageOverride.icons || []).entries()) {
    await addIconCover(slide, icon, index);
  }

  const namedShapes = new Map();
  const shapeFacades = [];
  for (const [index, item] of (pageOverride.shapes || []).entries()) {
    const shape = addOverrideShape(slide, item, index);
    shapeFacades.push(shape);
    if (item.name) namedShapes.set(item.name, shape);
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

  // Connectors must stay above the background repair but below their nodes.
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


async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}


async function main() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
  const model = JSON.parse(await fs.readFile(MODEL_PATH, "utf8"));
  const overrides = OVERRIDES_PATH
    ? JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"))
    : { slides: {} };
  SCALE = 1280 / model.page_width;
  const presentation = Presentation.create({
    slideSize: {
      width: model.page_width * SCALE,
      height: model.page_height * SCALE,
    },
  });
  const imageCache = new Map();

  for (const page of model.pages) {
    const slide = presentation.slides.add();
    slide.background.fill = "white";
    const pageOverride = overrides.slides?.[String(page.number)] || {};
    for (const [index, element] of page.elements.entries()) {
      if (element.kind === "drawing") addDrawing(slide, element, index);
      else if (element.kind === "image") {
        await addImage(
          slide,
          element,
          imageCache,
          index,
          imageReplacementFor(element, index, pageOverride),
        );
      }
      else if (element.kind === "text") addText(slide, element, index);
    }
    await addPageOverrides(slide, pageOverride);
    slide.speakerNotes.textFrame.setText(
      `[Sources]\n- 用户提供的原始 PDF：${model.source}（第 ${page.number} 页）\n- 通过覆盖清单重建的文字、形状、连接线、图标、图表和表格均来自该页面。`,
    );
    const stem = `slide-${String(page.number).padStart(2, "0")}`;
    const preview = await presentation.export({ slide, format: "png", scale: 1 });
    await writeBlob(path.join(RENDER_DIR, `${stem}.png`), preview);
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(RENDER_DIR, `${stem}.layout.json`), await layout.text());
    const overrideCount = [
      "covers",
      "shapes",
      "connectors",
      "texts",
      "charts",
      "tables",
      "icons",
      "imageReplacements",
    ].reduce((total, key) => total + (pageOverride[key]?.length || 0), 0);
    console.log(
      `已生成 ${stem}，${page.elements.length} 个 PDF 元素，`
      + `${overrideCount} 个语义重建元素`,
    );
  }

  const montage = await presentation.export({ format: "webp", montage: true, scale: 0.5 });
  await writeBlob(path.join(RENDER_DIR, "deck-montage.webp"), montage);
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);
  console.log(`已保存 ${FINAL_PPTX}`);
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
