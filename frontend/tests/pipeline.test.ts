// PROTECTED (BUILD.md §0.7, §16.2 "Safety"): the render pipeline always ends with the SafetyLimiter.
import { describe, expect, it } from 'vitest';
import { RenderPipeline, type Layer, type PipelineOptions } from '../src/pipeline';
import { SafetyLimiter } from '../src/safety/safetyLimiter';

class MockRenderer {
  log: string[] = [];
  target: unknown = undefined;
  autoClear = true;
  setPixelRatio() { /* noop */ }
  setSize() { /* noop */ }
  setClearColor() { /* noop */ }
  clear() { this.log.push('clear'); }
  setRenderTarget(t: unknown) { this.target = t; }
  render() { this.log.push(this.target === null ? 'render:screen' : 'render:target'); }
  readRenderTargetPixels(_t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) {
    buf.fill(0, 0, w * h * 4); this.log.push('readback');
  }
  dispose() { /* noop */ }
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  return c;
}

function makeLayer(name: string, log: string[], opts: { throws?: boolean } = {}): Layer {
  return {
    name,
    init: () => log.push(`init:${name}`),
    resize: () => undefined,
    render: () => { log.push(`layer:${name}`); if (opts.throws) throw new Error('boom'); },
    dispose: () => undefined,
  };
}

function build(opts: Record<string, unknown>) {
  const r = new MockRenderer();
  const p = new RenderPipeline(makeCanvas(), { ...(opts as PipelineOptions), renderer: r as any });
  return { p, r };
}

const BANNED = /disable|bypass|skip|nolimit|unsafe/i;

describe('RenderPipeline structure', () => {
  for (const debug of [false, true]) {
    it(`ends with the SafetyLimiter pass (debug=${debug})`, () => {
      const { p, r } = build({ debug });
      expect(p.passes.at(-1)).toBe('SafetyLimiter');
      p.addLayer(makeLayer('room', r.log));
      p.addLayer(makeLayer('form_constants', r.log));
      expect(p.passes).toEqual(['room', 'form_constants', 'SafetyLimiter']);
      expect(p.limiter).toBeInstanceOf(SafetyLimiter);
      r.log.length = 0;
      p.render({});
      // layers render into the scene target; the very last draw goes to the screen via the limiter
      const firstLimiter = r.log.indexOf('readback');
      expect(r.log.indexOf('layer:room')).toBeLessThan(firstLimiter);
      expect(r.log.indexOf('layer:form_constants')).toBeLessThan(firstLimiter);
      expect(r.log.at(-1)).toBe('render:screen');
      expect(r.log.filter((x) => x === 'render:screen').length).toBe(1);
    });
  }

  it('still runs the limiter last when a layer throws', () => {
    const { p, r } = build({ debug: true });
    p.addLayer(makeLayer('broken', r.log, { throws: true }));
    r.log.length = 0;
    p.render({});
    expect(r.log.at(-1)).toBe('render:screen');
    expect(p.passes.at(-1)).toBe('SafetyLimiter');
  });

  it('ignores any attempt to switch the limiter off through options', () => {
    const { p, r } = build({
      debug: true, disableLimiter: true, bypassLimiter: true, skipLimiter: true, limiter: false, safety: false,
    });
    expect(p.passes.at(-1)).toBe('SafetyLimiter');
    p.render({});
    expect(r.log.at(-1)).toBe('render:screen');
    expect(r.log).toContain('readback');
  });

  it('passes is read-only and cannot drop the limiter', () => {
    const { p } = build({});
    const passes = p.passes as string[];
    expect(() => passes.pop()).toThrow();
    expect(p.passes.at(-1)).toBe('SafetyLimiter');
  });

  it('exposes no method or option to disable, bypass or skip the limiter', () => {
    for (const proto of [RenderPipeline.prototype, SafetyLimiter.prototype]) {
      for (const name of Object.getOwnPropertyNames(proto)) expect(BANNED.test(name)).toBe(false);
    }
    const { p } = build({ debug: true });
    for (const key of Object.keys(p)) expect(BANNED.test(key)).toBe(false);
    for (const key of Object.keys(p.limiter)) expect(BANNED.test(key)).toBe(false);
  });

  it('clamps the render scale to 0.5–1.0', () => {
    const { p } = build({});
    p.setRenderScale(0.1); expect(p.renderScale).toBe(0.5);
    p.setRenderScale(3); expect(p.renderScale).toBe(1);
    p.setRenderScale(0.75); expect(p.renderScale).toBe(0.75);
    expect(p.passes.at(-1)).toBe('SafetyLimiter');
  });
});
