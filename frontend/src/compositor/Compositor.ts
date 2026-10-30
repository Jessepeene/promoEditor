// WebGL2 real-time compositor for the Beat Card sequence.

import type { Session } from '../types/session';
import { drawGraphicsFrame, ensureFonts, graphicsFrameKey, loadLogoImages, textLook } from '../lib/graphicsLayer';
import { Rng } from '../lib/rng';
import { cellZoom, DIM_LEVEL, ECHO_DECAY, INVERT_FRAMES, shakeOffset, strobeBlack } from '../lib/timing';
import { activeCells, buildPlan, slotAt, XFADE_FRAMES, type Plan, type PlannedCell, type PlannedSlot } from './plan';
import { POST_FS, QUAD_FS, QUAD_VS } from './shaders';
import { VideoPool } from './VideoPool';

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export interface RenderStats {
  slotId: string | null;
  activeVideos: number;
  waiting: number;
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private quad: WebGLProgram;
  private post: WebGLProgram;
  private qu: Uniforms;
  private pu: Uniforms;
  private vao: WebGLVertexArrayObject;
  private a!: Target;
  private b!: Target;
  /** Post pass target (final colour) and the two echo buffers it ping-pongs between. */
  private postTarget!: Target;
  private echo!: [WebGLTexture, WebGLTexture];
  private echoIndex = 0;
  private pool: VideoPool;
  private plan: Plan | null = null;
  private planFor: Session | null = null;
  private gfx: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: WebGLTexture; key: string | null };
  private fontsReady = false;
  private logoImages = new Map<string, HTMLImageElement>();
  private logoLoading = new Set<string>();
  private glitchCache = new Map<string, Float32Array>();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.quad = program(gl, QUAD_VS, QUAD_FS);
    this.post = program(gl, QUAD_VS, POST_FS);
    this.qu = uniforms(gl, this.quad, ['uRect', 'uUv', 'uTex', 'uAlpha']);
    this.pu = uniforms(gl, this.post, ['uRect', 'uUv', 'uSceneA', 'uSceneB', 'uPrev', 'uMix', 'uRes', 'uMirror', 'uRgbPx',
      'uBlurPx', 'uBands', 'uFlash', 'uDim', 'uInvert', 'uBlack', 'uEcho', 'uVhs', 'uLinePx', 'uTime']);
    this.vao = created(gl.createVertexArray(), 'vertex array');
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.quad, this.post]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.pool = new VideoPool(gl);
    this.allocTargets();
    const canvas2d = document.createElement('canvas');
    const ctx = canvas2d.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.gfx = { canvas: canvas2d, ctx, tex: created(gl.createTexture(), 'texture'), key: null };
    void ensureFonts().then(() => {
      this.fontsReady = true;
      this.gfx.key = null; // repaint with the real fonts
    });
  }

  resize(w: number, h: number) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.allocTargets();
  }

  private allocTargets() {
    const gl = this.gl;
    for (const t of [this.a, this.b, this.postTarget]) {
      if (t) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
    }
    if (this.echo) this.echo.forEach((t) => gl.deleteTexture(t));
    const tex = () => {
      const t = created(gl.createTexture(), 'texture');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      setTexParams(gl, gl.LINEAR);
      return t;
    };
    const make = (): Target => {
      const t = tex();
      const fbo = created(gl.createFramebuffer(), 'framebuffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { fbo, tex: t };
    };
    this.a = make();
    this.b = make();
    this.postTarget = make();
    this.echo = [tex(), tex()];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Draw the promo at `frame` (fractional promo frame, beat 0 = frame 0).
   * While `playing`, videos run at their ramped rates and are drift-corrected;
   * when paused they are seeked exactly (scrubbing).
   */
  render(session: Session, frame: number, playing: boolean): RenderStats {
    const gl = this.gl;
    let plan = this.plan;
    if (!plan || this.planFor !== session) {
      plan = this.plan = buildPlan(session);
      this.gfx.key = null; // text / logo settings may have changed
      this.planFor = session;
    }
    const fps = session.fps;
    const style = session.sequence.style;
    const f = Math.floor(frame);
    const cur = slotAt(plan, f);

    // Crossfade: the outgoing slot keeps running for XFADE_FRAMES under the new one.
    let prev: PlannedSlot | null = null;
    let mixB = 0;
    if (cur && cur.slot.fx.transition === 'CROSSFADE' && f - cur.startFrame < XFADE_FRAMES && cur.index > 0) {
      const p = plan.slots[cur.index - 1];
      if (p.endFrame === cur.startFrame && p.endFrame - p.startFrame > XFADE_FRAMES) {
        prev = p;
        mixB = 1 - (frame - cur.startFrame) / XFADE_FRAMES;
      }
    }

    const visible = cur ? activeCells(cur, f) : [];
    const visiblePrev = prev ? activeCells(prev, f, true) : [];
    this.pool.sync(plan, [...visible, ...visiblePrev], frame, fps, playing);

    this.drawScene(this.a, visible, frame, session, cur);
    if (prev) this.drawScene(this.b, visiblePrev, frame, session, prev);

    // Post pass into postTarget (final) + the next echo buffer (pre-VHS), reading the last one.
    const [prevEcho, nextEcho] = [this.echo[this.echoIndex], this.echo[1 - this.echoIndex]];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.postTarget.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, nextEcho, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.post);
    gl.bindVertexArray(this.vao);
    for (const [unit, t] of [this.a.tex, this.b.tex, prevEcho].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    }
    gl.uniform1i(this.pu.uSceneA, 0);
    gl.uniform1i(this.pu.uSceneB, 1);
    gl.uniform1i(this.pu.uPrev, 2);
    gl.uniform4f(this.pu.uRect, -1, -1, 2, 2);
    gl.uniform4f(this.pu.uUv, 0, 0, 1, 1);
    gl.uniform1f(this.pu.uMix, Math.max(0, Math.min(1, mixB)));
    gl.uniform2f(this.pu.uRes, this.canvas.width, this.canvas.height);

    const [W, H] = session.resolution;
    const sx = this.canvas.width / W;
    const sy = this.canvas.height / H;
    const local = cur ? f - cur.startFrame : 1e9;
    const fx = cur?.slot.fx;
    // Same windows as compiler._post_fx (frame counts from the slot start).
    const rgbBase = Math.max(1, Math.round((12 * W) / 1080)) * sx;
    const rgb = style.rgb_split && fx?.rgb_split ? (local < 4 ? rgbBase : local < 8 ? Math.floor(rgbBase / 2) : 0) : 0;
    const blur = style.bounce && fx?.bounce ? (local < 2 ? 9 * sy : local < 4 ? 4 * sy : 0) : 0;
    gl.uniform1f(this.pu.uMirror, fx?.mirror ? 1 : 0);
    gl.uniform1f(this.pu.uRgbPx, rgb);
    gl.uniform1f(this.pu.uBlurPx, blur);
    const bands = style.vhs_glitch && fx?.glitch && cur && local < Math.min(5, cur.endFrame - cur.startFrame)
      ? this.glitchBands(session, cur)
      : new Float32Array(12);
    gl.uniform4fv(this.pu.uBands, bands);
    let flash = 0;
    if (cur && fx?.transition === 'FLASH') {
      const d = Math.min(0.12, (cur.endFrame - cur.startFrame) / fps / 2);
      flash = Math.max(0, 1 - (frame - cur.startFrame) / fps / d);
    }
    gl.uniform1f(this.pu.uFlash, flash);
    gl.uniform1f(this.pu.uDim, fx?.dim ? DIM_LEVEL : 1);
    gl.uniform1f(this.pu.uInvert, fx?.invert && local < INVERT_FRAMES ? 1 : 0);
    gl.uniform1f(this.pu.uBlack, fx?.strobe && strobeBlack(local) ? 1 : 0);
    // lagfun starts fresh at each slot: its first frame has no trail.
    gl.uniform1f(this.pu.uEcho, fx?.echo && local > 0 ? ECHO_DECAY : 0);
    gl.uniform1f(this.pu.uVhs, style.vhs_glitch ? 1 : 0);
    gl.uniform1f(this.pu.uLinePx, Math.max(2, 4 * sy));
    gl.uniform1f(this.pu.uTime, frame / fps);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this.echoIndex = 1 - this.echoIndex;

    // Final colour to the canvas, then the graphics layer on top.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.postTarget.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const { width: cw, height: ch } = this.canvas;
    gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.drawGraphics(session, plan, f);
    return { slotId: cur?.slot.slot_id ?? null, activeVideos: this.pool.size, waiting: this.pool.waiting };
  }

  private drawScene(target: Target, cells: PlannedCell[], frame: number, session: Session, ps: PlannedSlot | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!ps) return;
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.uniform1i(this.qu.uTex, 0);
    gl.uniform1f(this.qu.uAlpha, 1);
    const [W, H] = session.resolution;
    const fx = ps.slot.fx;
    const bounce = session.sequence.style.bounce && fx.bounce;
    for (const pc of cells) {
      const entry = this.pool.texture(pc.key);
      if (!entry) continue;
      const [x, y, w, h] = pc.rect;
      // Clip space, y up: region top edge y maps to 1 - 2y/H.
      gl.uniform4f(this.qu.uRect, (2 * x) / W - 1, 1 - (2 * (y + h)) / H, (2 * w) / W, (2 * h) / H);
      // Same motion as the export's zoompan (timing.cellZoom / shakeOffset).
      const t = (frame - pc.timing.startFrame) / session.fps;
      const dur = (pc.timing.endFrame - pc.timing.startFrame) / session.fps;
      const zoom = cellZoom(t, dur, bounce, fx.push, fx.shake);
      const offset = fx.shake ? shakeOffset(t) : ([0, 0] as [number, number]);
      gl.uniform4fv(this.qu.uUv, coverUv(entry.width, entry.height, w, h, pc.clip.focus_xy, zoom, offset));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private glitchBands(session: Session, ps: PlannedSlot): Float32Array {
    const key = `${session.sequence.seed}:${ps.slot.slot_id}`;
    let bands = this.glitchCache.get(key);
    if (!bands) {
      const rng = new Rng(hashString(key));
      bands = new Float32Array(12);
      for (let i = 0; i < 3; i++) {
        const h = 1 / 40 + rng.next() * (1 / 10 - 1 / 40);
        const y0 = rng.next() * (1 - h);
        const dx = (rng.chance(0.5) ? -1 : 1) * (1 / 30 + rng.next() * (1 / 8 - 1 / 30));
        bands.set([y0, y0 + h, dx, 1], i * 4);
      }
      this.glitchCache.set(key, bands);
    }
    return bands;
  }

  /** Text + logos: repainted on a 2D canvas only when the frame key changes. */
  private drawGraphics(session: Session, plan: Plan, f: number) {
    if (!this.fontsReady) return;
    const key = graphicsFrameKey(plan.graphics, f);
    if (!key) return;
    this.requestLogos(session);
    const gl = this.gl;
    const g = this.gfx;
    if (g.canvas.width !== this.canvas.width || g.canvas.height !== this.canvas.height) {
      g.canvas.width = this.canvas.width;
      g.canvas.height = this.canvas.height;
      g.key = null;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    if (key !== g.key) {
      const complete = drawGraphicsFrame(g.ctx, textLook(session.sequence), plan.graphics, f, g.canvas.width, g.canvas.height, this.logoImages);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      setTexParams(gl, gl.LINEAR);
      // A logo still loading means this frame must be repainted once it arrives.
      g.key = complete ? key : null;
    }
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(this.qu.uRect, -1, -1, 2, 2);
    gl.uniform4f(this.qu.uUv, 0, 0, 1, 1);
    gl.uniform1f(this.qu.uAlpha, 1);
    gl.uniform1i(this.qu.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  private requestLogos(session: Session) {
    const missing = session.sequence.style.logos.filter((l) => !this.logoImages.has(l.path) && !this.logoLoading.has(l.path));
    if (missing.length === 0) return;
    for (const l of missing) this.logoLoading.add(l.path);
    loadLogoImages(missing, this.logoImages)
      .catch((e: Error) => console.warn('logo failed to load', e))
      .finally(() => {
        for (const l of missing) this.logoLoading.delete(l.path);
        this.gfx.key = null;
      });
  }

  dispose() {
    this.pool.dispose();
    const gl = this.gl;
    for (const t of [this.a, this.b, this.postTarget]) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.echo.forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(this.gfx.tex);
    gl.deleteProgram(this.quad);
    gl.deleteProgram(this.post);
  }
}

/**
 * UV window (u0, v0, u1, v1; v up) that cover-fits a (vw x vh) source into a (rw x rh)
 * region centred on `focus`, zoomed by `zoom` about that centre and shifted by `offset`
 * (fractions of the region, y down) — the same geometry as the export's scale/crop/zoompan chain.
 */
export function coverUv(vw: number, vh: number, rw: number, rh: number, focus: [number, number], zoom: number,
  offset: [number, number] = [0, 0]): Float32Array {
  const va = vw / vh;
  const ra = rw / rh;
  let uw = 1;
  let uh = 1;
  if (va > ra) uw = ra / va;
  else uh = va / ra;
  const cx = Math.min(Math.max(focus[0], uw / 2), 1 - uw / 2) + offset[0] * uw;
  const cyTop = Math.min(Math.max(focus[1], uh / 2), 1 - uh / 2) + offset[1] * uh;
  uw /= zoom;
  uh /= zoom;
  const cy = 1 - cyTop; // texture v is flipped (UNPACK_FLIP_Y)
  return new Float32Array([cx - uw / 2, cy - uh / 2, cx + uw / 2, cy + uh / 2]);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** WebGL create* only return null when the context is lost. */
function created<T>(obj: T | null, what: string): T {
  if (obj === null) throw new Error(`WebGL could not create a ${what} (context lost?)`);
  return obj;
}

function setTexParams(gl: WebGL2RenderingContext, filter: number) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = created(gl.createShader(type), 'shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = created(gl.createProgram(), 'program');
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
}
