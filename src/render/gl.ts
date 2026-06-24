// WebGL2 renderer on the transferred OffscreenCanvas (present worker). TWO present paths share one
// context (a canvas has exactly one WebGL context for life), one quad VBO, and the `p`-at-location-0
// attribute:
//   - SOFTWARE tier (TRUE zero-copy): three INTEGER planes uploaded STRAIGHT from the decoder's
//     held AVFrame — Y full-res, U/V chroma-res — at their NATIVE byte stride (UNPACK_ROW_LENGTH) and
//     NATIVE bit depth (R8UI for 8-bit, R16UI for 10/12-bit). The shader de-strides for free (the row
//     length), bit-scales for free (a `bitScale` uniform → 255/1023/4095), and does BT.709 YUV→RGB +
//     manual chroma bilinear. No CPU de-stride, no 10→8 downshift, no JS copy — the GPU does it all.
//   - WEBCODECS tier: one RGBA texture uploaded straight from a `VideoFrame` (texImage2D accepts a
//     VideoFrame as a TexImageSource) → a passthrough shader. Caller CLOSES the VideoFrame after.
// Both tiers feed the SAME present ring/clock; only which draw method runs per frame differs.
//
// Why integer textures (R8UI/R16UI) and not normalized (R8/R16): R16 needs the EXT_texture_norm16
// extension (not universal), whereas R8UI/R16UI are CORE WebGL2 — so a strided 10-bit plane uploads
// directly everywhere. The catch is integer textures are NEAREST-only (no hardware linear filtering),
// so chroma (half-res → upsampled) is bilinear-filtered manually in the shader; luma maps 1:1 (the
// canvas is sized to the luma resolution), so nearest is already exact for it.

import { selectColorConditioning, hdrMode, bayer8, BAYER_8 } from './color';

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;

// Integer-texture YUV→RGB. `bitScale` = (1<<bitDepth)-1 normalizes the raw integer sample to [0,1]
// (8/10/12-bit share this one program). Chroma is bilinear-fetched (integer textures are NEAREST-only).
//
// COLOUR-CONDITIONING: the YUV→RGB matrix + range are NO LONGER hard-coded BT.709-limited — they arrive as
// CPU-baked uniforms (`yRange` = luma scale/offset, `cc` = the four chroma coefficients) selected per stream
// from `matrix_coefficients` + `color_range` (src/render/color.ts). DITHER: the 10→8-bit write is ordered
// (Bayer-8×8) dithered — `ditherT` is an 8×8 R8UI matrix (values 0…63), and we apply mpv's exact formula
// `floor(color*255 + (M+0.5)/64) / 255` to break up the gradient banding plain truncation leaves on 10-bit.
const FRAG_YUV = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv; out vec4 o;
uniform highp usampler2D yT, uT, vT;
uniform highp usampler2D ditherT;   // 8×8 Bayer matrix (R8UI, values 0…63)
uniform float bitScale;
uniform vec2  yRange;               // .x = luma scale (255/219 limited, 1 full), .y = luma black offset
uniform vec4  cc;                   // chroma coeffs: x=R·v, y=G·u, z=G·v, w=B·u (range chroma-scale baked in)
uniform int   hdrMode;              // 0=SDR, 1=PQ, 2=HLG — HDR (PQ/HLG, BT.2020) → SDR (BT.709) tone-map

// ---- HDR → SDR tone-mapping. Best-practice pipeline grounded in ffmpeg vf_tonemap + mpv: linearize →
// NORMALISE so the diffuse reference white (203 cd/m², BT.2408) lands at display white 1.0 → LUMINANCE-based
// Hable tone-map (scale RGB by the ratio → hue preserved, not per-channel) → BT.2020→709 gamut → sRGB OETF.
// TUNING (if too dark/bright): raise HDR_EXPOSURE; PQ_PEAK_NITS sets the highlight roll-off ceiling.
const float REF_WHITE_NITS = 203.0;   // BT.2408 HDR diffuse-white reference
const float PQ_PEAK_NITS   = 1000.0;  // assumed PQ mastering peak (highlight roll-off ceiling)
const float HLG_WHITE_LIN  = 0.26496; // HLG scene-linear at the 75%-signal reference white
const float HDR_EXPOSURE   = 1.0;     // global brightness multiplier (raise → brighter)
const vec3  LUMA2020 = vec3(0.2627, 0.6780, 0.0593); // BT.2020 luma coefficients
const mat3  BT2020_TO_709 = mat3(     // BT.2020 → BT.709 gamut, LINEAR RGB (GLSL mat3 is column-major; M*v)
   1.660491, -0.124550, -0.018154,
  -0.587641,  1.132900, -0.100597,
  -0.072850, -0.008349,  1.118751);
