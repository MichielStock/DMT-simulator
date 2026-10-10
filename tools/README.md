# tools/

## flashcheck.py — photosensitivity check (PROTECTED thresholds, BUILD.md §4.1)

```
uv run python tools/flashcheck.py <frames_dir | video.mp4> [--fps N] [--json report.json]
```

Reads a folder of frames (sorted by name, png/jpg) or a video (opencv), at the frame rate from `--fps`,
else `<dir>/capture.json`, else the video header, else 30. Prints max general flashes per second, red
flashes, pattern frames and the capture's achieved fps; exits 1 on any violation (2 on error).

* General flash: a pair of opposing transitions of >= 0.10 relative luminance (sRGB decoded to linear,
  Rec. 709 weights) between successive extrema, darker state < 0.80. Counted per 64x36 tile (region =
  more than 25% of tiles), on the whole-frame mean, and on a 128x72 grid of point probes (fine patterns
  that flicker inside a tile). Violation: more than 3 flashes in any sliding 1-second window.
* Red flash: the same on the saturated-red signal (R/(R+G+B) >= 0.8).
* Pattern: 8x4 blocks, 2-D FFT; a dominant spatial peak (>= 3 cycles per block, >= 30% of AC energy)
  with Michelson contrast > 0.5 covering more than 25% of the screen is a violation; a large periodic
  pattern whose probes oscillate faster than 2 Hz is a pattern-motion violation.

Frames must be captured at real time (never with `?timewarp=`).

## capture.ts — real-time capture in real Chrome with the GPU

```
cd frontend && node --experimental-strip-types ../tools/capture.ts \
    --url "http://127.0.0.1:5173/safety-test.html?pattern=bw10" --seconds 10 --fps 30 \
    --out ../verification/captures/bw10
```

Options: `--width 1280 --height 720 --format png|jpeg --method screencast|screenshot
--angle default|swiftshader --warmup-ms 1500 --headless`.

Launches `/usr/bin/google-chrome` headed on `$DISPLAY` (re-executes itself under `xvfb-run` when DISPLAY
is unset) with `--use-gl=angle --use-angle=default --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync`.
Frames come from CDP `Page.startScreencast` (timestamps from the compositor) and are resampled onto a
fixed `--fps` grid; `capture.json` records the requested fps, the achieved source fps, the largest gap and
the GPU renderer string. `--timewarp` is refused.

`--disable-gpu-vsync`: when the desktop session on :1 is locked or blanked, GNOME presents at 1 Hz and
requestAnimationFrame stalls; without vsync Chrome uses its own ~60 Hz frame source (still real time).

The same capture code is shared with Playwright specs: `tests/e2e/helpers/capture.ts`
(`startCapture(page, dir, seconds, fps, { onStart })`, `runFlashcheck(dir)`).

## Safety test page

`frontend/safety-test.html?pattern=bw10|red8|stripes|static[&debug=1]` renders one deliberately unsafe
pattern into the RenderPipeline, so it goes through the SafetyLimiter like a real layer.
`window.__limiter = { engagedCount, lastInfo, frames, webgl2, renderer, passes, status() }`.

## Tests

```
cd frontend && npx vitest run tests/pipeline.test.ts tests/safetyLimiter.test.ts
uv run pytest backend/tests/test_flashcheck.py -q
# e2e against the back end (playwright.config.ts) or the Vite dev server:
cd frontend && npx vite --port 5173 &   # if no back end
cd frontend && E2E_BASE_URL=http://127.0.0.1:5173 NODE_PATH=$PWD/node_modules npx playwright test safety-limiter
```
