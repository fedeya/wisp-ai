import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'src',
  plugins: [tailwindcss(), react()],
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2022', 'chrome105', 'safari15'],
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./src/index.html', import.meta.url)),
        updater: fileURLToPath(new URL('./src/updater.html', import.meta.url)),
      },
    },
  },
});
