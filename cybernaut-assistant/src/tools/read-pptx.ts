import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute, basename } from 'node:path';
import AdmZip from 'adm-zip';

// 读取 .pptx（OpenXML）文件，提取每页幻灯片的文本内容（标题 + 正文）。
// pptx 本质是 zip：幻灯片正文在 ppt/slides/slideN.xml，文本节点为 <a:t>...</a:t>。
// 段落 <a:p> 之间换行；形状 <p:sp> 大致对应一个文本块。纯 node + adm-zip 实现，不依赖任何 Office 环境。
const WORKSPACE = process.env.AGENT_WORKSPACE ?? '/data/cybernaut-assistant/workspace';

// 从一段 slide xml 里按段落顺序抽取文本
function extractSlideText(xml: string): string {
  const lines: string[] = [];
  // 以 <a:p> 段落为单位切分，段落内拼接所有 <a:t> 文本
  const paras = xml.split(/<a:p[ >]/);
  for (const p of paras) {
    const texts: string[] = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      texts.push(decodeXml(m[1]));
    }
    const line = texts.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export const readPptx = defineTool({
  name: 'read_pptx',
  description: [
    '读取 .pptx（PowerPoint）文件并提取其中的文本内容，按幻灯片逐页返回（每页含标题与正文）。',
    '用于阅读/理解用户上传的 PPT、已有的投委会材料等。输入 pptx 文件路径（相对 AGENT_WORKSPACE 或绝对路径均可）。',
    '返回每页的纯文本；无法解析或非 pptx 会报错。',
  ].join(''),
  input: v.object({
    path: v.pipe(v.string(), v.description('要读取的 .pptx 文件路径，相对 AGENT_WORKSPACE 或绝对路径')),
  }),
  output: v.object({
    ok: v.boolean(),
    filename: v.string(),
    slideCount: v.number(),
    slides: v.array(v.object({
      index: v.number(),
      text: v.string(),
    })),
    text: v.string(), // 全部幻灯片拼接的纯文本，方便直接喂给模型
  }),
  async run({ input }) {
    const abs = isAbsolute(input.path) ? resolve(input.path) : resolve(WORKSPACE, input.path);
    // 【review AUTO-FIX】路径遍历/越权读取守卫：input.path 来自 LLM 工具参数(不可信)，
    // 未做 containment 时 "../../etc/passwd" 或绝对路径 "/root/.ssh/id_rsa" 可逃逸 WORKSPACE。
    // resolve 后强制要求落在 WORKSPACE 内(允许 WORKSPACE 本身及其子路径)，否则拒绝。
    const wsRoot = resolve(WORKSPACE);
    if (abs !== wsRoot && !abs.startsWith(wsRoot + '/')) {
      throw new Error(`拒绝越权访问：路径必须位于工作区(${wsRoot})内：${abs}`);
    }
    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`文件不存在或不是文件：${abs}`);
    if (!abs.toLowerCase().endsWith('.pptx')) throw new Error(`不是 .pptx 文件：${abs}`);

    const buf = await readFile(abs);
    let zip: AdmZip;
    try {
      zip = new AdmZip(buf);
    } catch (e) {
      throw new Error(`无法解析 pptx（zip 解压失败）：${(e as Error).message}`);
    }

    // 收集所有 ppt/slides/slideN.xml，按 N 排序
    const entries = zip.getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .map((e) => ({
        n: Number((e.entryName.match(/slide(\d+)\.xml$/) || [])[1] ?? 0),
        entry: e,
      }))
      .sort((a, b) => a.n - b.n);

    const slides = entries.map((it, i) => {
      const xml = it.entry.getData().toString('utf-8');
      return { index: i + 1, text: extractSlideText(xml) };
    });

    const text = slides
      .map((s) => `【第 ${s.index} 页】\n${s.text}`)
      .join('\n\n');

    return {
      ok: true,
      filename: basename(abs),
      slideCount: slides.length,
      slides,
      text,
    };
  },
});
