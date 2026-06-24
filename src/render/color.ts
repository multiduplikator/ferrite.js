// RENDER-QUALITY — pure (DOM-free, headless-testable) colour math for the software-tier YUV→RGB present.
//
// TWO jobs, both pure arithmetic (DOM-free, headless-testable), feeding the software-tier presenter:
//   1. COLOUR-CONDITIONING: pick the YUV→RGB matrix (BT.601 / 709 / 2020 luma coefficients) and the range
//      branch (limited / full) from the stream's `matrix_coefficients` (AVColorSpace) + `color_range`
//      (AVColorRange), replacing the old unconditional BT.709-limited. This fixes crushed blacks on
//      full-range content, the hue shift of BT.709 applied to SD (601) content, and mis-weighted luma on
//      4K BT.2020. The result is a small set of shader uniforms (CPU-baked, exactly as mpv/VLC do it).
//   2. DITHER: the 8×8 ordered (Bayer) matrix the shader looks up to dither the 10→8-bit write (kills the
//      gradient banding plain truncation causes on 10-bit content). mpv's `--dither=ordered` matrix.
//
// HDR is OUT OF SCOPE: BT.2020 content now gets the correct *matrix* (luma coefficients), but NOT the
// PQ/HLG→SDR transfer/tonemap — so HDR (PQ) content may still look dark/washed on an SDR display. That is
// expected and deferred to a separate, larger feature; do not attempt tonemapping from these coefficients.

// AVColorSpace (matrix_coefficients) — the FFmpeg enum values the engine forwards (ffmpeg's pixfmt.h).
// Only the families we condition on are named; everything else routes to the resolution fallback.
export const AVColorSpace = {
  RGB: 0,
  BT709: 1,
  UNSPECIFIED: 2,
  FCC: 4,
  BT470BG: 5,    // BT.601 625 (PAL/SECAM)
  SMPTE170M: 6,  // BT.601 525 (NTSC SMPTE-C)
  SMPTE240M: 7,
  BT2020_NCL: 9,
  BT2020_CL: 10,
} as const;

// AVColorRange — limited (studio/MPEG) vs full (PC/JPEG) swing.
export const AVColorRange = {
  UNSPECIFIED: 0,
  MPEG: 1, // limited / studio (Y 16..235, C 16..240 for 8-bit)
  JPEG: 2, // full / PC (0..255)
} as const;

// AVColorTransferCharacteristic — the per-frame transfer (engine getter `ferrite_vdec_color_trc`). HDR =
// PQ (SMPTE ST 2084) / HLG (ARIB STD-B67); everything else is SDR (no tone-map). The HDR pipeline lives in
// the GL shader (EOTF → tone-map → BT.2020→709 gamut → BT.709 OETF), gated by `hdrMode`.
export const AVColorTrc = {
  BT709: 1,
  SMPTE2084: 16, // PQ — absolute, 1.0 = 10000 cd/m²
  ARIB_STD_B67: 18, // HLG — scene-referred [0,1]
} as const;

/** The shader's HDR mode for a transfer characteristic: 0 = SDR (no tone-map), 1 = PQ, 2 = HLG. PQ/HLG are
 *  the only HDR transfers in practice (both imply BT.2020 primaries → the shader's BT.2020→709 gamut step). */
export function hdrMode(colorTrc: number): number {
  if (colorTrc === AVColorTrc.SMPTE2084) return 1;
  if (colorTrc === AVColorTrc.ARIB_STD_B67) return 2;
  return 0;
}

// Which YUV→RGB matrix the selection resolved to (for tests / instrumentation; not used by the shader).
export type MatrixName = '601' | '709' | '2020';

// The CPU-baked coefficients the FRAG_YUV shader consumes as uniforms. The shader does, with u,v already
// centred (chroma − 0.5):
//   y = (y - yOffset) * yScale;
//   r = y + cRv*v;
//   g = y + cGu*u + cGv*v;
//   b = y + cBu*u;
// Chroma coefficients are ALREADY multiplied by the range chroma-scale (cScale), matching the exact values
// the previous hard-coded BT.709-limited shader carried (1.7927 / -0.2132 / -0.5329 / 2.1124).
export interface ColorConditioning {
  matrix: MatrixName;
  range: 'limited' | 'full';
  yScale: number;
  yOffset: number;
  cRv: number;
  cGu: number;
  cGv: number;
  cBu: number;
}

