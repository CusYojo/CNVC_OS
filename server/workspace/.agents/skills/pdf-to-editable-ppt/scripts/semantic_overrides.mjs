import fs from "node:fs";
import path from "node:path";
import { hexColor, svgData } from "./public_pptx_runtime.mjs";


function resolveAsset(assetRoot, asset) {
  return path.isAbsolute(asset) ? asset : path.resolve(assetRoot, asset);
}


function sourcePosition(value = {}) {
  return value.position || value.config?.position || value;
}


function positionOf(value, scale, fallback = {}) {
  const source = { ...fallback, ...sourcePosition(value) };
  return {
    x: Math.max(0, Number(source.left || 0) * scale),
    y: Math.max(0, Number(source.top || 0) * scale),
    w: Math.max(0.01, Number(source.width || 0) * scale),
    h: Math.max(0.01, Number(source.height || 0) * scale),
  };
}


function lineOptions(value = {}) {
  const hidden = value === "none"
    || value.fill === "none"
    || Number(value.width ?? 1) <= 0;
  return {
    color: hexColor(value.fill || value.color, "000000"),
    width: hidden ? 0 : Math.max(0.1, Number(value.width || 1)),
    transparency: hidden ? 100 : Number(value.transparency || 0),
    dash: ["dash", "dashed"].includes(value.style) ? "dash" : "solid",
  };
}


function fillOptions(value, fallback = "FFFFFF") {
  if (value === "none") return { color: fallback, transparency: 100 };
  if (typeof value === "object" && value) {
    return {
      color: hexColor(value.color || value.fill, fallback),
      transparency: Math.max(0, Math.min(100, Number(value.transparency || 0))),
    };
  }
  return { color: hexColor(value, fallback), transparency: 0 };
}


function textOptions(style = {}) {
  const insets = style.insets || {};
  return {
    fontFace: style.typeface || style.fontFace || "Noto Sans CJK SC",
    fontSize: Math.max(1, Number(style.fontSize || 14)),
    color: hexColor(style.color, "202020"),
    bold: Boolean(style.bold),
    italic: Boolean(style.italic),
    align: {
      left: "left",
      center: "center",
      right: "right",
      justify: "justify",
    }[style.alignment] || "left",
    valign: {
      top: "top",
      middle: "mid",
      bottom: "bottom",
    }[style.verticalAlignment] || "mid",
    margin: [
      Number(insets.top || 0),
      Number(insets.right || 0),
      Number(insets.bottom || 0),
      Number(insets.left || 0),
    ],
    fit: style.autoFit === "none" ? "none" : "shrink",
    breakLine: false,
    rotate: Number(style.rotation || 0),
  };
}


function shapeType(pptx, geometry) {
  const aliases = {
    rectangle: "rect",
    roundedRectangle: "roundRect",
    roundedRect: "roundRect",
    circle: "ellipse",
  };
  const key = aliases[geometry] || geometry || "rect";
  return pptx.ShapeType[key] || pptx.ShapeType.rect;
}


function addManifest(manifest, pageNumber, kind, item, details = {}) {
  manifest.push({
    page: pageNumber,
    semanticId: item.name || null,
    type: kind,
    emitted: true,
    ...details,
  });
}


function nodeAnchor(position, side) {
  if (side === "left") return [position.x, position.y + position.h / 2];
  if (side === "top") return [position.x + position.w / 2, position.y];
  if (side === "bottom") return [position.x + position.w / 2, position.y + position.h];
  return [position.x + position.w, position.y + position.h / 2];
}


function addLine(slide, pptx, x1, y1, x2, y2, options, objectName) {
  slide.addShape(pptx.ShapeType.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line: options,
    beginArrowType: options.beginArrowType,
    endArrowType: options.endArrowType,
    objectName,
  });
}


