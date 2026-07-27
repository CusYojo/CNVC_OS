import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  base: '/ai/',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
