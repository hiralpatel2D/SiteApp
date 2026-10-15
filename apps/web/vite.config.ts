import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev and preview serve the app and the API from one origin, as production does
// (apps/web/server.mjs), so cookies and the API's Origin check just work.
// Dev and e2e only: this proxy forwards a client-sent x-client-ip unchanged, so
// it is spoofable. Production uses server.mjs, which overwrites that header.
const apiProxy = { '/api': { target: process.env.API_URL || 'http://localhost:3000' } };

export default defineConfig({
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Site Diary',
        short_name: 'Site Diary',
        description: 'Every site, every day, on record.',
        theme_color: '#e8590c',
        background_color: '#f3f4f6',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only: precache built assets, never runtime-cache API calls.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
