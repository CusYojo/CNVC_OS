import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EMU_PER_PIXEL = 9525;

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function existingDirectory(candidate) {
  if (!candidate) return undefined;
  try {
    return (await fs.stat(candidate)).isDirectory()
      ? path.resolve(candidate)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveArtifactToolDir(explicit) {
  const candidates = [
    explicit,
    process.env.ARTIFACT_TOOL_DIR,
    path.resolve(process.cwd(), "node_modules", "@oai", "artifact-tool"),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "node_modules",
      "@oai",
      "artifact-tool",
    ),
    path.resolve(
      process.env.HOME || "",
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
      "@oai",
      "artifact-tool",
    ),
  ];
  for (const candidate of candidates) {
    const resolved = await existingDirectory(candidate);
    if (!resolved) continue;
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(resolved, "package.json"), "utf8"),
      );
      if (metadata.name === "@oai/artifact-tool") return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "未找到 @oai/artifact-tool；请设置 ARTIFACT_TOOL_DIR 或 --artifact-tool-dir",
  );
}

export async function loadArtifactTool(explicit) {
  const root = await resolveArtifactToolDir(explicit);
  const entrypoint = path.join(root, "dist", "artifact_tool.mjs");
  return {
    root,
    module: await import(pathToFileURL(entrypoint).href),
  };
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function elementText(element) {
  return (element.paragraphs || [])
    .map((paragraph) =>
      (paragraph.runs || []).map((run) => String(run.text || "")).join(""))
    .join("\n");
}

export function elementKind(element) {
  if (element.chartReference || element.chart) return "chart";
  if (element.table || element.tableReference) return "table";
  if (element.imageReference || element.type === 7) return "picture";
  if ((element.paragraphs || []).length || element.type === 1) {
    return "shape:textbox";
  }
  if ((element.children || []).length) return "shape:group";
  return "shape:vector";
}

function bboxSnapshot(bbox = {}) {
  const x = Number(bbox.xEmu || 0);
  const y = Number(bbox.yEmu || 0);
  const width = Number(bbox.widthEmu || 0);
  const height = Number(bbox.heightEmu || 0);
  return [
    x / EMU_PER_PIXEL,
    y / EMU_PER_PIXEL,
    width / EMU_PER_PIXEL,
    height / EMU_PER_PIXEL,
  ].map((value) => Math.round(value * 100) / 100);
}

function styleSnapshot(element) {
  const firstParagraph = element.paragraphs?.[0];
  const firstRun = firstParagraph?.runs?.[0];
  return {
    body: deepClone(element.textStyle || {}),
    paragraph: deepClone(firstParagraph?.paragraphStyle || {}),
    paragraphText: deepClone(firstParagraph?.textStyle || {}),
    run: deepClone(firstRun?.textStyle || {}),
  };
}

function mediaReferenceId(element) {
  return element.imageReference?.id
    || element.fill?.imageReference?.id
    || element.chartReference?.id
    || null;
}

function bytesFromProtoData(data) {
  if (!data) return undefined;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object") {
    const values = Object.keys(data)
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => Number(data[key]));
    return Buffer.from(values);
  }
  return undefined;
}

function mediaHashes(proto) {
  return new Map((proto.images || []).map((image) => {
    const bytes = bytesFromProtoData(image.data);
    return [
      String(image.id || ""),
      bytes?.length ? sha256(bytes) : String(image.id || ""),
    ];
  }));
}

export function flattenElements(elements, result = []) {
  for (const element of elements || []) {
    result.push(element);
    flattenElements(element.children, result);
  }
  return result;
}

function objectSnapshot(element, zIndex, hashByMediaId) {
  const text = elementText(element);
  const mediaId = mediaReferenceId(element);
  const snapshot = {
    shapeId: Number(element.id),
    name: String(element.name || ""),
    kind: elementKind(element),
    role: element.placeholderType || "",
    bbox: bboxSnapshot(element.bbox),
    zIndex,
    text,
    textStyle: styleSnapshot(element),
    media: mediaId ? (hashByMediaId.get(mediaId) || mediaId) : null,
  };
  return {
    ...snapshot,
    fingerprint: sha256(
      Buffer.from(JSON.stringify(snapshot), "utf8"),
    ),
  };
}

export function mapFromProto(proto, inputSha256) {
  const hashByMediaId = mediaHashes(proto);
  const slides = (proto.slides || []).map((slide, slideIndex) => {
    const objects = flattenElements(slide.elements)
      .map((element, zIndex) =>
        objectSnapshot(element, zIndex, hashByMediaId))
      .filter((item) => Number.isInteger(item.shapeId) && item.shapeId > 0);
    return {
      number: slideIndex + 1,
      slideId: String(slide.id || ""),
      layoutId: String(slide.useLayoutId || ""),
      widthEmu: Number(slide.widthEmu || 0),
      heightEmu: Number(slide.heightEmu || 0),
      title: objects.find((item) => item.text.trim())?.text.trim() || "",
      objects,
    };
  });
  return {
    schemaVersion: "1.0",
    producerSkill: "editable-ppt-content-replacer",
    sha256: inputSha256,
    slideCount: slides.length,
    layoutCount: Array.isArray(proto.layouts) ? proto.layouts.length : 0,
    masterCount: Array.isArray(proto.masters) ? proto.masters.length : undefined,
    mediaIds: [
      ...new Set(
        slides.flatMap((slide) =>
          slide.objects.map((item) => item.media).filter(Boolean)),
      ),
    ].sort(),
    slides,
  };
}

function firstTextTemplate(element) {
  const paragraph = element.paragraphs?.[0] || {
    id: "",
    runs: [],
    textStyle: {},
    inlineNodes: [],
    paragraphStyle: {},
  };
  const run = paragraph.runs?.[0] || {
    id: "",
    text: "",
    textStyle: {},
    citations: [],
    reviewMarkIds: [],
  };
  return { paragraph, run };
}

export function setElementText(element, text) {
  const { paragraph, run } = firstTextTemplate(element);
  const lines = String(text).split("\n");
  element.paragraphs = lines.map((line) => ({
    ...deepClone(paragraph),
    id: "",
    runs: [{
      ...deepClone(run),
      id: "",
      text: line,
      citations: deepClone(run.citations || []),
      reviewMarkIds: deepClone(run.reviewMarkIds || []),
    }],
    inlineNodes: [],
  }));
}

export function setSlideNotes(slide, notesText) {
  if (!notesText) return;
  const notesSlide = slide.notesSlide || { id: "", elements: [] };
  slide.notesSlide = notesSlide;
  let body = (notesSlide.elements || []).find((element) =>
    element.placeholderType === "body");
  if (!body) {
    body = {
      id: "",
      name: "Notes Placeholder",
      type: 1,
      placeholderIndex: 1,
      placeholderType: "body",
      zIndex: 0,
      textStyle: {},
      paragraphs: [],
      effects: [],
      children: [],
      levelsStyles: [],
      citations: [],
    };
    notesSlide.elements.push(body);
  }
  setElementText(body, notesText);
}

export async function writeJson(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeBlob(targetPath, blob) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(
    targetPath,
    new Uint8Array(await blob.arrayBuffer()),
  );
}
