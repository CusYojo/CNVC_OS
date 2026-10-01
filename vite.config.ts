import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      // Never silently move to a fallback port: API writes use an origin allow-list.
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': 'http://127.0.0.1:4100',
        '/generated': 'http://127.0.0.1:4100',
        '/socket.io': {
          target: 'http://127.0.0.1:4100',
          ws: true,
        },
      },
    },
  }
})
