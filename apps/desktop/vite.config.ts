import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'src',
  plugins: [tailwindcss(), svelte({ configFile: '../svelte.config.js' })],
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2022', 'chrome105', 'safari15'],
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./src/index.html', import.meta.url)),
        updater: fileURLToPath(new URL('./src/updater.html', import.meta.url)),
      },
    },
  },
});
