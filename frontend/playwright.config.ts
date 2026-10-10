import { defineConfig } from '@playwright/test';

// End-to-end and capture tests. The server (back end + built front end) is started by
// ../run.sh --serve-only unless one is already listening on 8765 (verify_all.sh starts it).
export default defineConfig({
  testDir: '../tests/e2e',
  timeout: 15 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../verification/e2e-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:8765',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
             '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'cd .. && ./run.sh --serve-only',
    url: 'http://127.0.0.1:8765/api/status',
    reuseExistingServer: true,
    timeout: 10 * 60 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
