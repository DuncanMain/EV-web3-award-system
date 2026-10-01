import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.NVF_ADMIN_API_ORIGIN || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      '/admin': apiTarget,
      '/ingest': apiTarget,
      '/spend': apiTarget,
      '/wallet': apiTarget,
      '/transactions': apiTarget,
    },
  },
});
