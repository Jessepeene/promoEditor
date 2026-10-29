// WebGL2 real-time compositor for the Beat Card sequence.

import type { Session } from '../types/session';
import { Rng } from '../lib/rng';
import { bounceScale } from '../lib/timing';
import { activeCells, buildPlan, slotAt, XFADE_FRAMES, type Plan, type PlannedCell, type PlannedSlot } from './plan';
import { POST_FS, QUAD_FS, QUAD_VS } from './shaders';
import { VideoPool } from './VideoPool';

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export interface RenderStats {
  slotIndex: number | null;
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
  private pool: VideoPool;
  private plan: Plan | null = null;
  private planFor: Session | null = null;
  private overlay: { url: string; tex: WebGLTexture; w: number; h: number } | null = null;
  private overlayLoading: string | null = null;
  private glitchCache = new Map<string, Float32Array>();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.quad = program(gl, QUAD_VS, QUAD_FS);
    this.post = program(gl, QUAD_VS, POST_FS);
    this.qu = uniforms(gl, this.quad, ['uRect', 'uUv', 'uTex', 'uAlpha']);
    this.pu = uniforms(gl, this.post, ['uRect', 'uUv', 'uSceneA', 'uSceneB', 'uMix', 'uRes', 'uRgbPx', 'uBlurPx',
      'uBands', 'uFlash', 'uVhs', 'uLinePx', 'uTime']);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.quad, this.post]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.pool = new VideoPool(gl);
    this.allocTargets();
  }

  resize(w: number, h: number) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.allocTargets();
  }

  private allocTargets() {
    const gl = this.gl;
    for (const t of [this.a, this.b]) {
      if (t) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
    }
    const make = (): Target => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      setTexParams(gl, gl.LINEAR);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, tex };
    };
    this.a = make();
    this.b = make();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Draw the promo at `frame` (fractional promo frame, beat 0 = frame 0).
   * While `playing`, videos run at their ramped rates and are drift-corrected;
   * when paused they are seeked exactly (scrubbing).
   */
  render(session: Session, frame: number, playing: boolean): RenderStats {
    const gl = this.gl;
    if (this.planFor !== session) {
      this.plan = buildPlan(session);
      this.planFor = session;
    }
    const plan = this.plan!;
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

    // Post pass to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.post);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.b.tex);
    gl.uniform1i(this.pu.uSceneA, 0);
    gl.uniform1i(this.pu.uSceneB, 1);
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
    gl.uniform1f(this.pu.uVhs, style.vhs_glitch ? 1 : 0);
    gl.uniform1f(this.pu.uLinePx, Math.max(2, 4 * sy));
    gl.uniform1f(this.pu.uTime, frame / fps);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.drawOverlay(session, frame / fps);
    return { slotIndex: cur?.index ?? null, activeVideos: this.pool.size, waiting: this.pool.waiting };
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
    const bounce = session.sequence.style.bounce && ps.slot.fx.bounce;
    for (const pc of cells) {
      const entry = this.pool.texture(pc.key);
      if (!entry) continue;
      const [x, y, w, h] = pc.rect;
      // Clip space, y up: region top edge y maps to 1 - 2y/H.
      gl.uniform4f(this.qu.uRect, (2 * x) / W - 1, 1 - (2 * (y + h)) / H, (2 * w) / W, (2 * h) / H);
      const t = (frame - pc.timing.startFrame) / session.fps;
      const zoom = bounce ? bounceScale(t) : 1;
      gl.uniform4fv(this.qu.uUv, coverUv(entry.width, entry.height, w, h, pc.clip.focus_xy, zoom));
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

  private drawOverlay(session: Session, t: number) {
    const ov = session.sequence.style.overlay;
    if (!ov.path) return;
    const url = `/media?path=${encodeURIComponent(ov.path)}`;
    if (this.overlay?.url !== url) {
      this.loadOverlay(url);
      if (!this.overlay || this.overlay.url !== url) return;
    }
    const gl = this.gl;
    const { tex, w: iw, h: ih } = this.overlay;
    const [W, H] = session.resolution;
    const ow = Math.max(2, Math.floor((W * ov.width_frac) / 2) * 2);
    const oh = (ow * ih) / iw;
    let x = (W - ow) / 2;
    let y = (H - oh) / 2;
    if (ov.motion === 'JITTER') {
      // Same expression as the export overlay filter.
      x += 3 * Math.sin(2 * Math.PI * t * 7.3) + 2 * Math.sin(2 * Math.PI * t * 13.1);
      y += 2 * Math.sin(2 * Math.PI * t * 5.9) + 2 * Math.sin(2 * Math.PI * t * 11.7);
    }
    gl.useProgram(this.quad);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(this.qu.uRect, (2 * x) / W - 1, 1 - (2 * (y + oh)) / H, (2 * ow) / W, (2 * oh) / H);
    gl.uniform4f(this.qu.uUv, 0, 0, 1, 1);
    gl.uniform1f(this.qu.uAlpha, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  private loadOverlay(url: string) {
    if (this.overlayLoading === url) return;
    this.overlayLoading = url;
    const img = new Image();
    img.onload = () => {
      if (this.overlayLoading !== url) return;
      const gl = this.gl;
      if (this.overlay) gl.deleteTexture(this.overlay.tex);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      setTexParams(gl, gl.LINEAR);
      this.overlay = { url, tex, w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
    };
    img.src = url;
  }

  dispose() {
    this.pool.dispose();
    const gl = this.gl;
    for (const t of [this.a, this.b]) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    if (this.overlay) gl.deleteTexture(this.overlay.tex);
    gl.deleteProgram(this.quad);
    gl.deleteProgram(this.post);
  }
}

/**
 * UV window (u0, v0, u1, v1; v up) that cover-fits a (vw x vh) source into a (rw x rh)
 * region centred on `focus`, then zooms by `zoom` about that centre — the same
 * geometry as the export's scale/crop/zoompan chain.
 */
export function coverUv(vw: number, vh: number, rw: number, rh: number, focus: [number, number], zoom: number): Float32Array {
  const va = vw / vh;
  const ra = rw / rh;
  let uw = 1;
  let uh = 1;
  if (va > ra) uw = ra / va;
  else uh = va / ra;
  const cx = Math.min(Math.max(focus[0], uw / 2), 1 - uw / 2);
  const cyTop = Math.min(Math.max(focus[1], uh / 2), 1 - uh / 2);
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

function setTexParams(gl: WebGL2RenderingContext, filter: number) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
}

export { setTexParams };