function addConnector(slide, pptx, item, nodes, pageNumber, manifest) {
  const from = nodes.get(item.from);
  const to = nodes.get(item.to);
  if (!from || !to) {
    manifest.push({
      page: pageNumber,
      semanticId: item.name || null,
      type: "connector",
      emitted: false,
      error: `missing-node:${!from ? item.from : item.to}`,
    });
    return;
  }
  const [x1, y1] = nodeAnchor(from, item.fromSide || "right");
  const [x2, y2] = nodeAnchor(to, item.toSide || "left");
  const line = lineOptions(item.line);
  const tailType = item.tail?.type || item.endArrowType;
  const headType = item.head?.type || item.beginArrowType;
  if (tailType && tailType !== "none") line.endArrowType = tailType;
  if (headType && headType !== "none") line.beginArrowType = headType;
  const objectName = item.name || `connector-${item.from}-${item.to}`;
  if (item.kind === "elbow") {
    const middleX = (x1 + x2) / 2;
    addLine(slide, pptx, x1, y1, middleX, y1, {
      ...line,
      endArrowType: undefined,
    }, `${objectName}-1`);
    addLine(slide, pptx, middleX, y1, middleX, y2, {
      ...line,
      beginArrowType: undefined,
      endArrowType: undefined,
    }, `${objectName}-2`);
    addLine(slide, pptx, middleX, y2, x2, y2, {
      ...line,
      beginArrowType: undefined,
    }, `${objectName}-3`);
    addManifest(manifest, pageNumber, "connector", item, { segmentCount: 3 });
  } else {
    addLine(slide, pptx, x1, y1, x2, y2, line, objectName);
    addManifest(manifest, pageNumber, "connector", item, { segmentCount: 1 });
  }
}


function addCover(
  slide,
  pptx,
  item,
  scale,
  pageNumber,
  manifest,
  assetRoot,
) {
  const pos = positionOf(item, scale);
  if (item.asset) {
    slide.addImage({
      path: resolveAsset(assetRoot, item.asset),
      ...pos,
      objectName: item.name || "semantic-cover-image",
    });
  } else {
    slide.addShape(pptx.ShapeType.rect, {
      ...pos,
      fill: fillOptions(item.fill),
      line: lineOptions(item.line || "none"),
      objectName: item.name || "semantic-cover",
    });
  }
  addManifest(manifest, pageNumber, "cover", item);
}


function addShape(slide, pptx, item, scale, pageNumber, manifest, nodes) {
  const pos = positionOf(item, scale);
  slide.addShape(shapeType(pptx, item.geometry), {
    ...pos,
    fill: fillOptions(item.fill),
    line: lineOptions(item.line),
    beginArrowType: item.beginArrowType,
    endArrowType: item.endArrowType,
    objectName: item.name || "semantic-shape",
  });
  if (item.name) nodes.set(item.name, pos);
  if (item.text) {
    slide.addText(String(item.text), {
      ...pos,
      ...textOptions(item.textStyle),
      objectName: `${item.name || "semantic-shape"}-text`,
    });
  }
  addManifest(manifest, pageNumber, "shape", item, {
    hasText: Boolean(item.text),
    textEvidenceId: item.textEvidenceId || null,
  });
}


function addText(slide, item, scale, pageNumber, manifest) {
  const pos = positionOf(item, scale);
  slide.addText(String(item.text || ""), {
    ...pos,
    ...textOptions(item.textStyle),
    objectName: item.name || "semantic-text",
  });
  addManifest(manifest, pageNumber, "text", item, {
    textEvidenceId: item.textEvidenceId || null,
  });
}


function addIcon(
  slide,
  pptx,
  item,
  scale,
  pageNumber,
  manifest,
  assetRoot,
) {
  const pos = positionOf(item, scale);
  if (item.cover) {
    const cover = item.cover === true
      ? {
        position: sourcePosition(item),
        fill: item.backgroundFill || "FFFFFF",
        line: "none",
        name: `${item.name || "semantic-icon"}-cover`,
      }
      : item.cover;
    addCover(slide, pptx, cover, scale, pageNumber, manifest, assetRoot);
  }
  if (item.mode === "svg") {
    const svg = item.svg
      || fs.readFileSync(resolveAsset(assetRoot, item.asset), "utf8");
    slide.addImage({
      data: svgData(svg),
      ...pos,
      objectName: item.name || "semantic-svg-icon",
    });
  } else if (["image", "raster"].includes(item.mode)) {
    slide.addImage({
      path: resolveAsset(assetRoot, item.asset),
      ...pos,
      objectName: item.name || "semantic-raster-icon",
    });
  } else if (Array.isArray(item.parts) && item.parts.length) {
    for (const [index, part] of item.parts.entries()) {
      const relative = part.absolute
        ? positionOf(part, scale)
        : {
          x: pos.x + Number(part.position?.left || 0) * scale,
          y: pos.y + Number(part.position?.top || 0) * scale,
          w: Math.max(0.01, Number(part.position?.width || 0) * scale),
          h: Math.max(0.01, Number(part.position?.height || 0) * scale),
        };
      slide.addShape(shapeType(pptx, part.geometry), {
        ...relative,
        fill: fillOptions(part.fill),
        line: lineOptions(part.line),
        objectName: part.name || `${item.name || "semantic-icon"}-${index + 1}`,
      });
    }
  } else {
    slide.addShape(shapeType(pptx, item.geometry || "ellipse"), {
      ...pos,
      fill: fillOptions(item.fill),
      line: lineOptions(item.line),
      objectName: item.name || "semantic-native-icon",
    });
  }
  addManifest(manifest, pageNumber, "icon", item, { mode: item.mode || "native" });
}


