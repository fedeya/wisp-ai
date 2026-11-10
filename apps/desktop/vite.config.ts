import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: 'src',
  plugins: [tailwindcss(), svelte({ configFile: '../svelte.config.js' })],
  server: { host: '127.0.0.1', port: Number(process.env.VITE_DEV_PORT || 1420), strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true, target: ['es2022', 'chrome105', 'safari15'] },
});
