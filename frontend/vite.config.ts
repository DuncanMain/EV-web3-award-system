import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      '/admin': 'http://127.0.0.1:3000',
      '/ingest': 'http://127.0.0.1:3000',
      '/spend': 'http://127.0.0.1:3000',
      '/wallet': 'http://127.0.0.1:3000',
      '/transactions': 'http://127.0.0.1:3000',
    },
  },
});
