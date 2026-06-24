// H.264 SPS reader + WebCodecs codec-string mapping. PURE (no DOM) so the worker can build the
// EXACT `avc1.PPCCLL` string the hardware VideoDecoder needs (an under-claimed level makes the HW
// decoder reject every frame) and detect interlaced H.264 (WebCodecs HW can't deinterlace) — all
// from the in-band SPS sitting inside the first keyframe access unit. node-testable (facade_test.mjs).
// Erasable TS (no enums/param-props).

const HEX = (n: number): string => (n & 0xff).toString(16).padStart(2, '0');

/** The handful of SPS fields the player needs. */
export interface H264Sps {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  /** `false` ⇒ the stream is interlaced-capable (field / PAFF / MBAFF). */
  frameMbsOnly: boolean;
}

/** Exact `avc1.PPCCLL` (profile_idc, constraint flags, level_idc) — the avc1 codec-string builder. */
export function avc1CodecString(profileIdc: number, constraintFlags: number, levelIdc: number): string {
  return `avc1.${HEX(profileIdc)}${HEX(constraintFlags)}${HEX(levelIdc)}`;
}

/** HEVC `hev1.*` in-band-paramset form — the hevc codec-string builder. level≤0 ⇒ fall back to L153. */
export function hevcCodecString(tenBit: boolean, level: number): string {
  const lvl = level > 0 ? level : 153;
  const prof = tenBit ? 'hev1.2.4' : 'hev1.1.6';
  return `${prof}.L${lvl}.B0`;
}

/** What the worker derives per video codec: the WebCodecs string ('' = no WC mapping) + interlaced. */
export interface VideoCodecInfo {
  /** WebCodecs codec string, or '' when the codec has no hardware path (e.g. MPEG-2 → software). */
  codec: string;
  /** Interlaced H.264 (WebCodecs HW can't deinterlace → force the software tier). */
  interlaced: boolean;
}

/**
 * Build the WebCodecs codec string + interlace flag for a demuxed video codec. `profile`/`level`
 * come from the demuxer (HEVC carries real values; H.264 leaves them UNKNOWN=-99, so we parse the
 * in-band SPS in `au` for the exact string + interlace flag). Mirrors the reference codec-string
 * selection + the WC demux worker's SPS branch. `au` may be null (no keyframe yet) → H.264 falls back to the
 * generic High@4.0 string.
 */
export function videoCodecInfo(
  vcodec: number,
  profile: number,
  level: number,
  au: Uint8Array | null,
): VideoCodecInfo {
  if (vcodec === 27) {
    // AV_CODEC_ID_H264 — prefer the SPS-derived exact string + interlace flag.
    const sps = au ? h264SpsFromAu(au) : null;
    if (sps) {
      return {
        codec: avc1CodecString(sps.profileIdc, sps.constraintFlags, sps.levelIdc),
        interlaced: !sps.frameMbsOnly,
      };
    }
    // No parseable SPS: a generic High@4.0 covers most ≤1080p H.264 (matches the reference fallback).
    return { codec: 'avc1.640028', interlaced: false };
  }
  if (vcodec === 173) {
    // AV_CODEC_ID_HEVC — profile 2 = Main 10 (10-bit). The demuxer profile is reliable for VOD
    // (find_stream_info resolves it) but UNKNOWN (-99) for LIVE mpegts (no find_stream_info) → sniff the
    // in-band SPS bit depth so a 10-bit live stream gets the Main10 string (hev1.2.4) a HW Main10 decoder
    // accepts, NOT Main/8-bit (hev1.1.6) which it rejects → a needless software fallback. Level is
    // general_level_idc.
    const tenBit = profile === 2 || (profile < 0 && au !== null && hevcIsTenBit(au));
    return { codec: hevcCodecString(tenBit, level), interlaced: false };
  }
  // MPEG-2 (2) and everything else: no WebCodecs path → the software tier decodes it.
  return { codec: '', interlaced: false };
}

