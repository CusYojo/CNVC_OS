import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sqlite } from '@flue/runtime/node';

// 持久化 Flue 的 canonical 会话流（agent 对话历史）到本机文件：
// 服务重启后历史仍在，前端 useFlueAgent 刷新/切换会话都能重放。
// 单机部署用 file-backed sqlite 即可（Flue 官方对单机 Node 的推荐适配器）。
const databasePath = resolve(
  process.env.FLUE_DB_PATH
    ?? resolve(process.cwd(), '..', '.runtime', 'cybernaut-assistant', 'flue.db'),
);
mkdirSync(dirname(databasePath), { recursive: true });

export default sqlite(databasePath);
