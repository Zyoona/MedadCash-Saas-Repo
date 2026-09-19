import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'مداد — إدارة ومحاسبة المكتبة',
        short_name: 'مداد',
        dir: 'rtl',
        lang: 'ar',
        start_url: '.',
        display: 'standalone',
        background_color: '#f1f5f9',
        theme_color: '#ffffff',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