/** VOD video config: the WebCodecs codec string + the optional `description` byte-source the hardware
 *  decoder needs. VOD differs from LIVE in the bitstream FORMAT: a remote MP4/MKV container delivers
 *  LENGTH-PREFIXED (AVCC/HVCC) NALs with the param sets out-of-band in an avcC/hvcC config record
 *  (codecpar->extradata, resolved by find_stream_info) — whereas live mpegts is Annex-B with in-band SPS.
 *  WebCodecs keys the bitstream format off `description` PRESENCE (Chrome): a config-record description ⇒
 *  length-prefixed packets fed as-is; NO description ⇒ Annex-B. So VOD-WC MUST pass the extradata as the
 *  `description` for MP4/MKV, while a .ts-container VOD (Annex-B, like live) passes none. */
export interface VodVideoConfig extends VideoCodecInfo {
  /** The VideoDecoder `description` (avcC/hvcC config record) for length-prefixed VOD, or null for Annex-B. */
  description: Uint8Array | null;
}

/** Extract the FIRST SPS NAL (incl. its 0x67 header byte) from an avcC config record, or null. avcC layout:
 *  [0]ver [1]profile [2]compat [3]level [4]lengthSizeMinusOne [5]numSPS(&0x1f) [6,7]spsLength(BE) [8..]SPS. */
function h264SpsFromAvcC(avcc: Uint8Array): Uint8Array | null {
  if (avcc.length < 8 || (avcc[5] & 0x1f) < 1) return null;
  const spsLen = (avcc[6] << 8) | avcc[7];
  if (spsLen < 1 || 8 + spsLen > avcc.length) return null;
  return avcc.subarray(8, 8 + spsLen);
}

/** Wrap a raw NAL (no start code) as a minimal Annex-B access unit so h264SpsFromAu (start-code scanner)
 *  can parse it — used to read the interlace flag out of the avcC-embedded SPS. */
function annexbWrap(nal: Uint8Array): Uint8Array {
  const au = new Uint8Array(nal.length + 4);
  au[3] = 1; au.set(nal, 4); // 00 00 00 01 + NAL
  return au;
}

/**
 * Decide the VOD video tier config from the demuxer's RESOLVED profile/level (find_stream_info fills these
 * for VOD, unlike live mpegts) + the container `extradata`. A config record (avcC/hvcC — first byte = the
 * version 0x01; Annex-B extradata begins with a 0x00 start-code) yields the exact codec string from its
 * own bytes AND becomes the WebCodecs `description` (the length-prefixed path); Annex-B extradata (a .ts
 * VOD) parses the in-band SPS like live and passes no description. PURE (node-testable). NB: interlace is
 * only detected on the Annex-B SPS path (rare for MP4 VOD); the config-record path reports progressive —
 * an interlaced H.264 MP4 would route to WC, a documented minor limitation (mirror-live scope).
 */
export function vodVideoConfig(
  vcodec: number,
  profile: number,
  level: number,
  extradata: Uint8Array,
): VodVideoConfig {
  // A config record (avcC/hvcC) starts with the version byte 0x01; Annex-B extradata starts with 0x00
  // (the leading start code 00 00 [00] 01). So byte[0]===1 with ≥4 bytes ⇒ length-prefixed container.
  const isConfigRecord = extradata.length >= 4 && extradata[0] === 1;
  if (vcodec === 27) {
    // H.264. avcC: [1]=AVCProfileIndication, [2]=profile_compatibility (constraint flags), [3]=AVCLevelIndication.
    if (isConfigRecord) {
      // The exact codec string comes from the record bytes (authoritative). INTERLACE: the avcC embeds the
      // SPS — parse it (frame_mbs_only_flag) so an interlaced H.264 MP4 routes to SOFTWARE (which can
      // deinterlace) instead of WebCodecs (which CAN'T), mirroring the live SPS-parse. Best-effort: a
      // truncated/odd record defaults to progressive (the codec string still stands).
      const spsNal = h264SpsFromAvcC(extradata);
      const sps = spsNal ? h264SpsFromAu(annexbWrap(spsNal)) : null;
      return { codec: avc1CodecString(extradata[1], extradata[2], extradata[3]), interlaced: sps ? !sps.frameMbsOnly : false, description: extradata };
    }
    // Annex-B extradata (.ts VOD) — parse the in-band SPS for the exact string + interlace flag (as live).
    const sps = h264SpsFromAu(extradata);
    if (sps) {
      return { codec: avc1CodecString(sps.profileIdc, sps.constraintFlags, sps.levelIdc), interlaced: !sps.frameMbsOnly, description: null };
    }
    return { codec: 'avc1.640028', interlaced: false, description: null }; // generic High@4.0 fallback
  }
  if (vcodec === 173) {
    // HEVC — the demuxer profile is RELIABLE for VOD (find_stream_info): profile 2 = Main 10 (10-bit). With a
    // hvcC config record use the hvc1.* string (the length-prefixed convention) + the record as description.
    const tenBit = profile === 2;
    const base = hevcCodecString(tenBit, level); // hev1.* (Annex-B/in-band form)
    if (isConfigRecord) return { codec: base.replace('hev1', 'hvc1'), interlaced: false, description: extradata };
    return { codec: base, interlaced: false, description: null };
  }
  // MPEG-2 and everything else: no WebCodecs path → the software tier decodes it.
  return { codec: '', interlaced: false, description: null };
}

