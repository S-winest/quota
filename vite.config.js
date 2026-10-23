import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * 部署目标：GitHub Pages（可能是 https://user.github.io/repo/ 这种子路径）。
 * base 用相对路径，构建产物可以直接放在任意子目录。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
  },
  // 编辑器保存时会先在同目录写临时文件再改名，Windows 上可能让 watcher 报 EBUSY
  server: {
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: '额度 · 今天还能花多少',
        short_name: '额度',
        description: '每日可花额度的约束工具，数据只存在本机。',
        lang: 'zh-CN',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f4f5f7',
        theme_color: '#0f766e',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
