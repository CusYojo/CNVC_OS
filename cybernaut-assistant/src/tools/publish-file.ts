import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute, basename, extname } from 'node:path';
import OSS from 'ali-oss';

// 把 agent 在沙箱里生成的成品文件上传到阿里云 OSS，返回前端可直接下载的公开 URL。
// OSS 凭证只存在 flue 服务进程的 env（.env 经 systemd --env-file 注入），沙箱/bash 拿不到。
const WORKSPACE = process.env.AGENT_WORKSPACE
  ?? resolve(process.cwd(), '..', '.runtime', 'cybernaut-assistant', 'workspace');
const ENDPOINT = process.env.OSS_ENDPOINT ?? '';
const REGION = ENDPOINT.replace(/\.aliyuncs\.com$/, '');
const BUCKET = process.env.OSS_BUCKET ?? '';
const AK = process.env.OSS_ACCESS_KEY_ID ?? '';
const SK = process.env.OSS_ACCESS_KEY_SECRET ?? '';
const PREFIX = (process.env.OSS_PREFIX ?? 'skillsTmpFiles').replace(/\/+$/, '');
const PUBLIC_BASE = (process.env.OSS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

const CONTENT_TYPES: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export const publishFile = defineTool({
  name: 'publish_file',
  description: [
    '把你在工作目录/沙箱里生成的成品文件（PPT .pptx、图片、PDF、Word、Excel、zip 等）上传到对象存储(OSS)，',
    '返回一个前端可直接下载的公开 URL。沙箱内的文件前端看不到，所以生成 PPT/投委会材料/图片等交付物后，',
    '必须调用本工具拿到下载链接再交给用户。输入要上传文件的路径（相对工作目录或绝对路径均可）。',
  ].join(''),
  input: v.object({
    path: v.pipe(v.string(), v.description('要上传的文件路径，相对 AGENT_WORKSPACE 或绝对路径')),
    filename: v.optional(v.pipe(v.string(), v.description('可选：下载时展示的文件名，默认用原文件名'))),
  }),
  output: v.object({
    ok: v.boolean(),
    url: v.string(),
    filename: v.string(),
  }),
  async run({ input }) {
    if (!BUCKET || !AK || !SK) {
      throw new Error('OSS 未配置：缺少 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    }
    const abs = isAbsolute(input.path) ? input.path : resolve(WORKSPACE, input.path);
    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`文件不存在或不是文件：${abs}`);
    const buf = await readFile(abs);
    const base = basename(abs);
    const display = input.filename?.trim() || base;
    const ext = extname(base).toLowerCase();
    const key = `${PREFIX}/${Date.now()}-${base}`;

    const client = new OSS({ region: REGION, accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, secure: true });
    const headers: Record<string, string> = {};
    if (CONTENT_TYPES[ext]) headers['Content-Type'] = CONTENT_TYPES[ext];
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(display)}`;
    await client.put(key, buf, { headers } as any);

    const url = PUBLIC_BASE ? `${PUBLIC_BASE}/${key}` : `https://${BUCKET}.${ENDPOINT}/${key}`;
    return { ok: true, url, filename: display };
  },
});
