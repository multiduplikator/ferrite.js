// Typed wrapper over the emscripten ferrite module. The engine exports only HEAPU8
// (no cwrap/ccall), so we call _ferrite_* directly and read memory through HEAPU8.
// Validated against the real module under node: pointers + `int` are JS `number`,
// `int64_t` is BigInt (WASM_BIGINT on).
//
// GROWABLE shared memory (ALLOW_MEMORY_GROWTH): the heap starts at 256 MiB and grows on demand up to a
// 2 GiB ceiling. A grow REPLACES the SharedArrayBuffer and emscripten reassigns `Module.HEAPU8` — but
// ONLY in the realm that grew. The decoders run on PTHREADS, so a 4K-HEVC decode allocating frame
// buffers grows the heap on a DECODE WORKER, leaving THIS (the demux worker) realm's `Module.HEAPU8`
// pinned to the old, shorter buffer. A SharedArrayBuffer never "detaches" on grow, so emscripten's
// `byteLength===0` refresh-guard never fires here and a plain `this.M.HEAPU8` property read stays
// STALE — a malloc'd pointer in the grown region then throws "offset is out of bounds" on .set/.subarray
// (observed as a mid-stream RangeError that the ingest loop misreads as a network drop → false reconnect
// → fed-mid-gap demux corruption / PPS errors). Earlier this file assumed a fresh property read sufficed;
// it does NOT for a cross-thread grow. FIX: we PROVIDE the WebAssembly.Memory at load and keep the handle
// (`mem`); `mem.buffer` is the only stable cross-realm reference to the live buffer, so `liveHeap()`
// rebuilds the stale view and ALL heap access routes through it. Verified by growth_test.mjs (main-realm
// grow) + the live 4K-HEVC path (cross-realm grow).

export interface RawModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  /** Emscripten pthread runtime (exported via EXPORTED_RUNTIME_METHODS=['HEAPU8','PThread']).
   *  `terminateAllThreads()` .terminate()s every pooled + running decode Worker — the only
   *  deterministic way to reap the pool (the children are otherwise closure-private). Optional
   *  so the binding degrades to a soft no-op against an older engine that didn't export it. */
  PThread?: { terminateAllThreads?: () => void; pthreads?: Record<string, unknown>; unusedWorkers?: unknown[] };
  /** Classic-Asyncify runtime (EXPORTED_RUNTIME_METHODS=['...','Asyncify']). A suspending export does NOT
   *  auto-return a Promise — call it, and if it suspended (`currData` changed) await `whenDone()` for the
   *  real result; else it ran synchronously. (The VOD range demux suspends; the live fed-ring demux does
   *  not.) Optional so the binding degrades against an engine that predates the Asyncify build. */
  Asyncify?: { currData: number; whenDone(): Promise<number> };
  [sym: string]: any;
}

// Known-benign FFmpeg av_log lines emitted to stderr when JOINING a live mpegts stream mid-GOP
// (a buffering-period SEI / slice references a parameter set before the first SPS/PPS arrives) or during
// the probe/find_stream_info join. They print a few times then the decoder locks on the next keyframe —
// VLC suppresses the same warnings. Dropping ONLY these specific substrings keeps the console clean
// without hiding real errors (everything else is forwarded). Tight on purpose: corruption signals like
// "Packet corrupt" / "Could not find ref with POC" are NOT listed — if they appear they're real.
const BENIGN_FFMPEG_LOG = [
  'non-existing PPS',
  'non-existing SPS',
  // Benign mpegts DEMUX-PARSER join noise. The streaming demux opens without
  // find_stream_info, so its internal parser logs these per slice until the in-band param sets pass —
  // but the DECODER is built with extradata (extract_extradata BSF) so it decodes fine (node-proven:
  // 95% of packets at ~97fps on the slate stream that floods these). Logged with a stack trace each,
  // this flood throttled the worker pump (97fps→15fps in-browser). Decoder-side corruption signals
  // ("Packet corrupt" / "Could not find ref with POC") are still NOT listed — those stay visible.
  'PPS id out of range',
  'Skipping invalid undecodable NALU',
  'probed stream',
];
const isBenignFfmpegLog = (s: string): boolean => BENIGN_FFMPEG_LOG.some((p) => s.includes(p));