vec3 pqEotf(vec3 e){                   // SMPTE ST 2084 inverse EOTF: signal [0,1] → linear, 1.0 = 10000 cd/m²
  const float m1=0.1593017578125, m2=78.84375, c1=0.8359375, c2=18.8515625, c3=18.6875;
  vec3 ep = pow(max(e, 0.0), vec3(1.0/m2));
  return pow(max(ep - c1, 0.0) / (c2 - c3*ep), vec3(1.0/m1));
}
vec3 hlgEotf(vec3 e){                   // HLG inverse OETF: signal [0,1] → scene linear [0,1]
  const float a=0.17883277, b=0.28466892, c=0.55991073;
  vec3 lo = e*e/3.0;
  vec3 hi = (exp((e - c)/a) + b)/12.0;
  return mix(lo, hi, step(0.5, e));
}
float hableF(float x){                  // Hable (Uncharted-2) filmic curve, applied to LUMINANCE
  const float A=0.15, B=0.50, C=0.10, D=0.20, E=0.02, F=0.30;
  return ((x*(A*x + C*B) + D*E) / (x*(A*x + B) + D*F)) - E/F;
}
vec3 tonemapHdr(vec3 rgb, int mode){    // PQ/HLG BT.2020 signal → SDR BT.709 display signal
  vec3 lin; float peak;
  if (mode == 1){                       // PQ: absolute cd/m² → relative to the 203-nit reference white
    lin  = pqEotf(rgb) * (10000.0 / REF_WHITE_NITS);
    peak = PQ_PEAK_NITS / REF_WHITE_NITS;
  } else {                              // HLG: scene-linear → relative to the reference-white scene level
    lin  = hlgEotf(rgb) * (1.0 / HLG_WHITE_LIN);
    peak = 1.0 / HLG_WHITE_LIN;
  }
  lin *= HDR_EXPOSURE;
  float l  = max(dot(lin, LUMA2020), 1e-6); // luminance-based: map the luma, scale RGB by the ratio
  float tl = hableF(l) / hableF(peak);
  lin *= tl / l;
  lin = clamp(BT2020_TO_709 * lin, 0.0, 1.0);
  return pow(lin, vec3(1.0/2.2));        // sRGB-ish display OETF (matches the browser canvas + the SDR path)
}

// Manual bilinear fetch of a chroma plane (integer texture → no HW linear) at uv, normalized to [0,1).
float chroma(highp usampler2D t, vec2 p){
  vec2 sz = vec2(textureSize(t, 0));
  vec2 c  = p * sz - 0.5;
  vec2 fl = floor(c);
  vec2 fr = c - fl;
  ivec2 b  = ivec2(fl);
  ivec2 mx = ivec2(sz) - 1;
  float s00 = float(texelFetch(t, clamp(b,             ivec2(0), mx), 0).r);
  float s10 = float(texelFetch(t, clamp(b+ivec2(1,0),  ivec2(0), mx), 0).r);
  float s01 = float(texelFetch(t, clamp(b+ivec2(0,1),  ivec2(0), mx), 0).r);
  float s11 = float(texelFetch(t, clamp(b+ivec2(1,1),  ivec2(0), mx), 0).r);
  return mix(mix(s00, s10, fr.x), mix(s01, s11, fr.x), fr.y) / bitScale;
}
void main(){
  float y = float(texture(yT, uv).r) / bitScale; // luma 1:1 (canvas == luma res) → nearest is exact
  float u = chroma(uT, uv) - 0.5;
  float v = chroma(vT, uv) - 0.5;
  // Conditioned YUV→RGB (matrix family + limited/full range chosen on the CPU → uniforms).
  y = (y - yRange.y) * yRange.x;
  float r = y + cc.x*v;
  float g = y + cc.y*u + cc.z*v;
  float b = y + cc.w*u;
  vec3 rgb = vec3(r, g, b);
  if (hdrMode > 0) rgb = tonemapHdr(rgb, hdrMode);   // SDR passthrough when hdrMode==0
  // Ordered (Bayer-8×8) dither at the final 8-bit write — perturbs sub-LSB only (a near-no-op for 8-bit
  // content), kills 10-bit gradient banding. dval = (M+0.5)/64 ∈ (0,1); floor(color*255 + dval)/255.
  ivec2 dc = ivec2(int(gl_FragCoord.x) & 7, int(gl_FragCoord.y) & 7);
  float dval = (float(texelFetch(ditherT, dc, 0).r) + 0.5) / 64.0;
  vec3 c = floor(rgb * 255.0 + dval) / 255.0;
  o = vec4(c, 1.0);
}`;

const FRAG_RGB = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D srcT;
void main(){ o = vec4(texture(srcT, uv).rgb, 1.0); }`;

