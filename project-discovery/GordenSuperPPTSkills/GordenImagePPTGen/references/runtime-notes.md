# 运行时与模型差异适配

本 Skill 的**主目标运行时是 Codex 里的 GPT**，图片生成统一接入用户网关；Cursor/Claude 等运行时也应优先调用同一个网关脚本。抠图、看图(OCR/定位) 的具体调用方式因运行时而异。动手前先按本页解析后端。

---

## 1. 图片生成后端解析顺序

1. **用户当条消息点名了后端** → 用它。
2. **本技能默认后端** → 用 `scripts/generate_gateway_slide_image.py` 调用户网关（创建任务 `/v1/images/generations`，轮询 `/v1/images/result`）。
3. **其它原生图像工具**（如 Codex 内置 imagegen、Cursor `GenerateImage`、Hermes `image_generate`）只在用户明确要求切换时使用。
4. 网关 API key 缺失或接口不可用 → 停止并说明阻塞原因。

**绝不**用 SVG / HTML / Canvas / 代码绘图冒充 raster 出图。**绝不**在已生成的位图上用代码补字/盖字。

---

## 2. 在 Codex（GPT）里 —— 主路径

### 出图（功能 A、功能 B 的背景/图标）
- 调用本技能脚本 `scripts/generate_gateway_slide_image.py`，默认模型 `gpt-image-2-reverse-2`，默认网关 `https://getways-jumu.zeelin.cn`。
- API key 从环境变量读取：`GATEWAY_IMAGE_API_KEY`、`MODEL_GATEWAY_API_KEY` 或 `OPENAI_API_KEY`。可选 base URL：`GATEWAY_IMAGE_BASE_URL`、`MODEL_GATEWAY_BASE_URL` 或 `OPENAI_BASE_URL`。
- 一次调用出一张图；要多张就发多次调用（功能 A 批量、功能 B 多张图标图同理）。
- **比例**：默认 16:9 用 `--size 2560x1440`；方形图标图用 `--size 1024x1024`。提示词仍要写清比例和安全边。
- **保存位置**：脚本会把网关返回 URL 下载到 `--out-dir`，建议每页先输出到任务目录下 `slides/` 或临时目录后改名为 `slides/NN-*.png`。不要只保存 URL。
- **生成证据**：功能 A 必须写 `imagegen-manifest.json`，逐页记录 `backend: gateway-gpt-image`、`prompt_file`、`task_id`、`metadata_json`、`copied_to`；没有这份 manifest 不能进入合成与还原阶段。
- **编辑本地图**（功能 B 擦除式背景）：把原图路径或 URL 通过 `--image` 传给脚本；提示词反复声明不变量（"只移除文字/图标/卡片，保留底色与渐变"）。

常用命令：

```bash
python3 scripts/generate_gateway_slide_image.py --prompt @prompts/01-cover.md --out-dir slides --size 2560x1440 --quality high
python3 scripts/generate_gateway_slide_image.py --prompt "把背景换成海滩日落" --image https://example.com/photo.png --out-dir slides --size 1024x1024 --quality medium
```

### 抠透明（功能 B：框架/图标去底）
- **首选本技能自带脚本 `scripts/chroma_key.py`（保色保线，跨运行时一致）**：
  ```bash
  python3 scripts/chroma_key.py --input <绿底图> --out <透明图.png> --force
  # 非绿底：--auto-key none --key-color "#ff00ff"
  ```
- 它**只对绿色主导像素去溢出**，对红/藏青/灰/白是 no-op → **绝不褪色**；默认不腐蚀边缘 → **不丢细线/辉光**。这是为扁平信息图（框架/图标）专门调的。
- 兜底：无该脚本时才用 Codex 的 `remove_chroma_key.py`，且**不要**叠 `--soft-matte --despill`（会把红色图标抠成灰白、吃掉框架线），用纯 `--auto-key border` 即可。
- 抠完务必把透明图合到灰底自检：颜色对不对、线/辉光在不在、有无残边（见 image-to-pptx.md B5「抠图保真铁律」）。

### 看图（OCR/图标定位）
- 直接用 GPT 自身视觉读图，输出结构化 JSON（`texts[]` / `icons[]` 坐标）。无需外部 OCR 引擎。

