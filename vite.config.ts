import { defineConfig } from 'vite';

// GitHub Pages публикует репозиторий в подпапке https://user.github.io/repo/,
// поэтому относительные пути ассетов ломаются без явного base.
// При локальной разработке (npm run dev) base не нужен — Vite сам не
// применяет его к dev-серверу так, чтобы это мешало.
const BASE = process.env.GITHUB_PAGES ? '/sergey-ai-g2/' : '/';

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2020',
    rollupOptions: {
      input: {
        main: 'index.html',
        settings: 'settings.html',
      },
    },
  },
  server: { host: true },  // нужен для QR-сайдлоада с телефона
});
