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
if (!args.input || !args.output) {
  throw new Error(
    "用法：analyze_template.mjs --input template.pptx --output template-map.json",
  );
}

const input = path.resolve(args.input);
const output = path.resolve(args.output);
const bytes = await fs.readFile(input);
const { module: artifactTool } = await loadArtifactTool(args["artifact-tool-dir"]);
const presentation = await artifactTool.PresentationFile.importPptx(
  await artifactTool.FileBlob.load(input),
);
const map = mapFromProto(presentation.toProto(), sha256(bytes));
await writeJson(output, {
  ...map,
  input,
});
process.stdout.write(
  `已分析 ${map.slideCount} 页、${map.slides.reduce((sum, slide) => sum + slide.objects.length, 0)} 个对象：${output}\n`,
);
