import fs from "node:fs/promises";
import path from "node:path";
import {
  flattenElements,
  loadArtifactTool,
  parseArgs,
  setElementText,
  setSlideNotes,
  writeBlob,
  writeJson,
} from "./artifact_runtime.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.template || !args.plan || !args.output) {
  throw new Error(
    "用法：apply_template_plan.mjs --template template.pptx --plan content-plan.json --output final.pptx",
  );
}

const template = path.resolve(args.template);
const planPath = path.resolve(args.plan);
const output = path.resolve(args.output);
if (template === output) throw new Error("输出文件不能覆盖输入模板");
const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
if (plan.layoutPolicy !== "strict" || !Array.isArray(plan.operations)) {
  throw new Error("应用计划必须包含 layoutPolicy=strict 和 operations 数组");
}

const { module: artifactTool } = await loadArtifactTool(args["artifact-tool-dir"]);
const imported = await artifactTool.PresentationFile.importPptx(
  await artifactTool.FileBlob.load(template),
);
const proto = imported.toProto();
const applied = [];

for (const [index, operation] of plan.operations.entries()) {
  const slideNumber = Number(operation.slide);
  const slide = proto.slides?.[slideNumber - 1];
  if (!slide) throw new Error(`第 ${index + 1} 项页码超出范围：${slideNumber}`);
  const targets = operation.action === "replace_text_group"
    ? operation.shapeIds
    : [operation.shapeId];
  if (!["replace_text", "replace_text_group"].includes(operation.action)) {
    throw new Error(
      `第 ${index + 1} 项 ${operation.action} 尚无安全的原位执行器，已停止`,
    );
  }
  for (const rawShapeId of targets) {
    const shapeId = Number(rawShapeId);
    const target = flattenElements(slide.elements).find((element) =>
      Number(element.id) === shapeId);
    if (!target) {
      throw new Error(
        `第 ${index + 1} 项未找到第 ${slideNumber} 页 shapeId=${shapeId}`,
      );
    }
    if (!(target.paragraphs || []).length && target.type !== 1) {
      throw new Error(
        `第 ${index + 1} 项目标不是可编辑文字对象：第 ${slideNumber} 页 shapeId=${shapeId}`,
      );
    }
    setElementText(target, String(operation.text ?? ""));
    applied.push({
      operationIndex: index + 1,
      slide: slideNumber,
      shapeId,
      action: operation.action,
      status: "applied-in-place",
    });
  }
}

for (const [slideKey, notesText] of Object.entries(plan.sourceNotes || {})) {
  const slideNumber = Number(slideKey);
  const slide = proto.slides?.[slideNumber - 1];
  if (slide && String(notesText).trim()) {
    setSlideNotes(slide, String(notesText));
  }
}

const presentation = artifactTool.Presentation.load(proto);
const exported = await artifactTool.PresentationFile.exportPptx(presentation);
await fs.mkdir(path.dirname(output), { recursive: true });
await exported.save(output);

const renderDir = args["render-dir"]
  ? path.resolve(args["render-dir"])
  : undefined;
if (renderDir) {
  await fs.mkdir(renderDir, { recursive: true });
  for (const [index, slide] of presentation.slides.items.entries()) {
    await writeBlob(
      path.join(renderDir, `slide-${index + 1}.png`),
      await presentation.export({ slide, format: "png", scale: 1 }),
    );
  }
}

if (args.report) {
  await writeJson(path.resolve(args.report), {
    template,
    output,
    operationCount: applied.length,
    sourceNotesSlideCount: Object.keys(plan.sourceNotes || {}).length,
    renderedSlideCount: renderDir ? presentation.slides.items.length : 0,
    operations: applied,
  });
}
process.stdout.write(
  `已在原模板中应用 ${applied.length} 个白名单文字目标：${output}\n`,
);