export class GlRenderer {
  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[] = [];   // 0,1,2 = Y,U,V (software, integer); 3 = RGBA (webcodecs); 4 = Bayer dither (R8UI)
  private progYuv: WebGLProgram | null = null;
  private progRgb: WebGLProgram | null = null;
  private bitScaleLoc: WebGLUniformLocation | null = null;
  private yRangeLoc: WebGLUniformLocation | null = null;
  private ccLoc: WebGLUniformLocation | null = null;
  private hdrModeLoc: WebGLUniformLocation | null = null;
  private vbo: WebGLBuffer | null = null;
  private w = 0;
  private h = 0;
  private cw = 0;
  private ch = 0;
  private bitDepth = 0;               // current software texture bit depth (8/10/12); 0 ⇒ none yet
  private cs = -1;                    // last-applied colorspace (AVColorSpace) — re-resolve uniforms on change
  private cr = -1;                    // last-applied color_range (AVColorRange)
  private trc = -1;                   // last-applied transfer characteristic (drives the HDR tone-map mode)
  private canvas: HTMLCanvasElement | OffscreenCanvas;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('ferrite: WebGL2 unavailable in worker');
    this.gl = gl;
    // Bind `p` to attribute location 0 for BOTH programs so the single VBO/attrib setup serves both.
    this.progYuv = this.link(VERT, FRAG_YUV);
    this.progRgb = this.link(VERT, FRAG_RGB);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vbo = gl.createBuffer();
    this.vbo = vbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (let i = 0; i < 5; i++) {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      // Units 0,1,2 (Y/U/V) + 4 (Bayer dither) are INTEGER textures → NEAREST-only (linear filtering on an
      // integer texture makes it incomplete). Unit 3 (RGBA WebCodecs) keeps LINEAR. Chroma upsampling is
      // done manually (bilinear) in FRAG_YUV; luma + dither are point-sampled (texelFetch), so nearest fits.
      const filter = i === 3 ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.push(t);
    }
    // Upload the 8×8 Bayer dither matrix ONCE (unit 4, R8UI 8×8, values 0…63). Static for the renderer's
    // life — the shader indexes it by gl_FragCoord & 7 (texelFetch, no wrap needed).
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.activeTexture(gl.TEXTURE0 + 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[4]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, BAYER_8, BAYER_8, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, bayer8());

    gl.useProgram(this.progYuv);
    gl.uniform1i(gl.getUniformLocation(this.progYuv, 'yT'), 0);
    gl.uniform1i(gl.getUniformLocation(this.progYuv, 'uT'), 1);
    gl.uniform1i(gl.getUniformLocation(this.progYuv, 'vT'), 2);
    gl.uniform1i(gl.getUniformLocation(this.progYuv, 'ditherT'), 4);
    this.bitScaleLoc = gl.getUniformLocation(this.progYuv, 'bitScale');
    this.yRangeLoc = gl.getUniformLocation(this.progYuv, 'yRange');
    this.ccLoc = gl.getUniformLocation(this.progYuv, 'cc');
    this.hdrModeLoc = gl.getUniformLocation(this.progYuv, 'hdrMode');
    gl.uniform1i(this.hdrModeLoc, 0); // SDR default until a frame's transfer characteristic resolves
    gl.useProgram(this.progRgb);
    gl.uniform1i(gl.getUniformLocation(this.progRgb, 'srcT'), 3);
    // Tight rows: the per-plane stride is given explicitly via UNPACK_ROW_LENGTH (in samples), so
    // alignment must be 1 (no extra row padding) for both R8UI and R16UI.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Release GL resources but KEEP the context reusable. A <canvas> has exactly one WebGL context
   *  for its lifetime (getContext returns the same object every call), so a reused canvas (Stop→Play
   *  on the same element) must keep its context alive — force-losing it via WEBGL_lose_context here
   *  permanently breaks the canvas ("sad square") and the next getContext returns the dead context →
   *  restart renders nothing. We free the textures/buffers/programs (no GPU-memory accumulation across
   *  plays); the single context is reused by the next GlRenderer on the same canvas. NOTE for hosts: if
   *  a host mounts a FRESH canvas per channel, the abandoned canvas's context is reclaimed on
   *  element GC — handle explicit release there, not here (here it must stay reusable). */
  dispose(): void {
    const gl = this.gl;
    for (const t of this.tex) gl.deleteTexture(t);
    this.tex = [];
    if (this.vbo) { gl.deleteBuffer(this.vbo); this.vbo = null; }
    if (this.progYuv) { gl.deleteProgram(this.progYuv); this.progYuv = null; }
    if (this.progRgb) { gl.deleteProgram(this.progRgb); this.progRgb = null; }
  }

