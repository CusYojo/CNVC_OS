import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const flueTarget = env.FLUE_BASE_URL || 'http://127.0.0.1:3584'

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:3100',
        '/generated': 'http://127.0.0.1:3100',
        // 只代理 Flue SDK 的接口前缀。不能代理整个 /ai，否则刷新 AI 助手
        // 页面时会把前端路由也转发到 Flue，加载远端旧页面并导致本地 API 失联。
        '/ai/api': {
          target: flueTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
