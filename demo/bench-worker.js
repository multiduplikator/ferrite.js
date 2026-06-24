// Decode-only benchmark worker — the engine's frame-thread Atomics.wait is legal in a worker (unlike the
// page main thread), so it runs demux→decode-as-fast-as-possible with NO present, NO audio, NO pacing →
// pure decode throughput (fps). Message in: {file, threads}. Message out: {type:'log'|'err'|'done', …}.

const STARTUP = 256 * 1024, CHUNK = 64 * 1024;
const post = (m) => self.postMessage(m);

self.onmessage = async (ev) => {
  const { file, threads } = ev.data;
  try {
    post({ type: 'log', m: 'loading engine…' });
    const mod = await import('/assets/ferrite.mjs');
    const memory = new WebAssembly.Memory({ initial: 268435456 / 65536, maximum: 32768, shared: true }); // 2 GiB ceiling (must match engine MAXIMUM_MEMORY=2GB)
    const M = await mod.default({
      ferritePool: threads + 2, wasmMemory: memory,
      locateFile: (p) => '/assets/' + p, printErr: () => {}, print: () => {},
    });
    const heap = () => (M.HEAPU8.buffer !== memory.buffer ? (M.HEAPU8 = new Uint8Array(memory.buffer)) : M.HEAPU8);
    post({ type: 'log', m: 'engine ready; fetching file…' });
    const buf = new Uint8Array(await (await fetch(file)).arrayBuffer());
    post({ type: 'log', m: `file = ${(buf.length / 1048576).toFixed(1)} MB; decoding (decode-only, ${threads} threads)…` });

    const d = M._ferrite_demux_new_streaming(); let pos = 0;
    const feed = (a, b) => { const sl = buf.subarray(a, b); const p = M._malloc(sl.length) >>> 0; heap().set(sl, p); M._ferrite_demux_feed(d, p, sl.length); M._free(p); };
    feed(0, Math.min(STARTUP, buf.length)); pos = Math.min(STARTUP, buf.length);
    let opened = false;
    for (let t = 0; t < 800 && !opened; t++) { if (M._ferrite_demux_open(d) === 0) opened = true; else { feed(pos, Math.min(pos + CHUNK, buf.length)); pos = Math.min(pos + CHUNK, buf.length); } }
    if (!opened) { post({ type: 'err', m: 'demux failed to open (not MPEG-TS / unsupported?)' }); return; }
    let vcodec = M._ferrite_demux_vcodec(d), v = 0, ed = false, frames = 0, w = 0, h = 0, bd = 0;
    const mk = () => { if (v) M._ferrite_vdec_free(v); const es = M._ferrite_demux_v_extradata_size(d); v = es > 0 ? M._ferrite_vdec_new_from_demux(d, threads) : M._ferrite_vdec_new(vcodec, threads); ed = es > 0; };
    const t0 = performance.now();
    for (let g = 0; g < 1e7; g++) {
      if (pos < buf.length) { feed(pos, Math.min(pos + CHUNK, buf.length)); pos = Math.min(pos + CHUNK, buf.length); } else M._ferrite_demux_eof(d);
      const s = M._ferrite_demux_step(d);
      if (s === 1) { if (M._ferrite_demux_pkt_stream(d) === 0) {
        if (vcodec <= 0) vcodec = M._ferrite_demux_vcodec(d);
        if (vcodec > 0 && !v) mk(); if (v && !ed && M._ferrite_demux_v_extradata_size(d) > 0) mk();
        const isKey = M._ferrite_demux_pkt_is_key(d) === 1;
        if ((vcodec === 27 || vcodec === 173) && !ed && !isKey) continue; // hold H.264/HEVC until param sets resolve
        if (v) { M._ferrite_vdec_push(v, M._ferrite_demux_pkt_data(d), M._ferrite_demux_pkt_size(d), BigInt(M._ferrite_demux_pkt_pts_us(d))); while (M._ferrite_vdec_step(v) === 1) { frames++; if (!w) { w = M._ferrite_vdec_w(v); h = M._ferrite_vdec_h(v); bd = M._ferrite_vdec_bitdepth ? M._ferrite_vdec_bitdepth(v) : 0; } } }
      } } else if (s === 2) { if (pos >= buf.length) { if (v) { M._ferrite_vdec_push(v, 0, 0, 0n); while (M._ferrite_vdec_step(v) === 1) frames++; } break; } } else break;
    }
    const ms = performance.now() - t0;
    post({ type: 'done', vcodec, w, h, bd, frames, ms, fps: Math.round(frames / ms * 1000), threads });
  } catch (e) { post({ type: 'err', m: (e && e.message) ? e.message : String(e) }); }
};
