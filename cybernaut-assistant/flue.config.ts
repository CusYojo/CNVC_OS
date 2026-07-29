import { defineConfig } from '@flue/cli/config';

// 情报抓取脚本会在工作流执行期由 Python 读取。Flue beta 的 Node 开发
// 监听器会把 scripts 目录里的任意文件系统事件都当成源码变更，进而在
// 长任务尚未完成时强制 drain runtime，造成“Reviewer 失败/35%”。
// scripts 不参与 Vite 模块构建，忽略该目录不会影响脚本按次读取最新内容。
export const vite = {
  server: {
    watch: {
      ignored: ['**/scripts/**'],
    },
  },
};

export default defineConfig({
  target: 'node',
  output: 'dist/server',
});
