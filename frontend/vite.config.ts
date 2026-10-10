import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.HYPERSPACE_API ?? 'http://127.0.0.1:8765',
      '/sessions': process.env.HYPERSPACE_API ?? 'http://127.0.0.1:8765',
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
        audioTest: 'audio-test.html',
      },
    },
  },
  assetsInclude: ['**/*.glsl', '**/*.vert', '**/*.frag'],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
