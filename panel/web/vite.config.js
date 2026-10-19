import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `node panel/server.js` on 8110 + `npm run dev` here; /api is proxied.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8110' } },
});
