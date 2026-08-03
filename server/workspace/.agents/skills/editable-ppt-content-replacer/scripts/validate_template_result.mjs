import fs from "node:fs/promises";
import path from "node:path";
import {
  loadArtifactTool,
  mapFromProto,
  parseArgs,
  sha256,
  writeJson,
} from "./artifact_runtime.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.template || !args.result || !args.plan || !args.output) {
  throw new Error(
    "用法：validate_template_result.mjs --template template.pptx --result result.pptx --plan content-plan.json --output fidelity-report.json",
  );
}

const templatePath = path.resolve(args.template);
const resultPath = path.resolve(args.result);
const plan = JSON.parse(await fs.readFile(path.resolve(args.plan), "utf8"));
const { module: artifactTool } = await loadArtifactTool(args["artifact-tool-dir"]);

async function analyze(pptxPath) {
  const bytes = await fs.readFile(pptxPath);
  const presentation = await artifactTool.PresentationFile.importPptx(
    await artifactTool.FileBlob.load(pptxPath),
  );
  return mapFromProto(presentation.toProto(), sha256(bytes));
}

const [before, after] = await Promise.all([
  analyze(templatePath),
  analyze(resultPath),
]);
const errors = [];
const authorized = new Map();
for (const operation of plan.operations || []) {
  const ids = operation.action === "replace_text_group"
    ? operation.shapeIds
    : [operation.shapeId];
  for (const shapeId of ids || []) {
    authorized.set(
      `${Number(operation.slide)}:${Number(shapeId)}`,
      String(operation.text ?? ""),
    );
  }
}

if (before.slideCount !== after.slideCount) {
  errors.push(`页面数量变化：${before.slideCount} -> ${after.slideCount}`);
}
if (before.layoutCount !== after.layoutCount) {
  errors.push(`版式数量变化：${before.layoutCount} -> ${after.layoutCount}`);
}
if (before.mediaIds.length !== after.mediaIds.length) {
  errors.push(`媒体数量变化：${before.mediaIds.length} -> ${after.mediaIds.length}`);
}

for (const sourceSlide of before.slides) {
  const resultSlide = after.slides[sourceSlide.number - 1];
  if (!resultSlide) continue;
  if (
    sourceSlide.widthEmu !== resultSlide.widthEmu
    || sourceSlide.heightEmu !== resultSlide.heightEmu
  ) {
    errors.push(`第 ${sourceSlide.number} 页画布尺寸发生变化`);
  }
  if (sourceSlide.layoutId !== resultSlide.layoutId) {
    errors.push(`第 ${sourceSlide.number} 页 layoutId 发生变化`);
  }
  const resultObjects = new Map(
    resultSlide.objects.map((item) => [item.shapeId, item]),
  );
  if (sourceSlide.objects.length !== resultSlide.objects.length) {
    errors.push(
      `第 ${sourceSlide.number} 页对象数量变化：${sourceSlide.objects.length} -> ${resultSlide.objects.length}`,
    );
  }
  for (const sourceObject of sourceSlide.objects) {
    const key = `${sourceSlide.number}:${sourceObject.shapeId}`;
    const resultObject = resultObjects.get(sourceObject.shapeId);
    if (!resultObject) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 丢失`);
      continue;
    }
    if (sourceObject.kind !== resultObject.kind) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 类型变化`);
    }
    if (JSON.stringify(sourceObject.bbox) !== JSON.stringify(resultObject.bbox)) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 坐标尺寸变化`);
    }
    if (
      JSON.stringify(sourceObject.textStyle)
      !== JSON.stringify(resultObject.textStyle)
    ) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 文字样式变化`);
    }
    if (sourceObject.media !== resultObject.media) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 媒体引用变化`);
    }
    if (authorized.has(key)) {
      if (resultObject.text !== authorized.get(key)) {
        errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 未写入计划文字`);
      }
    } else if (sourceObject.text !== resultObject.text) {
      errors.push(`第 ${sourceSlide.number} 页 shapeId=${sourceObject.shapeId} 发生未授权文字修改`);
    }
  }
}

const report = {
  passed: errors.length === 0,
  template: templatePath,
  result: resultPath,
  authorizedTargetCount: authorized.size,
  slideCountPreserved: before.slideCount === after.slideCount,
  layoutCountPreserved: before.layoutCount === after.layoutCount,
  mediaCountPreserved: before.mediaIds.length === after.mediaIds.length,
  errors,
  before: {
    slideCount: before.slideCount,
    layoutCount: before.layoutCount,
    mediaCount: before.mediaIds.length,
    objectCount: before.slides.reduce((sum, slide) => sum + slide.objects.length, 0),
  },
  after: {
    slideCount: after.slideCount,
    layoutCount: after.layoutCount,
    mediaCount: after.mediaIds.length,
    objectCount: after.slides.reduce((sum, slide) => sum + slide.objects.length, 0),
  },
};
await writeJson(path.resolve(args.output), report);
if (!report.passed) {
  for (const error of errors.slice(0, 50)) process.stderr.write(`- ${error}\n`);
  throw new Error(`模板保真校验失败，共 ${errors.length} 项差异`);
}
process.stdout.write(
  `模板保真校验通过：${report.before.slideCount} 页、${report.before.objectCount} 个对象、${report.before.mediaCount} 个媒体引用保持结构一致\n`,
);