### CLI 兜底
- 本技能已经使用 CLI 脚本接网关。只有用户明确要求不用网关时，才切回 Codex 内置 imagegen 或其它原生工具。

---

## 3. 在 Cursor / Claude（本 Skill 的开发&测试环境）里

- 出图：优先运行 `scripts/generate_gateway_slide_image.py`。只有用户明确要求使用运行时原生工具时，才用 `GenerateImage` 工具（提示词里写比例/分辨率）。
- 抠透明：用本技能自带 `scripts/chroma_key.py`（首选，保色保线）。
- 看图：用 Claude 自身视觉读图输出 JSON。
- 其余脚本（`probe_palette.py` / `slice_grid.py` / `compose_pptx.py`）与 Codex 完全一致。

---

## 4. GPT 与 Claude/Opus 的差异要点（写给最终在 Codex 跑的 GPT）

- **工具名不同**：本技能不再依赖 Codex 默认 imagegen；默认通过 `scripts/generate_gateway_slide_image.py` 调网关。
- **图片落盘**：网关结果 URL 可能有时效；脚本下载后仍要把最终文件命名到本任务 `slides/`，并在 manifest 里记录 `metadata_json`。
- **逐字照排**：严格使用用户文字/数据，零编造（全局铁律）。生僻字在出图提示词里逐字拆开强调以提升渲染正确率。
- **结构化输出**：`layout.json` / `deck.json` 要求严格合法 JSON（双引号、无尾逗号、hex 带 `#`）。
- **批量**：多资产用"多次单图调用"，不要用一次 `n` 张来替代不同内容的图。
- **确认策略**：功能 A 默认先确认风格/受众/页数/语言；用户说"直接生成/不用确认"才跳过，并在开跑前声明所用设定。
- **不要代码补字**：任何运行时都禁止在位图上用 ImageMagick/Pillow/SVG 盖字改字；错字就改提示词重出。

---

## 5. 比例与尺寸速查

**比例由用户决定**：默认 16:9；用户说 3:2（或后端原生 3:2 且用户接受）就直接用 3:2，**不必裁切**。功能 A 出图、功能 B 背景/框架/图标、`compose_pptx.py` 画布要**全程同一比例**。

| 用途 | 比例 | 建议尺寸 / 画布 |
|---|---|---|
| 幻灯片（功能 A / 功能 B 背景/框架） | 跟随用户：16:9 或 3:2 | 16:9→2048×1152；3:2→1536×1024 |
| `compose_pptx.py` 画布 | 16:9→13.333×7.5in；**3:2→13.333×8.889in**；4:3→10×7.5in | 配 `ref_width/ref_height` 用原图像素 |
| 图标提取网格图（功能 B） | 1:1 正方形 | 越大越好（如 2048×2048） |

- Cursor `GenerateImage` 原生出 **3:2（1536×1024）**：目标 3:2 时直接用最省事。
- 网关脚本：用 `--size` 指定真实输出尺寸，同时在提示词里表达比例；中文乘号 `×` 会自动规范化为 `x`。

### 只要 16:9 但后端只出 3:2 时

1. 提示词按"16:9 构图、上下留安全边"生成（关键内容别贴最上/最下边）。
2. 居中裁切：3:2 的 1536×1024 → 1536×864：
   ```bash
   python3 -c "from PIL import Image;im=Image.open('in.png');w,h=im.size;th=int(w*9/16);t=(h-th)//2;im.crop((0,t,w,t+th)).save('out.png')"
   ```
3. 背景/框架/图标参考也同样裁，保持与幻灯片对齐后再 compose。

## 6. 排版参考图库 `参考图/`

技能自带 `参考图/`（高密度复杂排版范例，子集如 `red_grey_project / work_result / tech_prize / scholar_green / leader_love`，各含 ref1..N.png）。

- **用途**：功能 A 出图前，挑与本页结构最像的参考图，把其**布局骨架**写进提示词（见 image-prompt-guide.md §1.6）。
- **可作 reference 传入**：网关脚本支持 `--image <URL|本地路径|data URL|base64>`；传入时务必在提示词写明"**只参考排版/构图，不要使用其配色与文字**"。
- 严禁照搬参考图的颜色、文字、品牌元素——配色一律用本页指定的【整体风格】色。
