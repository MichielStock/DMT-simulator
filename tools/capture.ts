// Real-time frame capture (never time-warped) of a page rendered by real Chrome with the GPU.
//
//   cd frontend && node --experimental-strip-types ../tools/capture.ts \
//       --url http://127.0.0.1:5173/safety-test.html?pattern=bw10 --seconds 10 --fps 30 --out ../verification/captures/x
//
// Options: --width 1280 --height 720 --format png|jpeg --method screencast|screenshot
//          --angle default|swiftshader|vulkan --warmup-ms 1500 --headless
// Writes <out>/frame_000001.png ... and <out>/capture.json (requested and achieved fps, GPU renderer).
// Opens /usr/bin/google-chrome headed on $DISPLAY (re-executes itself under xvfb-run when DISPLAY is unset).
// Only erasable TypeScript syntax (Node 24 strips types natively).
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startCapture } from '../tests/e2e/helpers/capture.ts';

interface Args {
  url: string; seconds: number; fps: number; out: string; width: number; height: number;
  format: 'png' | 'jpeg'; method: 'screencast' | 'screenshot'; angle: string; warmupMs: number; headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    url: '', seconds: 10, fps: 30, out: '', width: 1280, height: 720, format: 'png', method: 'screencast',
    angle: 'default', warmupMs: 1500, headless: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    switch (k) {
      case '--url': a.url = v; i++; break;
      case '--seconds': a.seconds = Number(v); i++; break;
      case '--fps': a.fps = Number(v); i++; break;
      case '--out': a.out = v; i++; break;
      case '--width': a.width = Number(v); i++; break;
      case '--height': a.height = Number(v); i++; break;
      case '--format': a.format = v === 'jpeg' ? 'jpeg' : 'png'; i++; break;
      case '--method': a.method = v === 'screenshot' ? 'screenshot' : 'screencast'; i++; break;
      case '--angle': a.angle = v; i++; break;
      case '--warmup-ms': a.warmupMs = Number(v); i++; break;
      case '--headless': a.headless = true; break;
      case '--timewarp': throw new Error('capture never time-warps (BUILD.md §4.1)');
      default: if (k.startsWith('--')) throw new Error(`unknown option ${k}`);
    }
  }
  if (!a.url || !a.out) throw new Error('usage: capture.ts --url <url> --out <dir> [--seconds 10] [--fps 30]');
  return a;
}

export function chromeArgs(angle: string): string[] {
  return ['--use-gl=angle', `--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // When the desktop session on :1 is locked/blanked, the compositor presents at 1 Hz and rAF stalls;
    // without GPU vsync Chrome falls back to its own ~60 Hz begin-frame source (still real time).
    '--disable-gpu-vsync'];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DISPLAY && !args.headless && !process.env.HYPERSPACE_UNDER_XVFB) {
    const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath,
      ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, HYPERSPACE_UNDER_XVFB: '1' } });
    process.exit(r.status ?? 1);
  }
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
  const executablePath = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
  const browser = await chromium.launch({ executablePath, headless: args.headless, args: chromeArgs(args.angle) });
  try {
    const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
    await page.goto(args.url, { waitUntil: 'load' });
    await page.waitForTimeout(args.warmupMs);
    const gpu = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { webgl2: false, renderer: 'none' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) };
    });
    const res = await startCapture(page, path.resolve(args.out), args.seconds, args.fps,
      { format: args.format, method: args.method });
    const metaPath = path.join(path.resolve(args.out), 'capture.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.gpu = gpu; meta.angle = args.angle;
    meta.softwareRendering = /swiftshader|llvmpipe|software/i.test(gpu.renderer);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`capture: ${res.frames} frames at ${res.fps} fps (${res.method}, achieved ${res.achievedFps} fps, `
      + `max gap ${res.maxGapMs} ms) -> ${res.dir}; GPU: ${gpu.renderer}`);
    if (res.achievedFps < 20) console.warn('capture: WARNING achieved fps below 20');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
