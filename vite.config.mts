import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./webview', import.meta.url)),
  base: './',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/webview', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  plugins: [vue()],
});