/**
 * Pure tier eligibility (the synchronous half of the gate; the async
 * VideoDecoder.isConfigSupported(codec) check is layered on top in the worker). WebCodecs is
 * eligible only when the host PREFERS it, the runtime HAS a VideoDecoder, the codec maps to a WC
 * string, and the stream is progressive. Interlaced or unmapped codecs ⇒ false ⇒ software fallback.
 */
export function webCodecsEligible(
  preferWebCodecs: boolean,
  hasVideoDecoder: boolean,
  info: VideoCodecInfo,
): boolean {
  return preferWebCodecs && hasVideoDecoder && info.codec !== '' && !info.interlaced;
}

/**
 * Scan an Annex-B access unit for an SPS NAL (type 7) and decode the essentials. `null` if there's
 * no SPS or the RBSP is truncated. Parses the H.264 SPS.
 */
export function h264SpsFromAu(au: Uint8Array): H264Sps | null {
  const sps = findNal(au, 7);
  if (!sps || sps.length < 4) return null;
  const profileIdc = sps[0];
  const constraintFlags = sps[1];
  const levelIdc = sps[2];

  const rbsp = unescapeRbsp(sps.subarray(3));
  const r = new BitReader(rbsp);

  r.ue(); // sps_id
  // High-profile family carries extra chroma/bit-depth syntax before the common fields.
  const HIGH = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  if (HIGH.indexOf(profileIdc) !== -1) {
    const chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit() === 1) {
      // seq_scaling_matrix_present_flag → walk the scaling lists to advance bits.
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (r.bit() === 1) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.bit(); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se(); // offset_for_ref_frame[i]
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  const frameMbsOnly = r.bit() === 1;
  if (r.failed) return null;

  return { profileIdc, constraintFlags, levelIdc, frameMbsOnly };
}

/**
 * Sniff whether an HEVC stream is ≥10-bit, from the in-band SPS `bit_depth_luma_minus8`. Used when the
 * demuxer leaves the profile UNKNOWN (live mpegts) so a 10-bit stream still maps to the Main10
 * (hev1.2.4) WebCodecs string. Parses profile_tier_level + the SPS prefix up to bit_depth_luma_minus8;
 * `false` on any truncation/parse failure (safe default → the existing 8-bit string + SW fallback).
 */
export function hevcIsTenBit(au: Uint8Array): boolean {
  const sps = findHevcNal(au, 33); // HEVC SPS_NUT
  if (!sps) return false;
  const r = new BitReader(unescapeRbsp(sps));
  r.skip(4); // sps_video_parameter_set_id
  const maxSub = r.read(3); // sps_max_sub_layers_minus1
  r.skip(1); // sps_temporal_id_nesting_flag
  // profile_tier_level( profilePresentFlag=1, maxSub ): general profile (8) + compat[32] + flags(4) +
  // reserved(43) + inbld(1) = 88 bits, then general_level_idc (8).
  r.skip(88);
  r.skip(8);
  const subProfile: number[] = [];
  const subLevel: number[] = [];
  for (let i = 0; i < maxSub; i++) { subProfile.push(r.bit()); subLevel.push(r.bit()); }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.skip(2); // reserved_zero_2bits[i]
  for (let i = 0; i < maxSub; i++) { if (subProfile[i] === 1) r.skip(88); if (subLevel[i] === 1) r.skip(8); }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
  r.ue(); // pic_width_in_luma_samples
  r.ue(); // pic_height_in_luma_samples
  if (r.bit() === 1) { r.ue(); r.ue(); r.ue(); r.ue(); } // conformance_window_flag → 4 offsets
  const bitDepthLumaMinus8 = r.ue();
  if (r.failed) return false;
  return bitDepthLumaMinus8 >= 2; // minus8 ≥ 2 ⇒ ≥10-bit
}

/**
 * RBSP of the first HEVC NAL of `wantType` (bytes AFTER the 2-byte HEVC NAL header — nal_unit_type =
 * (byte0 >> 1) & 0x3f), spanning to the next start code. Handles 3- and 4-byte start codes.
 */
function findHevcNal(au: Uint8Array, wantType: number): Uint8Array | null {
  const n = au.length;
  let i = 0;
  while (i + 2 < n) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const hdr = i + 3;
      if (hdr + 1 >= n) return null; // need both NAL header bytes
      const nalType = (au[hdr] >> 1) & 0x3f;
      let j = hdr + 2;
      let end = n;
      while (j + 2 < n) {
        if (au[j] === 0 && au[j + 1] === 0 && au[j + 2] === 1) { end = j; break; }
        j++;
      }
      if (nalType === wantType) return au.subarray(hdr + 2, end);
      i = end;
    } else {
      i++;
    }
  }
  return null;
}

