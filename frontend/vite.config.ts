import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/sessions': 'http://127.0.0.1:8765',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: 'index.html',
        safetyTest: 'safety-test.html',
        report: 'report.html',
      },
    },
  },
  assetsInclude: ['**/*.glsl', '**/*.vert', '**/*.frag'],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