  /** SOFTWARE tier (zero-copy): upload one frame's three INTEGER planes STRAIGHT from the live heap
   *  (de-strided via UNPACK_ROW_LENGTH = the plane's samples-per-row) and draw. `y`/`u`/`v` are Uint8Array
   *  (8-bit → R8UI) or Uint16Array (10/12-bit → R16UI) views; `yRow`/`uRow`/`vRow` are their strides in
   *  SAMPLES. Reallocs the textures on a size OR bit-depth change (the internal format then differs). */
  draw(
    y: ArrayBufferView, yRow: number,
    u: ArrayBufferView, uRow: number,
    v: ArrayBufferView, vRow: number,
    w: number, h: number, cw: number, ch: number, bitDepth: number,
    colorspace = 2 /* AVCOL_SPC_UNSPECIFIED */, colorRange = 0 /* AVCOL_RANGE_UNSPECIFIED */,
    colorTrc = 2 /* AVCOL_TRC_UNSPECIFIED */,
  ): void {
    const gl = this.gl;
    const bd16 = bitDepth > 8;
    const ifmt = bd16 ? gl.R16UI : gl.R8UI;
    const type = bd16 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
    const resize = w !== this.w || h !== this.h || cw !== this.cw || ch !== this.ch || bitDepth !== this.bitDepth;
    if (resize) {
      this.w = w; this.h = h; this.cw = cw; this.ch = ch; this.bitDepth = bitDepth;
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.useProgram(this.progYuv);
    gl.uniform1f(this.bitScaleLoc, (1 << bitDepth) - 1); // 255 / 1023 / 4095
    // Re-resolve the YUV→RGB matrix + range uniforms only when the stream's colour metadata (or the dims
    // that drive the unspecified-fallback) changes — pure arithmetic, but no need to recompute per frame.
    if (colorspace !== this.cs || colorRange !== this.cr || resize) {
      this.cs = colorspace; this.cr = colorRange;
      const c = selectColorConditioning(colorspace, colorRange, w, h);
      gl.uniform2f(this.yRangeLoc, c.yScale, c.yOffset);
      gl.uniform4f(this.ccLoc, c.cRv, c.cGu, c.cGv, c.cBu);
    }
    // HDR tone-map mode (PQ/HLG → SDR BT.709) — re-resolve only on a transfer-characteristic change.
    if (colorTrc !== this.trc) {
      this.trc = colorTrc;
      gl.uniform1i(this.hdrModeLoc, hdrMode(colorTrc));
    }
    this.upload(0, y, w, h, yRow, ifmt, type, resize);
    this.upload(1, u, cw, ch, uRow, ifmt, type, resize);
    this.upload(2, v, cw, ch, vRow, ifmt, type, resize);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** WEBCODECS tier: upload a VideoFrame to the RGBA texture (unit 3) and draw via the passthrough
   *  program. The caller owns the VideoFrame and MUST `.close()` it after (frees the decoder pool).
   *  Sizes the canvas to the frame's display dims (self-correcting on a mid-stream resolution change). */
  drawFrame(frame: VideoFrame): void {
    const gl = this.gl;
    const w = frame.displayWidth, h = frame.displayHeight;
    if (w !== this.w || h !== this.h) {
      // Reset chroma dims + bit depth too so a later software frame of the SAME luma size still re-uploads.
      // Also invalidate the colour-conditioning cache (cs/cr) — a returning software frame MUST re-set the
      // YUV→RGB uniforms even if its metadata matches the pre-WC stream (don't rely on the resize branch).
      this.w = w; this.h = h; this.cw = 0; this.ch = 0; this.bitDepth = 0; this.cs = -1; this.cr = -1; this.trc = -1;
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.useProgram(this.progRgb);
    gl.activeTexture(gl.TEXTURE0 + 3);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[3]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Upload one strided integer plane. `rowSamples` (UNPACK_ROW_LENGTH) lets us read the decoder's
   *  native stride directly; reset to 0 after so the WebCodecs path (and any later default upload) is
   *  unaffected. `alloc` (size/bit-depth change) → texImage2D (the integer format may differ); else
   *  texSubImage2D into the existing storage. */
  private upload(
    unit: number, data: ArrayBufferView, w: number, h: number,
    rowSamples: number, internalFmt: number, type: number, alloc: boolean,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowSamples);
    if (alloc) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, gl.RED_INTEGER, type, data as ArrayBufferView);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, type, data as ArrayBufferView);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const c = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    const vsh = c(gl.VERTEX_SHADER, vs);
    const fsh = c(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, vsh);
    gl.attachShader(p, fsh);
    gl.bindAttribLocation(p, 0, 'p'); // pin `p` to location 0 (shared VBO/attrib for both programs)
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    gl.deleteShader(vsh); // detached + flagged for delete once the program no longer needs them
    gl.deleteShader(fsh);
    return p;
  }
}