export async function loadFerrite(wasmBaseUrl: string, pool: number): Promise<Ferrite> {
  const mod = await import(/* @vite-ignore */ `${wasmBaseUrl}ferrite.mjs`);
  // Provide the shared WebAssembly.Memory OURSELVES (emscripten honors an incoming Module.wasmMemory)
  // and KEEP the handle — the only stable cross-realm reference to the live buffer after a pthread grow.
  // The descriptor MUST match the engine build (INITIAL_MEMORY=256 MiB → 4096 pages, MAXIMUM_MEMORY=2 GiB
  // → 32768 pages, shared) or instantiation fails. (build-engine.sh: INITIAL=268435456, MAXIMUM=2147483648.)
  const memory = new WebAssembly.Memory({ initial: 268435456 / 65536, maximum: 32768, shared: true }); // 256 MiB initial → GROWABLE to 2 GiB (32768 pages), matching build-engine.sh MAXIMUM_MEMORY=2GB. (We briefly ran 4 GiB to prove the old 2 GiB "wall" was a SIGN bug — V8/Chrome M83 made wasm heap access unsigned — but measured peak is only ~1.1 GiB, and for SHARED memory the MAXIMUM is reserved as virtual address space up front, so a 4 GiB ceiling only raises iOS instantiation risk for no gain.) The fix that MATTERS is kept: every engine POINTER is read UNSIGNED (`ptr >>> 0`), since a >2 GiB pointer returns signed-negative and `new Uint16Array(buffer, negOffset)` throws. liveHeap() re-reads HEAPU8 after a grow.
  const M: RawModule = await mod.default({
    ferritePool: pool,
    wasmMemory: memory,
    locateFile: (p: string) => `${wasmBaseUrl}${p}`,
    // Filter the benign FFmpeg startup/probe noise out of the console (av_log → stderr → printErr).
    // Forward everything else unchanged so real errors stay visible.
    printErr: (s: string) => { if (!isBenignFfmpegLog(s)) console.error(s); }, // keep error-level (emscripten default) so host console.error hooks still see real FFmpeg stderr
    print: (s: string) => { if (!isBenignFfmpegLog(s)) console.log(s); },
  });
  return new Ferrite(M, memory);
}

export class Ferrite {
  private M: RawModule;
  private mem: WebAssembly.Memory;
  constructor(M: RawModule, mem: WebAssembly.Memory) { this.M = M; this.mem = mem; }

  /** A HEAPU8 view guaranteed to cover the LIVE shared memory. After a grow on ANOTHER realm (a decode
   *  pthread), this realm's `Module.HEAPU8` is pinned to the old, shorter buffer; `mem.buffer` always
   *  returns the current SAB, so detect the mismatch and rebuild. No-op on the hot path (no grow). */
  private liveHeap(): Uint8Array {
    const h = this.M.HEAPU8;
    const buf = this.mem.buffer;
    if (h.buffer !== buf) return (this.M.HEAPU8 = new Uint8Array(buf as ArrayBuffer));
    return h;
  }

  get heap(): Uint8Array { return this.liveHeap(); }
  /** The engine's growable shared WebAssembly.Memory — the only stable cross-realm reference to the live
   *  buffer after a pthread grow. Forwarded to the present worker (zero-copy present) so it can
   *  re-view `memory.buffer` fresh per GL upload. */
  get memory(): WebAssembly.Memory { return this.mem; }
  malloc(n: number): number { return this.M._malloc(n); }
  free(p: number): void { this.M._free(p); }

  /**
   * Terminate the emscripten pthread pool (the 8 pooled decode Workers + any still running).
   * MUST be called AFTER the demux/decoders are freed (avcodec_free_context joins a
   * frame-threaded decoder's workers back into the pool first; terminating live decode threads
   * would strand the join). Soft no-op if the engine predates the PThread export. Idempotent.
   */
  shutdownThreads(): void {
    this.M.PThread?.terminateAllThreads?.();
  }

  /** Live emscripten pthread-pool size = registered threads (`PThread.pthreads`) + idle pool
   *  (`PThread.unusedWorkers`). The destroy reap polls this: a worker still completing its async
   *  spawn/replenish when an earlier `terminateAllThreads()` ran is in NEITHER set and orphans — it only
   *  becomes visible (and reapable) once it registers, so re-reap while this stays > 0. Soft 0 if the
   *  engine predates the PThread export. */
  pthreadPoolCount(): number {
    const pt = this.M.PThread;
    if (!pt) return 0;
    return Object.keys(pt.pthreads ?? {}).length + (pt.unusedWorkers?.length ?? 0);
  }

