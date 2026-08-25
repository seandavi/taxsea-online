import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // Same-origin design (PLAN.md §2.2): the deployed Worker serves the SPA and
      // /api from one origin, so in dev we proxy /api (including the /ws upgrade)
      // to wrangler dev instead of hardcoding a domain anywhere in the app.
      '/api': {
        target: 'http://localhost:8787',
        ws: true,
      },
    },
  },
});
