import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist', // 强制构建产物输出到根目录的 dist
    emptyOutDir: true,
  },
});