  // --- streaming demux ---
  demuxNewStreaming(): number { return this.M._ferrite_demux_new_streaming(); }
  demuxSetMaxBuffered(d: number, max: number): void { this.M._ferrite_demux_set_max_buffered(d, max); }
  /** Copy network bytes into the wasm heap and append to the demux ring. */
  demuxFeed(d: number, bytes: Uint8Array): void {
    const p = this.M._malloc(bytes.length) >>> 0; // >>>0: a heap pointer above 2 GiB returns signed-negative — read it unsigned
    this.liveHeap().set(bytes, p); // liveHeap: a concurrent decode-pthread grow may have left HEAPU8 stale
    this.M._ferrite_demux_feed(d, p, bytes.length);
    this.M._free(p);
  }
  demuxEof(d: number): void { this.M._ferrite_demux_eof(d); }
  demuxOpen(d: number): number { return this.M._ferrite_demux_open(d); }

  // --- range-streamed VOD demux (Asyncify single-forward-connection) ---
  /** Call a SUSPENDING engine export: if the range read suspended (Asyncify `currData` advanced) await
   *  `whenDone()` for the real return value; otherwise it ran synchronously (the bytes were already
   *  buffered) and we have it. Degrades to a plain sync call against a non-Asyncify engine. */
  private async whenDone(call: () => number): Promise<number> {
    const A = this.M.Asyncify;
    if (!A) return call();
    const prev = A.currData;
    const r = call();
    return A.currData !== prev ? await A.whenDone() : r;
  }
  /**
   * Install (or clear with `null`) the ASYNC hook the engine's range-AVIO awaits for EVERY read
   * (ferrite_js_range_read = EM_ASYNC_JS → `await Module.__ferriteRangeReadAsync(handle, pos, len)`).
   * `read(pos,len)` resolves to the bytes at byte-offset `pos` (≤ len; a SHORT array at EOF, EMPTY past
   * EOF, null on a hard error). The C bridge writes them to a FRESH HEAPU8 AFTER the await (the
   * growable-memory discipline lives on the C side now), so this delivers plain JS bytes only. MUST be set
   * BEFORE `demuxNewRange` — open()/find_stream_info issue reads immediately.
   */
  setRangeReader(read: ((pos: number, len: number) => Promise<Uint8Array | null>) | null): void {
    if (!read) { delete this.M.__ferriteRangeReadAsync; return; }
    this.M.__ferriteRangeReadAsync = (_handle: number, pos: number, len: number): Promise<Uint8Array | null> => read(pos, len);
  }
  /** Open a Range-streamed VOD demuxer (header parse only — NOT a whole-file download); SUSPENDS through
   *  find_stream_info. `totalSize` is the probed file size (for AVSEEK_SIZE). Resolves to 0 on failure.
   *  Set the range reader first. */
  demuxNewRange(handle: number, totalSize: number): Promise<number> {
    return this.whenDone(() => this.M._ferrite_demux_new_range(handle, totalSize, 0, 0));
  }
  /** VOD demux step — SUSPENDS on a range AVIO read. (The LIVE fed-ring path uses the synchronous
   *  `demuxStep` below, which never reaches the async import → never suspends → stays untouched.) */
  demuxStepVod(d: number): Promise<number> { return this.whenDone(() => this.M._ferrite_demux_step(d)); }
  /** Container duration in µs (0 = unknown) — for the VOD scrub bar / seek-target clamp. */
  demuxDurationUs(d: number): bigint { return this.M._ferrite_demux_duration_us(d); }
  /** av_seek_frame to ~tsUs (DOUBLE µs — a suspending export takes no i64/BigInt) on the video
   *  stream (backward=1 → keyframe at/before). SUSPENDS (reads the index/probes). Caller flushes the decoders. */
  demuxSeekUs(d: number, tsUs: number, backward: number): Promise<number> {
    return this.whenDone(() => this.M._ferrite_demux_seek_us(d, tsUs, backward));
  }
  demuxBuffered(d: number): number { return this.M._ferrite_demux_buffered(d); }
  demuxVcodec(d: number): number { return this.M._ferrite_demux_vcodec(d); }
  demuxAcodec(d: number): number { return this.M._ferrite_demux_acodec(d); }
  /** Video profile/level from the demuxer (HEVC carries real values; H.264 leaves them -99 → parse SPS). */
  demuxVProfile(d: number): number { return this.M._ferrite_demux_v_profile(d); }
  demuxVLevel(d: number): number { return this.M._ferrite_demux_v_level(d); }
  /** Resolved video param-set extradata size (Annex-B); 0 until the live demux extracts the in-band
   *  VPS/SPS/PPS (or find_stream_info fills it for VOD). >0 ⇒ build the decoder via vdecNewFromDemux. */
  demuxVExtradataSize(d: number): number { return this.M._ferrite_demux_v_extradata_size(d); }
  /** Heap view of the resolved video extradata (Annex-B NALs); empty until captured. */
  demuxVExtradata(d: number): Uint8Array {
    const ptr = this.M._ferrite_demux_v_extradata(d) >>> 0, len = this.M._ferrite_demux_v_extradata_size(d);
    return ptr && len > 0 ? this.liveHeap().subarray(ptr, ptr + len) : new Uint8Array(0);
  }
  /** Re-arm live param-set capture on a mid-stream codec change (drop the previous codec's extradata). */
  demuxResetVExtradata(d: number): void { this.M._ferrite_demux_reset_v_extradata(d); }
  demuxStep(d: number): number { return this.M._ferrite_demux_step(d); }
  demuxPktStream(d: number): number { return this.M._ferrite_demux_pkt_stream(d); }
  demuxPktDataPtr(d: number): number { return this.M._ferrite_demux_pkt_data(d); }
  demuxPktSize(d: number): number { return this.M._ferrite_demux_pkt_size(d); }
  demuxPktPtsUs(d: number): bigint { return this.M._ferrite_demux_pkt_pts_us(d); }
  demuxPktIsKey(d: number): number { return this.M._ferrite_demux_pkt_is_key(d); }
  demuxFree(d: number): void { this.M._ferrite_demux_free(d); }

