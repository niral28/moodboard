import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'path';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@frontend': path.resolve(__dirname, '../frontend/src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
