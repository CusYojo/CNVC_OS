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
        // Flue SDK 使用同源 /ai/api；本地开发时转发到 .env 的 Agent 服务。
        '/ai': {
          target: flueTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