  // --- video decode ---
  vdecNew(codecId: number, threads: number): number { return this.M._ferrite_vdec_new(codecId, threads); }
  /** VOD/file: build the video decoder FROM the demuxer's stream — copies AVCC/HVCC extradata so the
   *  length-prefixed MP4/MKV NALs decode (the bare vdecNew has no extradata → can't parse them). */
  vdecNewFromDemux(d: number, threads: number): number { return this.M._ferrite_vdec_new_from_demux(d, threads); }
  /** pkt is a wasm-heap pointer (the demux packet) — pass straight through, no copy. */
  vdecPush(v: number, ptr: number, len: number, ptsUs: bigint): number {
    return this.M._ferrite_vdec_push(v, ptr, len, ptsUs);
  }
  vdecStep(v: number): number { return this.M._ferrite_vdec_step(v); }
  vdecW(v: number): number { return this.M._ferrite_vdec_w(v); }
  vdecH(v: number): number { return this.M._ferrite_vdec_h(v); }
  vdecCw(v: number): number { return this.M._ferrite_vdec_cw(v); }
  vdecCh(v: number): number { return this.M._ferrite_vdec_ch(v); }
  /** Tight 8-bit plane (10-bit content is downshifted by the engine). */
  vdecPlane8(v: number, ch: number): number { return this.M._ferrite_vdec_plane8(v, ch); }
  /** Current frame luma bit depth (8/10/12) — the present worker picks R8UI vs R16UI + the shader's
   *  bit-scale from this. */
  vdecBitdepth(v: number): number { return this.M._ferrite_vdec_bitdepth(v); }
  // RENDER-QUALITY color-conditioning: the current frame's matrix_coefficients (AVColorSpace) + color_range
  // (AVColorRange) — the present worker's YUV→RGB shader picks the {601,709,2020} matrix + limited/full
  // range from these (resolution fallback when colorspace is UNSPECIFIED). Constant per stream; cheap enum read.
  vdecColorspace(v: number): number { return this.M._ferrite_vdec_colorspace(v); }
  vdecColorRange(v: number): number { return this.M._ferrite_vdec_color_range(v); }
  /** HDR transfer characteristic (AVColorTransferCharacteristic): PQ=16, HLG=18 → tone-map to BT.709. */
  vdecColorTrc(v: number): number { return this.M._ferrite_vdec_color_trc(v); }
  /** Sample (pixel) aspect ratio of the current frame — DAR = width·SAR/height (1:1 for square pixels). */
  vdecSarNum(v: number): number { return this.M._ferrite_vdec_sar_num(v); }
  vdecSarDen(v: number): number { return this.M._ferrite_vdec_sar_den(v); }
  // Frame-pinning (TRUE zero-copy present, supersedes vdecPack): hold a ref on the decoder's current
  // output frame so the present worker uploads its NATIVE-stride/native-bit-depth planes straight to a
  // WebGL2 integer texture (the GPU de-strides + bit-scales — no CPU copy, no 10→8 downshift).
  /** Hold the current decoded frame → a 1-based token (0 = held table full → caller drops/blocks). */
  vdecHold(v: number): number { return this.M._ferrite_vdec_hold(v); }
  /** Heap offset of held plane `idx` (0=Y,1=U,2=V) — view memory.buffer here. */
  vdecHeldPlane(token: number, idx: number): number { return this.M._ferrite_vdec_held_plane(token, idx) >>> 0; } // unsigned: a 4K plane can sit above 2 GiB
  /** Held plane `idx` stride in BYTES (UNPACK_ROW_LENGTH = linesize / bytes-per-sample). */
  vdecHeldLinesize(token: number, idx: number): number { return this.M._ferrite_vdec_held_linesize(token, idx); }
  /** Release one held frame (the decoder may reuse its buffer). Idempotent against a double release. */
  vdecRelease(token: number): void { this.M._ferrite_vdec_release(token); }
  /** Release ALL held frames — on teardown/reload, AFTER the present worker has been reset. */
  vdecReleaseAll(): void { this.M._ferrite_vdec_release_all(); }
  /** Heap view of a tight 8-bit plane: w×h for luma, cw×ch for chroma. */
  planeView(ptr: number, len: number): Uint8Array { const p = ptr >>> 0; return this.liveHeap().subarray(p, p + len); }
  /** COPY `len` heap bytes out into a fresh, detached Uint8Array (for the WebCodecs EncodedVideoChunk
   *  data + SPS parse — the demux packet buffer is only valid until the next demux_step). */
  auCopy(ptr: number, len: number): Uint8Array { const p = ptr >>> 0; return this.liveHeap().slice(p, p + len); }
  vdecPts(v: number): number { return this.M._ferrite_vdec_pts(v); } // double µs
  vdecSetDeint(v: number, mode: number): void { this.M._ferrite_vdec_set_deint(v, mode); }
  /** DECODE-RELIEF LEVERS (skip-non-ref / skip-loop): runtime-settable per-decode skip controls (read per-frame
   *  → honoured mid-stream, no re-init). `skipNonref` discards non-reference frames (~half the
   *  decoded frames + decode work); `skipLoop` skips the in-loop deblock (all frames kept, softer).
   *  0/0 restores the default. Re-applied by the worker after every (re)create so the choice persists. */
  vdecSetSkips(v: number, skipNonref: number, skipLoop: number): void { this.M._ferrite_vdec_set_skips(v, skipNonref, skipLoop); }
  vdecDeintFailed(v: number): number { return this.M._ferrite_vdec_deint_failed(v); }
  vdecFree(v: number): void { this.M._ferrite_vdec_free(v); }

