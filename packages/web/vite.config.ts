import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.STRIPS_SERVER ?? 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: target.replace('http', 'ws'), ws: true },
      '/auth': target,
      '/api': target,
    },
  },
});
