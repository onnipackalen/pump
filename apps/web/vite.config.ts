import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the API runs as its own process (npm run dev:server).
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