/**
 * Return the RBSP of the first NAL of `wantType` (bytes AFTER the 1-byte NAL header), spanning to
 * the next start code. Handles 3- and 4-byte start codes. Finds an Annex-B NAL of the wanted type.
 */
function findNal(au: Uint8Array, wantType: number): Uint8Array | null {
  const n = au.length;
  let i = 0;
  while (i + 2 < n) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const hdr = i + 3;
      if (hdr >= n) return null;
      const nalType = au[hdr] & 0x1f;
      let j = hdr + 1;
      let end = n;
      while (j + 2 < n) {
        if (au[j] === 0 && au[j + 1] === 0 && au[j + 2] === 1) {
          end = j;
          break;
        }
        j++;
      }
      if (nalType === wantType) return au.subarray(hdr + 1, end);
      i = end;
    } else {
      i++;
    }
  }
  return null;
}

/** Drop H.264 emulation-prevention bytes (`0x03` following `0x00 0x00`). Unescapes the RBSP. */
function unescapeRbsp(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < d.length; i++) {
    const b = d[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    if (b === 0) zeros++;
    else zeros = 0;
    out.push(b);
  }
  return new Uint8Array(out);
}

/** Advance the reader past a scaling list (values discarded). */
function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const delta = r.se();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/**
 * MSB-first bit reader with Exp-Golomb (ue/se) decoding. A read off
 * the end sets `failed` and returns 0 (instead of an Option-style short-circuit); the caller checks
 * `failed` once at the end. Bounded everywhere — `ue()` caps at 31 leading zeros. Arithmetic uses
 * `*2`/`2**` rather than JS 32-bit `<<` so values up to 2^31 don't wrap into negatives.
 */
class BitReader {
  private data: Uint8Array;
  private pos = 0; // bit position
  failed = false;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bit(): number {
    const idx = this.pos >> 3;
    if (idx >= this.data.length) {
      this.failed = true;
      return 0;
    }
    const b = (this.data[idx] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  /** Skip `n` bits (bounded — overrun sets `failed`). For fixed-length HEVC profile_tier_level fields. */
  skip(n: number): void {
    for (let i = 0; i < n; i++) this.bit();
  }

  /** Read `n` bits MSB-first as an unsigned value (n ≤ 31; overrun sets `failed`). */
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (this.failed) return 0;
      zeros++;
      if (zeros > 31) {
        this.failed = true;
        return 0;
      }
    }
    let val = 0;
    for (let i = 0; i < zeros; i++) val = val * 2 + this.bit();
    return 2 ** zeros - 1 + val;
  }

  se(): number {
    const k = this.ue();
    const mag = Math.floor((k + 1) / 2);
    return k % 2 === 1 ? mag : -mag;
  }
}