  // --- audio decode ---
  audioNew(codecId: number): number { return this.M._ferrite_audio_new(codecId); }
  /** VOD/file: build the audio decoder FROM the demuxer's stream — copies codecpar extradata (raw AAC
   *  AudioSpecificConfig etc., which MP4/MKV carry out-of-band, unlike self-describing mpegts ADTS). */
  audioNewFromDemux(d: number): number { return this.M._ferrite_audio_new_from_demux(d); }
  audioPush(a: number, ptr: number, len: number, ptsUs: bigint): number {
    return this.M._ferrite_audio_push(a, ptr, len, ptsUs);
  }
  audioStep(a: number): number { return this.M._ferrite_audio_step(a); }
  audioInterleavedPtr(a: number): number { return this.M._ferrite_audio_interleaved(a); }
  audioSamples(a: number): number { return this.M._ferrite_audio_samples(a); } // per channel
  audioRate(a: number): number { return this.M._ferrite_audio_rate(a); }
  audioChannels(a: number): number { return this.M._ferrite_audio_channels(a); }
  audioPtsUs(a: number): bigint { return this.M._ferrite_audio_pts_us(a); }
  /**
   * Copy interleaved float PCM out of the heap into a fresh, transferable buffer.
   * Byte-copies via a Uint8Array first (the FFmpeg/swresample pointer is NOT guaranteed
   * 4-byte aligned, and `new Float32Array(buffer, ptr, …)` throws on a misaligned offset).
   */
  audioCopy(ptr: number, floats: number): Float32Array {
    const bytes = this.liveHeap().subarray(ptr, ptr + floats * 4).slice(); // fresh, aligned ArrayBuffer
    return new Float32Array(bytes.buffer);
  }
  audioFree(a: number): void { this.M._ferrite_audio_free(a); }
}
