// Quad shader: places a textured rect (clip-space) sampling a UV window of the source.
export const QUAD_VS = `#version 300 es
in vec2 aPos;           // unit quad 0..1
uniform vec4 uRect;     // x, y, w, h in clip space (y up)
uniform vec4 uUv;       // u0, v0, u1, v1
out vec2 vUv;
void main() {
  vUv = mix(uUv.xy, uUv.zw, aPos);
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}`;

export const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb, c.a) * uAlpha;
}`;

// Full-frame post pass, in the export's order:
//   crossfade mix · mirror · band glitch · vertical blur · RGB split · white flash ·
//   dim · invert · strobe · echo (lagfun) · then the global VHS layer.
// Output 0 is the final colour; output 1 is the pre-VHS colour, fed back next frame for echo.
export const POST_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform sampler2D uPrev;     // previous frame's pre-VHS colour (echo feedback)
uniform float uMix;          // weight of B (the outgoing slot) during a crossfade; 0 = A only
uniform vec2 uRes;           // canvas size, px
uniform float uMirror;       // 0/1: left half mirrored onto the right
uniform float uRgbPx;        // horizontal R/B offset, px
uniform float uBlurPx;       // vertical blur sigma, px
uniform vec4 uBands[3];      // glitch bands: y0, y1 (uv), dx (uv), active
uniform float uFlash;        // 0..1 white
uniform float uDim;          // colour multiplier (1 = off)
uniform float uInvert;       // 0/1
uniform float uBlack;        // 0/1: strobe frame
uniform float uEcho;         // lagfun decay; 0 = off
uniform float uVhs;          // 0/1
uniform float uLinePx;       // scanline period, px
uniform float uTime;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outPre;

vec3 sceneAt(vec2 uv) {
  vec3 a = texture(uSceneA, uv).rgb;
  if (uMix > 0.0) a = mix(a, texture(uSceneB, uv).rgb, uMix);
  return a;
}

vec3 blurred(vec2 uv) {
  if (uBlurPx < 0.5) return sceneAt(uv);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float o = float(i) * uBlurPx / 2.5;
    float w = exp(-0.5 * pow(o / uBlurPx, 2.0));
    acc += sceneAt(uv + vec2(0.0, o / uRes.y)) * w;
    wsum += w;
  }
  return acc / wsum;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  if (uMirror > 0.5 && uv.x > 0.5) uv.x = 1.0 - uv.x;
  for (int i = 0; i < 3; i++) {
    vec4 b = uBands[i];
    if (b.w > 0.5 && uv.y >= b.x && uv.y < b.y) uv.x -= b.z;
  }
  vec3 c;
  if (uRgbPx > 0.0) {
    float o = uRgbPx / uRes.x;
    c = vec3(blurred(uv + vec2(o, 0.0)).r, blurred(uv).g, blurred(uv - vec2(o, 0.0)).b);
  } else {
    c = blurred(uv);
  }
  c = mix(c, vec3(1.0), uFlash);
  c *= uDim;
  if (uInvert > 0.5) c = 1.0 - c;
  if (uBlack > 0.5) c = vec3(0.0);
  if (uEcho > 0.0) c = max(c, texture(uPrev, vUv).rgb * uEcho);
  outPre = vec4(c, 1.0);
  if (uVhs > 0.5) {
    float y = gl_FragCoord.y;
    float line = step(mod(y, uLinePx), max(uLinePx * 0.25, 0.5));
    c *= 1.0 - 0.22 * line;
    c += (hash(gl_FragCoord.xy + fract(uTime * 61.0) * 100.0) - 0.5) * (14.0 / 255.0);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.12);
    c = (c - 0.5) * 1.04 + 0.5;
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