function tableDimensions(item) {
  const source = sourcePosition(item);
  const width = Number(source.width || (item.columnWidths || []).reduce(
    (total, value) => total + Number(value || 0), 0,
  ));
  const height = Number(source.height || (item.rowHeights || []).reduce(
    (total, value) => total + Number(value || 0), 0,
  ));
  return { ...source, width, height };
}


function addTable(slide, item, scale, pageNumber, manifest) {
  const pos = positionOf(tableDimensions(item), scale);
  const values = Array.isArray(item.values) ? item.values : [];
  const rows = values.map((row) => row.map((value) => String(value ?? "")));
  slide.addTable(rows, {
    ...pos,
    border: {
      type: "solid",
      color: hexColor(item.borderColor, "B7C9DE"),
      pt: Math.max(0.1, Number(item.borderWidth || 1)),
    },
    fill: hexColor(item.fill, "FFFFFF"),
    color: hexColor(item.color, "202020"),
    fontFace: item.fontFace || "Noto Sans CJK SC",
    fontSize: Math.max(1, Number(item.fontSize || 12)),
    margin: Number(item.margin || 2),
    autoFit: false,
    objectName: item.name || "semantic-table",
  });
  addManifest(manifest, pageNumber, "table", item, {
    rows: rows.length,
    columns: rows[0]?.length || 0,
  });
}


function addChart(slide, pptx, item, scale, pageNumber, manifest) {
  const pos = positionOf(item, scale);
  const type = pptx.ChartType[item.chartType || item.type] || pptx.ChartType.bar;
  const categories = item.categories || item.config?.categories || [];
  const sourceSeries = item.series || item.config?.series || [];
  const data = sourceSeries.map((series) => ({
    name: String(series.name || "Series"),
    labels: categories.map(String),
    values: (series.values || []).map(Number),
  }));
  slide.addChart(type, data, {
    ...pos,
    showLegend: item.hasLegend ?? item.config?.hasLegend ?? true,
    showTitle: false,
    showValue: Boolean(item.showValue),
    holeSize: Number(item.holeSize || item.config?.doughnutOptions?.holeSize || 50),
    objectName: item.name || "semantic-chart",
  });
  addManifest(manifest, pageNumber, "chart", item, {
    seriesCount: data.length,
    categoryCount: categories.length,
  });
}


export function applyPageOverrides({
  slide,
  pptx,
  pageOverride = {},
  pageNumber,
  slideWidth,
  coordinateWidth = 1280,
  assetRoot = process.cwd(),
}) {
  const scale = slideWidth / Number(pageOverride.coordinateWidth || coordinateWidth);
  const manifest = [];
  const nodes = new Map();

  for (const item of pageOverride.shapes || []) {
    if (item.name) nodes.set(item.name, positionOf(item, scale));
  }
  for (const item of pageOverride.covers || []) {
    addCover(slide, pptx, item, scale, pageNumber, manifest, assetRoot);
  }
  for (const item of pageOverride.connectors || []) {
    addConnector(slide, pptx, item, nodes, pageNumber, manifest);
  }
  for (const item of pageOverride.shapes || []) {
    addShape(slide, pptx, item, scale, pageNumber, manifest, nodes);
  }
  for (const item of pageOverride.charts || []) {
    addChart(slide, pptx, item, scale, pageNumber, manifest);
  }
  for (const item of pageOverride.tables || []) {
    addTable(slide, item, scale, pageNumber, manifest);
  }
  for (const item of pageOverride.icons || []) {
    addIcon(slide, pptx, item, scale, pageNumber, manifest, assetRoot);
  }
  // Text is the top semantic layer. This also lets callers use a full-slide
  // transparent frame image without covering editable labels.
  for (const item of pageOverride.texts || []) {
    addText(slide, item, scale, pageNumber, manifest);
  }
  return manifest;
}