// Luma weights {Kr, Kb} per matrix family (Kg = 1 − Kr − Kb). mpv csputils.c:349-353 verbatim.
const LUMA: Record<MatrixName, { kr: number; kb: number }> = {
  '601': { kr: 0.299, kb: 0.114 },
  '709': { kr: 0.2126, kb: 0.0722 },
  '2020': { kr: 0.2627, kb: 0.0593 },
};

// Limited→full range scaling for 8-bit-normalised samples (these ratios hold to ~0.1% for 10/12-bit too —
// 16/255 ≈ 64/1023, 219/255 ≈ 876/1023 — so the bit-scale normalisation upstream keeps them correct, which
// is why the prior shader used the same constants for 10-bit content). mpv csputils.c:407-457 / VLC sampler.c.
const Y_BLACK = 16 / 255;   // luma black lift (limited)
const Y_MUL = 255 / 219;    // luma expand (limited): 235−16 = 219
const C_MUL = 255 / 224;    // chroma expand (limited): 240−16 = 224

/** Pick the matrix family from the AVColorSpace value, falling back on UNSPECIFIED / RGB / unhandled to
 *  mpv's resolution heuristic (mp_image.c / csputils.c:168-171): width ≥ 1280 || height > 576 ? 709 : 601. */
export function selectMatrix(colorspace: number, w: number, h: number): MatrixName {
  switch (colorspace) {
    case AVColorSpace.BT709:
      return '709';
    case AVColorSpace.FCC:
    case AVColorSpace.BT470BG:
    case AVColorSpace.SMPTE170M:
      return '601';
    case AVColorSpace.BT2020_NCL:
    case AVColorSpace.BT2020_CL:
      return '2020';
    default:
      // UNSPECIFIED (2), RGB (0), SMPTE240M (7), and any unknown → resolution heuristic.
      return (w >= 1280 || h > 576) ? '709' : '601';
  }
}

/** Limited unless the stream explicitly flags full (JPEG) range. UNSPECIFIED defaults to limited — the
 *  overwhelming majority of broadcast/IPTV content, and the safe default (mpv/VLC both default limited). */
export function selectRange(colorRange: number): 'limited' | 'full' {
  return colorRange === AVColorRange.JPEG ? 'full' : 'limited';
}

/** Resolve the full set of shader coefficients from the stream's colour metadata + frame dims. PURE. */
export function selectColorConditioning(colorspace: number, colorRange: number, w: number, h: number): ColorConditioning {
  const matrix = selectMatrix(colorspace, w, h);
  const range = selectRange(colorRange);
  const { kr, kb } = LUMA[matrix];
  const kg = 1 - kr - kb;
  // Base (full-range) chroma coefficients for centred U/V.
  const rv = 2 * (1 - kr);
  const bu = 2 * (1 - kb);
  const gu = -2 * kb * (1 - kb) / kg;
  const gv = -2 * kr * (1 - kr) / kg;
  const limited = range === 'limited';
  const yScale = limited ? Y_MUL : 1;
  const yOffset = limited ? Y_BLACK : 0;
  const cScale = limited ? C_MUL : 1;
  return {
    matrix,
    range,
    yScale,
    yOffset,
    cRv: rv * cScale,
    cGu: gu * cScale,
    cGv: gv * cScale,
    cBu: bu * cScale,
  };
}

// ---- Dither ---------------------------------------------------------------------------------------------

/** The N×N ordered (Bayer) dither matrix, integer values 0 … N²−1, row-major. Built by the classic
 *  recursive doubling (mpv dither.c:166-176): M₁=[[0]];  M₂ₙ = [[4M+0, 4M+2],[4M+3, 4M+1]].
 *  N must be a power of two. The present worker uploads this as an R8UI integer texture (EXACT — no
 *  normalised-format precision loss); the shader reads it with `(value + 0.5) / N²` to get the dither
 *  offset in (0,1) and does `floor(color*255 + offset) / 255` (mpv's formula, dither_quantization=255). */
export function bayerMatrix(n: number): Uint8Array {
  let size = 1;
  let m = [0];
  while (size < n) {
    const ns = size * 2;
    const nm = new Array<number>(ns * ns);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const base = 4 * m[y * size + x];
        nm[y * ns + x] = base + 0;              // top-left
        nm[y * ns + (x + size)] = base + 2;     // top-right
        nm[(y + size) * ns + x] = base + 3;     // bottom-left
        nm[(y + size) * ns + (x + size)] = base + 1; // bottom-right
      }
    }
    m = nm;
    size = ns;
  }
  return Uint8Array.from(m);
}

/** The 8×8 Bayer matrix the shader uses (values 0…63). */
export const BAYER_8 = 8;
export function bayer8(): Uint8Array {
  return bayerMatrix(BAYER_8);
}
