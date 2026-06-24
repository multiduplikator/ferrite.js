// ferrite.c — implementation of the TS-demux + video/audio-decode reactor API.
// The FFmpeg reactor compiled into the Ferrite engine wasm (build-engine.sh).
#include "ferrite.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>   // SEEK_SET / SEEK_CUR / SEEK_END for the file-mode AVIO seek callback
#include <emscripten.h>   // EM_ASYNC_JS — the AWAITing JS range-read bridge for the streaming VOD AVIO (Asyncify)
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>          // extract_extradata BSF — live param-set resolution
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/pixdesc.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <libswresample/swresample.h>

// ===================== DEMUX =====================
struct RDDemux {
    AVFormatContext* fmt;
    AVIOContext* avio;
    const uint8_t* ts; size_t ts_len; size_t ts_pos;       // finite (whole-file) mode
    int range_mode;                                        // range-streamed VOD: AVIO pulls bytes on demand via a JS sync-XHR Range hook
    int range_handle;                                      // opaque key passed to the JS range reader (Module.__ferriteRangeRead)
    int64_t range_pos, range_total;                        // current byte offset + total file size (AVSEEK_SIZE)
    int streaming;                                          // live (incrementally-fed) mode
    uint8_t* buf; size_t cap, len, pos; int eof;            // fed ring (compacting): [pos,len) unread
    size_t max_buffered;                                    // opt-in live cap on unread bytes (0 = unbounded)
    int vstream, astream;
    AVPacket* pkt;
    AVBSFContext* ed_bsf;                                   // extract_extradata BSF (streaming param-set pull)
    int ed_done;                                            // 1 = extradata captured (or BSF unavailable) → stop trying
};

// Finite (whole-file) read: serve from a fixed in-memory slice; EOF at the end.
static int ferrite_io_read(void* opaque, uint8_t* buf, int buf_size) {
    RDDemux* d = (RDDemux*)opaque;
    size_t remain = d->ts_len - d->ts_pos;
    if (remain == 0) return AVERROR_EOF;
    int n = buf_size < (int)remain ? buf_size : (int)remain;
    memcpy(buf, d->ts + d->ts_pos, (size_t)n);
    d->ts_pos += (size_t)n;
    return n;
}

// Finite (whole-file) seek: random-access over the fixed in-memory slice. Required for the VOD/file
// demux mode — moov/MKV-Cues parsing (find_stream_info) and av_seek_frame both issue AVIO seeks.
// AVSEEK_SIZE reports the total file size (lets mov/matroska size the moov atom / Cues without EOF).
// The live mpegts streaming AVIO deliberately passes NULL here (forward-only fed ring, not seekable).
static int64_t ferrite_io_seek(void* opaque, int64_t offset, int whence) {
    RDDemux* d = (RDDemux*)opaque;
    if (whence == AVSEEK_SIZE) return (int64_t)d->ts_len;
    int64_t base;
    switch (whence & ~AVSEEK_FORCE) {
        case SEEK_SET: base = 0; break;
        case SEEK_CUR: base = (int64_t)d->ts_pos; break;
        case SEEK_END: base = (int64_t)d->ts_len; break;
        default: return AVERROR(EINVAL);
    }
    int64_t np = base + offset;
    if (np < 0 || np > (int64_t)d->ts_len) return AVERROR(EINVAL);
    d->ts_pos = (size_t)np;
    return np;
}

// ---- Range-streamed VOD AVIO (the range-stream fix). ----
// Native ffmpeg/VLC stream + seek a remote container via libavformat's built-in http protocol (Range
// on seek); WASM/browser ffmpeg can't (no raw sockets — --disable-network, and Emscripten's socket
// shim is a WebSocket bridge that can't reach a CDN). So we supply the I/O ourselves: the AVIO read/
// seek callbacks pull bytes ON DEMAND from JS instead of from a pre-filled whole-file buffer. FFmpeg's
// AVIO callbacks are SYNCHRONOUS (the demuxer wants bytes now) but fetch is async — so the JS hook does
// a SYNCHRONOUS XHR with a Range header on the WORKER thread (sync XHR is permitted off the main
// thread). The demuxers then do the SAME on-demand range reads + av_seek_frame they'd do over the http
// protocol; only the byte source changed (in-memory slice -> range fetch). Identical seekable behaviour
// to the finite whole-file path (moov/MKV-Cues parsing + av_seek_frame), just without the prefetch.
//
// Module.__ferriteRangeReadAsync(handle, pos, len): the ASYNC JS hook RETURNS a Promise<Uint8Array|null>
// of the bytes at byte-offset `pos` (≤ len of them; a SHORT array at EOF is valid AVIO, an EMPTY array is
// EOF, null is a hard error). Under Asyncify the call SUSPENDS here (`await`) — the worker's stack unwinds,
// the pthread decode pool keeps running, and on resume execution rewinds back into this frame. We then
// write the delivered bytes into the wasm heap at `buf` and return the count (>=0), or -1 on error.
//
// GROWABLE-MEMORY INVARIANT: take `HEAPU8` FRESH, AFTER the await, immediately before `.set()`.
// A decode-pthread can grow the shared heap DURING the suspend; a view captured before the await would be
// stale (detached/short) → corruption. Referencing the module-global `HEAPU8` after `await` reads the live
// view. NEVER capture a heap view across the await.
EM_ASYNC_JS(int, ferrite_js_range_read, (int handle, void* buf, int buf_size, double pos), {
    var f = Module["__ferriteRangeReadAsync"];
    if (!f) return -1;
    var data = await f(handle, pos, buf_size);          // SUSPENDS: pool runs; rewinds back here on resume
    if (data === null || data === undefined) return -1; // hard error → AVERROR(EIO)
    var n = data.length | 0;
    if (n <= 0) return 0;                                // EOF → AVERROR_EOF
    if (n > buf_size) n = buf_size;                      // never overrun the AVIO buffer
    HEAPU8.set(n === data.length ? data : data.subarray(0, n), buf); // FRESH HEAPU8 (post-await), then write
    return n;
});

// Range read: ask JS for the bytes at the current offset; advance by however many it delivered.
static int ferrite_io_read_range(void* opaque, uint8_t* buf, int buf_size) {
    RDDemux* d = (RDDemux*)opaque;
    if (d->range_pos >= d->range_total) return AVERROR_EOF;
    int n = ferrite_js_range_read(d->range_handle, buf, buf_size, (double)d->range_pos);
    if (n < 0) return AVERROR(EIO);
    if (n == 0) return AVERROR_EOF;
    d->range_pos += n;
    return n;
}

// Range seek: pure offset arithmetic (no I/O) — the next read fetches from the new position. AVSEEK_SIZE
// reports the total size JS probed (lets mov/matroska size the moov/Cues without reading to EOF).
static int64_t ferrite_io_seek_range(void* opaque, int64_t offset, int whence) {
    RDDemux* d = (RDDemux*)opaque;
    if (whence == AVSEEK_SIZE) return d->range_total;
    int64_t base;
    switch (whence & ~AVSEEK_FORCE) {
        case SEEK_SET: base = 0; break;
        case SEEK_CUR: base = d->range_pos; break;
        case SEEK_END: base = d->range_total; break;
        default: return AVERROR(EINVAL);
    }
    int64_t np = base + offset;
    if (np < 0 || np > d->range_total) return AVERROR(EINVAL);
    d->range_pos = np;
    return np;
}

// Streaming (live) read: serve from the fed ring. To avoid FFmpeg 8.0's partial-TS-packet → EOF
// misfire (a sub-188 tail at an underrun is read short and mpegts.c treats len!=188 as EOF), while
// live we return ONLY 188-aligned amounts and signal AVERROR(EAGAIN) — never EOF — on a transient
// underrun, holding any sub-188 tail until more bytes arrive. Once JS marks true server-close
// (ferrite_demux_eof) we flush whatever remains and then return AVERROR_EOF.
static int ferrite_io_read_stream(void* opaque, uint8_t* buf, int buf_size) {
    RDDemux* d = (RDDemux*)opaque;
    size_t avail = d->len - d->pos;
    if (avail == 0) return d->eof ? AVERROR_EOF : AVERROR(EAGAIN);
    size_t n = (size_t)buf_size < avail ? (size_t)buf_size : avail;
    if (!d->eof) { n -= n % 188; if (n == 0) return AVERROR(EAGAIN); }
    memcpy(buf, d->buf + d->pos, n);
    d->pos += n;
    return (int)n;
}

void ferrite_demux_free(RDDemux* d) {
    if (!d) return;
    if (d->ed_bsf) av_bsf_free(&d->ed_bsf);
    if (d->pkt) av_packet_free(&d->pkt);
    if (d->fmt) avformat_close_input(&d->fmt);   // closes ctx; custom pb left for us
    if (d->avio) { av_freep(&d->avio->buffer); avio_context_free(&d->avio); }
    free(d->buf); // fed ring (NULL in finite mode)
    free(d);
}

// Whole-file (finite) demux mode — the VOD/file path. AUTODETECTS the container (NULL iformat → probe:
// mpegts, matroska/webm, mov/mp4 are all compiled in) and runs find_stream_info to read the
// header/moov/Cues, with a SEEKABLE AVIO (ferrite_io_seek) so av_seek_frame works. Distinct from the
// live mpegts streaming ring (ferrite_demux_new_streaming), which is forward-only and mpegts-forced.
// IPTV VOD/Series serve Matroska even when the URL claims .mp4 — the probe routes them correctly.
// Finish opening a whole-file/seekable demuxer once its AVIO (in-memory OR range-backed) is built:
// autodetect the container (NULL iformat → probe), read the header (find_stream_info), pick the first
// video + audio stream, report their codec ids, alloc the packet. Returns 0 on success, <0 on error
// (the caller frees). Shared by the finite (in-memory) and range-streamed VOD paths — the ONLY
// difference between them is which read/seek callbacks back the AVIO.
static int demux_finish_file_open(RDDemux* d, int* out_vcodec, int* out_acodec) {
    d->fmt = avformat_alloc_context();
    if (!d->fmt) return -1;
    d->fmt->pb = d->avio;
    if (avformat_open_input(&d->fmt, NULL, NULL, NULL) < 0) return -1;     // frees+NULLs d->fmt; avio kept
    if (avformat_find_stream_info(d->fmt, NULL) < 0) return -1;
    for (unsigned i = 0; i < d->fmt->nb_streams; i++) {
        enum AVMediaType t = d->fmt->streams[i]->codecpar->codec_type;
        if (t == AVMEDIA_TYPE_VIDEO && d->vstream < 0) d->vstream = (int)i;
        if (t == AVMEDIA_TYPE_AUDIO && d->astream < 0) d->astream = (int)i;
    }
    if (out_vcodec) *out_vcodec = d->vstream >= 0 ? d->fmt->streams[d->vstream]->codecpar->codec_id : AV_CODEC_ID_NONE;
    if (out_acodec) *out_acodec = d->astream >= 0 ? d->fmt->streams[d->astream]->codecpar->codec_id : AV_CODEC_ID_NONE;
    d->pkt = av_packet_alloc();
    return 0;
}

static RDDemux* demux_new_file(const uint8_t* data, uint32_t len, int* out_vcodec, int* out_acodec) {
    RDDemux* d = (RDDemux*)calloc(1, sizeof(RDDemux));
    if (!d) return NULL;
    d->ts = data; d->ts_len = len; d->vstream = -1; d->astream = -1;
    size_t bufsz = 1 << 16;
    uint8_t* avbuf = (uint8_t*)av_malloc(bufsz);
    d->avio = avbuf ? avio_alloc_context(avbuf, (int)bufsz, 0, d, ferrite_io_read, NULL, ferrite_io_seek) : NULL;
    if (!d->avio) { if (avbuf) av_free(avbuf); ferrite_demux_free(d); return NULL; }
    if (demux_finish_file_open(d, out_vcodec, out_acodec) < 0) { ferrite_demux_free(d); return NULL; }
    return d;
}

// Range-streamed VOD demux: open a remote container that JS backs with on-demand Range fetches (custom
// AVIO, sync-XHR per read) instead of a pre-filled whole-file buffer — so playback starts after the
// header parse, NOT after the whole file downloads, and seeking issues Range GETs rather than buffering
// to the seek point. `handle` keys the JS reader; `total_size` is the file size JS probed up front (for
// AVSEEK_SIZE). A larger AVIO buffer (256 KiB) cuts the network request count vs the in-memory path.
// Seekable + autodetecting exactly like demux_new_file.
RDDemux* ferrite_demux_new_range(int handle, double total_size, int* out_vcodec, int* out_acodec) {
    RDDemux* d = (RDDemux*)calloc(1, sizeof(RDDemux));
    if (!d) return NULL;
    d->range_mode = 1; d->range_handle = handle;
    d->range_total = (int64_t)total_size; d->range_pos = 0;
    d->vstream = -1; d->astream = -1;
    if (d->range_total <= 0) { ferrite_demux_free(d); return NULL; } // need a known size for AVSEEK_SIZE
    size_t bufsz = 1 << 18; // 256 KiB → fewer, larger Range requests over the network
    uint8_t* avbuf = (uint8_t*)av_malloc(bufsz);
    d->avio = avbuf ? avio_alloc_context(avbuf, (int)bufsz, 0, d, ferrite_io_read_range, NULL, ferrite_io_seek_range) : NULL;
    if (!d->avio) { if (avbuf) av_free(avbuf); ferrite_demux_free(d); return NULL; }
    if (demux_finish_file_open(d, out_vcodec, out_acodec) < 0) { ferrite_demux_free(d); return NULL; }
    return d;
}

// Back-compat name (whole-file .ts fixtures). Same seekable, autodetecting whole-file path as
// ferrite_demux_new_file.
RDDemux* ferrite_demux_new(const uint8_t* ts, uint32_t len, int* out_vcodec, int* out_acodec) {
    return demux_new_file(ts, len, out_vcodec, out_acodec);
}

// VOD/file demux: open a whole-file buffer (MP4/MKV/WebM/TS), autodetected + seekable. The caller
// backs `data` with a Range-fetched whole-file (or progressively-grown) buffer; tests use readFileSync.
RDDemux* ferrite_demux_new_file(const uint8_t* data, uint32_t len, int* out_vcodec, int* out_acodec) {
    return demux_new_file(data, len, out_vcodec, out_acodec);
}

// Container duration in µs (0 if unknown). For the VOD scrubber / seek-target clamping.
int64_t ferrite_demux_duration_us(RDDemux* d) {
    if (!d || !d->fmt || d->fmt->duration == AV_NOPTS_VALUE) return 0;
    return d->fmt->duration; // AVFormatContext.duration is already in AV_TIME_BASE (µs)
}

// Seek to ~ts_us on the video stream (falls back to the default stream if there's no video). backward=1
// lands on the keyframe at-or-before the target (the usual scrubber behaviour: decode forward from a
// keyframe to the exact frame). Returns 0 on success, <0 on error. The CALLER must flush its decoder
// (avcodec_flush_buffers) after a successful seek — ferrite_vdec/ferrite_audio are separate objects.
// ts_us is a DOUBLE (not int64): under Asyncify, ferrite_demux_seek_us SUSPENDS (av_seek_frame reads the
// index/probes through the range AVIO), and a classic-Asyncify rewind RE-INVOKES the suspending export with
// `undefined` args → an i64/BigInt param would crash ("Cannot convert undefined to a BigInt"). A double
// carries µs losslessly (< 2^53) and rewinds cleanly. (Same reason new_range takes a double.)
int ferrite_demux_seek_us(RDDemux* d, double ts_us_d, int backward) {
    if (!d || !d->fmt) return -1;
    int64_t ts_us = (int64_t)ts_us_d;
    int stream = d->vstream; // -1 (no video) → av_seek_frame uses AV_TIME_BASE on the default stream
    int64_t ts = (stream >= 0)
        ? av_rescale_q(ts_us, (AVRational){1, 1000000}, d->fmt->streams[stream]->time_base)
        : av_rescale_q(ts_us, (AVRational){1, 1000000}, AV_TIME_BASE_Q);
    int r = av_seek_frame(d->fmt, stream, ts, backward ? AVSEEK_FLAG_BACKWARD : 0);
    return r < 0 ? r : 0;
}

// ---- Streaming (live) demux: incrementally fed; keeps FFmpeg's mpegts demuxer (it natively
// handles the PSI/PID + mid-stream PMT version bumps / discontinuity indicators). ----
RDDemux* ferrite_demux_new_streaming(void) {
    RDDemux* d = (RDDemux*)calloc(1, sizeof(RDDemux));
    if (!d) return NULL;
    d->streaming = 1; d->vstream = -1; d->astream = -1;
    d->cap = 1 << 20; d->buf = (uint8_t*)malloc(d->cap); // 1 MiB fed ring (grows if needed)
    d->pkt = av_packet_alloc();
    if (!d->buf || !d->pkt) { ferrite_demux_free(d); return NULL; }
    return d;
}

// Append arriving network bytes to the fed ring (compacts the consumed front; grows on overflow).
void ferrite_demux_feed(RDDemux* d, const uint8_t* ptr, uint32_t n) {
    if (!d || !ptr || n == 0) return;
    // Opt-in live back-pressure SAFETY NET (max_buffered>0): if the unread backlog + the new bytes
    // would exceed the cap, shed the OLDEST unread bytes (188-aligned) so a stalled consumer can't
    // grow the ring without bound. mpegts_resync recovers at the next SYNC_BYTE. Default 0 leaves the
    // ring unbounded so the feed-all-up-front byte-parity gate
    // is untouched. The live worker's strict read-on-EAGAIN already keeps the backlog at ~one chunk;
    // this only fires under a genuine runaway (present wedged + network still delivering).
    if (d->max_buffered) {
        size_t unread = d->len - d->pos;
        if (unread + (size_t)n > d->max_buffered) {
            size_t shed = (unread + (size_t)n) - d->max_buffered;
            shed -= shed % 188;
            if (shed > unread) shed = unread; // can't shed more than we hold → drain all (ring empties; resync on the new bytes)
            d->pos += shed;
        }
    }
    // Compact the consumed prefix whenever appending would overflow the END of the ring
    // (len+n > cap) — NOT only when the unread window itself exceeds cap. With a steadily
    // consumed stream, `pos` marches forward while unread stays small; testing `unread+n`
    // here meant compaction never fired once cap grew past the unread window, so `len` ran
    // to `cap` and the ring DOUBLED forever → OOM after ~hours of continuous playback.
    if (d->pos > 0 && d->len + (size_t)n > d->cap) { // compact consumed bytes to the front
        memmove(d->buf, d->buf + d->pos, d->len - d->pos);
        d->len -= d->pos; d->pos = 0;
    }
    if (d->len + (size_t)n > d->cap) { // grow
        if ((size_t)n > SIZE_MAX - d->len) return;                            // add-overflow guard
        size_t ncap = d->cap ? d->cap : (1 << 20);
        while (ncap < d->len + (size_t)n) { if (ncap > SIZE_MAX / 2) return; ncap <<= 1; } // shift-overflow guard
        uint8_t* nb = (uint8_t*)realloc(d->buf, ncap);
        if (!nb) return; // OOM → drop (callback will EAGAIN; mpegts resyncs)
        d->buf = nb; d->cap = ncap;
    }
    memcpy(d->buf + d->len, ptr, n); d->len += n;
}

// Mark true server-close: the read callback may now flush the tail + return AVERROR_EOF.
void ferrite_demux_eof(RDDemux* d) { if (d) d->eof = 1; }

// Unread bytes currently held in the fed ring — the live worker tracks the peak to PROVE the
// ring stays bounded (strict read-on-EAGAIN keeps it ~one network chunk).
int ferrite_demux_buffered(RDDemux* d) { return d ? (int)(d->len - d->pos) : 0; }

// Opt-in cap on the unread backlog (bytes); 0 = unbounded (default). See ferrite_demux_feed.
void ferrite_demux_set_max_buffered(RDDemux* d, uint32_t max) { if (d) d->max_buffered = max; }

// Open the mpegts demuxer on the fed ring AFTER a startup window is buffered. Skips the format
// probe (explicit mpegts iformat) and find_stream_info (the software decoder gets codec_id from
// the PMT and width/SPS from the bitstream), so open never trips on EAGAIN. Returns 0 on success.
// Adopt the first video + first audio stream the PMT reveals. mpegts opens with AVFMTCTX_NOHEADER,
// so on a cold-start null-packet preamble (some servers emit a PID-0x1FFF keepalive before the real
// PAT/PMT) the streams don't exist yet at open — ferrite_demux_step re-runs this until both are found.
// Idempotent once set: never re-picks an already-chosen index, so no mid-stream index thrash.
static void ferrite_demux_select(RDDemux* d) {
    for (unsigned i = 0; i < d->fmt->nb_streams; i++) {
        enum AVMediaType t = d->fmt->streams[i]->codecpar->codec_type;
        if (t == AVMEDIA_TYPE_VIDEO && d->vstream < 0) d->vstream = (int)i;
        if (t == AVMEDIA_TYPE_AUDIO && d->astream < 0) d->astream = (int)i;
    }
}

int ferrite_demux_open(RDDemux* d) {
    if (!d) return -1;
    if (d->fmt) return 0; // already open
    if (d->avio) { av_freep(&d->avio->buffer); avio_context_free(&d->avio); } // stale avio from a prior failed open
    size_t bufsz = 1 << 16;
    uint8_t* avbuf = (uint8_t*)av_malloc(bufsz);
    d->avio = avbuf ? avio_alloc_context(avbuf, (int)bufsz, 0, d, ferrite_io_read_stream, NULL, NULL) : NULL;
    d->fmt = avformat_alloc_context();
    if (!d->avio || !d->fmt) { // keep the (fmt!=NULL ⇒ avio!=NULL) invariant ferrite_demux_step relies on
        if (d->avio) { av_freep(&d->avio->buffer); avio_context_free(&d->avio); }
        else if (avbuf) av_free(avbuf);                 // avio_alloc_context failed → avbuf still loose
        if (d->fmt) { avformat_free_context(d->fmt); d->fmt = NULL; }
        return -1;
    }
    d->fmt->pb = d->avio;
    d->fmt->probesize = 256 * 1024; // bound the PAT/PMT scan at open
    const AVInputFormat* mpegts = av_find_input_format("mpegts");
    if (avformat_open_input(&d->fmt, NULL, mpegts, NULL) < 0) { d->fmt = NULL; return -1; } // frees+NULLs d->fmt; avio kept (CUSTOM_IO)
    ferrite_demux_select(d); // may find zero streams on a null-only open window — then adopted lazily in ferrite_demux_step
    return 0;
}

// Codec ids discovered from the PMT (call after ferrite_demux_open). 0 = none / not yet seen.
int ferrite_demux_vcodec(RDDemux* d) { return (d && d->vstream >= 0) ? d->fmt->streams[d->vstream]->codecpar->codec_id : 0; }
int ferrite_demux_acodec(RDDemux* d) { return (d && d->astream >= 0) ? d->fmt->streams[d->astream]->codecpar->codec_id : 0; }

// Live param-set resolution. The streaming demuxer opens WITHOUT find_stream_info (mpegts is
// headerless + EAGAIN-fed), so the video stream's codecpar carries NO extradata — a bare decoder
// (ferrite_vdec_new) must glean VPS/SPS/PPS from the in-band Annex-B stream. For streams whose param
// sets are sparse (only before each IDR), a decoder built at a mid-GOP join floods "[hevc] PPS id out
// of range" until the next keyframe; with extradata it instead has the param sets up front (matching the
// probing/VOD path, which find_stream_info resolves). We pull the in-band param sets into
// codecpar->extradata with the extract_extradata BSF — FFmpeg-native, no full find_stream_info, no
// hand-rolled NAL parsing. The OUTPUT is Annex-B (start-code NALs), exactly what avcodec expects as
// extradata for mpegts-sourced H.264/HEVC, so ferrite_vdec_new_from_demux then builds the SW decoder
// WITH the param sets (and ferrite_demux_v_extradata exposes them for any other consumer). Bounded: runs
// only until the first param-set-bearing video packet (≤ one GOP), then frees the BSF — minimal startup
// cost since the param sets arrive with the keyframe. A CLONE is filtered so the packet returned to the
// caller is untouched (the BSF leaves the in-band copies in place; remove defaults off).
static void streaming_capture_extradata(RDDemux* d) {
    if (d->ed_done || d->vstream < 0 || !d->fmt) return;
    AVStream* st = d->fmt->streams[d->vstream];
    if (st->codecpar->extradata_size > 0) { d->ed_done = 1; return; } // already resolved
    if (!d->ed_bsf) {
        const AVBitStreamFilter* f = av_bsf_get_by_name("extract_extradata");
        if (!f) { d->ed_done = 1; return; }                            // not compiled in → in-band param sets only
        if (av_bsf_alloc(f, &d->ed_bsf) < 0) { d->ed_bsf = NULL; d->ed_done = 1; return; }
        if (avcodec_parameters_copy(d->ed_bsf->par_in, st->codecpar) < 0 || av_bsf_init(d->ed_bsf) < 0) {
            av_bsf_free(&d->ed_bsf); d->ed_done = 1; return;
        }
    }
    AVPacket* clone = av_packet_clone(d->pkt);                         // filter a copy; d->pkt is returned to the caller
    if (!clone) return;
    if (av_bsf_send_packet(d->ed_bsf, clone) < 0) { av_packet_free(&clone); return; }
    av_packet_free(&clone);                                            // send_packet moved the ref out
    AVPacket* out = av_packet_alloc();
    if (!out) return;
    while (av_bsf_receive_packet(d->ed_bsf, out) == 0) {
        size_t sz = 0;
        const uint8_t* ed = av_packet_get_side_data(out, AV_PKT_DATA_NEW_EXTRADATA, &sz);
        if (ed && sz > 0) {
            uint8_t* buf = (uint8_t*)av_malloc(sz + AV_INPUT_BUFFER_PADDING_SIZE);
            if (buf) {
                memcpy(buf, ed, sz);
                memset(buf + sz, 0, AV_INPUT_BUFFER_PADDING_SIZE);
                av_freep(&st->codecpar->extradata);
                st->codecpar->extradata = buf;
                st->codecpar->extradata_size = (int)sz;
                d->ed_done = 1;
            }
        }
        av_packet_unref(out);
    }
    av_packet_free(&out);
    if (d->ed_done) av_bsf_free(&d->ed_bsf);                           // captured → stop filtering
}

// Resolved video parameter sets (Annex-B extradata) — 0/empty until streaming_capture_extradata pulls
// them from the in-band stream (live) or find_stream_info fills them (VOD/file). For consumers that want
// the param sets directly (e.g. building a WebCodecs config).
const uint8_t* ferrite_demux_v_extradata(RDDemux* d)  { return (d && d->vstream >= 0 && d->fmt) ? d->fmt->streams[d->vstream]->codecpar->extradata      : 0; }
int            ferrite_demux_v_extradata_size(RDDemux* d) { return (d && d->vstream >= 0 && d->fmt) ? d->fmt->streams[d->vstream]->codecpar->extradata_size : 0; }

// Drop the captured video extradata and re-arm the BSF — call on a mid-stream codec change so the NEW
// codec resolves its OWN param sets instead of inheriting the previous codec's (stale) extradata.
void ferrite_demux_reset_v_extradata(RDDemux* d) {
    if (!d) return;
    if (d->ed_bsf) av_bsf_free(&d->ed_bsf);
    d->ed_done = 0;
    if (d->vstream >= 0 && d->fmt) {
        AVCodecParameters* p = d->fmt->streams[d->vstream]->codecpar;
        av_freep(&p->extradata);
        p->extradata_size = 0;
    }
}

int ferrite_demux_step(RDDemux* d) {
    if (!d || !d->fmt) return -1;
    // Streaming: a prior EAGAIN latched pb->eof_reached + pb->error sticky (FFmpeg 8.0 aviobuf);
    // clear them before each retry or fill_buffer short-circuits and never re-reads.
    if (d->streaming) { d->avio->eof_reached = 0; d->avio->error = 0; }
    av_packet_unref(d->pkt);
    int r = av_read_frame(d->fmt, d->pkt);
    if (r == AVERROR(EAGAIN)) return 2; // transient underrun → feed more bytes, then retry
    if (r == AVERROR_EOF) return 0;     // true EOF
    if (r < 0) return -1;
    // A mid-PES underrun makes mpegts flush the partial PES as a (truncated, often CORRUPT-unflagged)
    // packet and set pb->error=EAGAIN instead of returning EAGAIN. Drop it and ask for more bytes; the
    // next PES start re-syncs once the rest arrives. (pb->error is cleared at the top of the next call,
    // and stays 0 at true EOF — fill_buffer sets only eof_reached there — so the final packet survives.)
    if (d->streaming && d->avio->error == AVERROR(EAGAIN)) { av_packet_unref(d->pkt); return 2; }
    // Cold start: adopt streams the PMT created after a null-only open window, until both are found.
    if (d->streaming && (d->vstream < 0 || d->astream < 0)) ferrite_demux_select(d);
    // Pull the in-band VPS/SPS/PPS into codecpar->extradata once, so the SW decoder can be built
    // WITH the param sets (ferrite_vdec_new_from_demux) instead of gleaning them mid-stream. Bounded to
    // the first param-set-bearing video packet; a no-op afterwards (ed_done) and on the VOD/file path.
    if (d->streaming && !d->ed_done && d->pkt->stream_index == d->vstream) streaming_capture_extradata(d);
    return 1;
}
int ferrite_demux_pkt_stream(RDDemux* d) {
    if (d->pkt->stream_index == d->vstream) return 0;
    if (d->pkt->stream_index == d->astream) return 1;
    return -1;
}
const uint8_t* ferrite_demux_pkt_data(RDDemux* d) { return d->pkt->data; }
uint32_t       ferrite_demux_pkt_size(RDDemux* d) { return (uint32_t)d->pkt->size; }
static int64_t to_us(RDDemux* d, int64_t ts) {
    if (ts == AV_NOPTS_VALUE) return INT64_MIN;
    AVRational tb = d->fmt->streams[d->pkt->stream_index]->time_base;
    return av_rescale_q(ts, tb, (AVRational){1, 1000000});
}
int64_t ferrite_demux_pkt_pts_us(RDDemux* d) { return to_us(d, d->pkt->pts); }
int64_t ferrite_demux_pkt_dts_us(RDDemux* d) { return to_us(d, d->pkt->dts); }
// Current packet's keyframe flag (AV_PKT_FLAG_KEY) — WebCodecs requires correct Key/Delta tagging.
int ferrite_demux_pkt_is_key(RDDemux* d) { return (d && d->pkt && (d->pkt->flags & AV_PKT_FLAG_KEY)) ? 1 : 0; }
// Video stream codecpar profile/level (FF_PROFILE_UNKNOWN = -99) — builds the WebCodecs avc1.* string.
int ferrite_demux_v_profile(RDDemux* d) { return (d && d->vstream >= 0) ? d->fmt->streams[d->vstream]->codecpar->profile : -99; }
int ferrite_demux_v_level(RDDemux* d)   { return (d && d->vstream >= 0) ? d->fmt->streams[d->vstream]->codecpar->level   : -99; }

// ===================== AUDIO =====================
struct RDAudio {
    AVCodecContext* ctx;
    SwrContext* swr;
    AVFrame* frame;
    float* scratch; int scratch_cap;   // floats
    int out_samples, rate, channels;
    int64_t pts_us;
};

void ferrite_audio_free(RDAudio* a) {
    if (!a) return;
    if (a->frame) av_frame_free(&a->frame);
    if (a->swr) swr_free(&a->swr);
    if (a->ctx) avcodec_free_context(&a->ctx);
    free(a->scratch);
    free(a);
}

// Shared audio open. par != NULL copies codecpar (incl. extradata) into the context — REQUIRED for
// MP4/MKV raw AAC (the AudioSpecificConfig lives in extradata, not inline like mpegts ADTS). par == NULL
// is the bare live path (codec_id only; mpegts AAC is ADTS-framed → self-describing).
static RDAudio* audio_open(const AVCodec* dec, AVCodecParameters* par) {
    if (!dec) return NULL;
    RDAudio* a = (RDAudio*)calloc(1, sizeof(RDAudio));
    if (!a) return NULL;
    a->ctx = avcodec_alloc_context3(dec);
    if (!a->ctx
        || (par && avcodec_parameters_to_context(a->ctx, par) < 0)
        || avcodec_open2(a->ctx, dec, NULL) < 0) { ferrite_audio_free(a); return NULL; }
    a->frame = av_frame_alloc();
    return a;
}

RDAudio* ferrite_audio_new(int codec_id) {
    return audio_open(avcodec_find_decoder((enum AVCodecID)codec_id), NULL);
}

// VOD/file path: build the audio decoder from the demuxer's chosen audio stream (carries extradata).
RDAudio* ferrite_audio_new_from_demux(RDDemux* d) {
    if (!d || !d->fmt || d->astream < 0) return NULL;
    AVCodecParameters* par = d->fmt->streams[d->astream]->codecpar;
    return audio_open(avcodec_find_decoder(par->codec_id), par);
}

int ferrite_audio_push(RDAudio* a, const uint8_t* data, uint32_t len, int64_t pts_us) {
    if (!a) return -1;
    if (!data || len == 0) return avcodec_send_packet(a->ctx, NULL) >= 0 ? 1 : -1; // EOF drain
    AVPacket* p = av_packet_alloc();
    if (!p || av_new_packet(p, (int)len) < 0) { if (p) av_packet_free(&p); return -1; }
    memcpy(p->data, data, len);
    p->pts = pts_us; p->dts = pts_us;
    p->time_base = (AVRational){1, 1000000};   // PTS already in µs -> frame->pts stays µs
    int r = avcodec_send_packet(a->ctx, p);
    av_packet_free(&p);
    if (r == 0) return 1;
    if (r == AVERROR(EAGAIN)) return 0;
    return -1;
}

int ferrite_audio_step(RDAudio* a) {
    if (!a) return -1;
    int r = avcodec_receive_frame(a->ctx, a->frame);
    if (r == AVERROR(EAGAIN)) return 0;
    if (r < 0) return -1;   // EOF or error
    a->rate = a->frame->sample_rate;
    a->channels = a->frame->ch_layout.nb_channels;
    a->pts_us = (a->frame->pts == AV_NOPTS_VALUE) ? INT64_MIN : a->frame->pts;
    if (!a->swr) {
        if (swr_alloc_set_opts2(&a->swr,
                &a->frame->ch_layout, AV_SAMPLE_FMT_FLT, a->rate,
                &a->frame->ch_layout, (enum AVSampleFormat)a->frame->format, a->rate,
                0, NULL) < 0 || swr_init(a->swr) < 0) {
            return -1;
        }
    }
    int need = a->frame->nb_samples * a->channels;
    if (a->scratch_cap < need) {
        free(a->scratch);
        a->scratch = (float*)malloc((size_t)need * sizeof(float));
        a->scratch_cap = a->scratch ? need : 0;
        if (!a->scratch) return -1;
    }
    uint8_t* out = (uint8_t*)a->scratch;
    int got = swr_convert(a->swr, &out, a->frame->nb_samples,
                          (const uint8_t**)a->frame->extended_data, a->frame->nb_samples);
    if (got < 0) return -1;
    a->out_samples = got;
    return 1;
}
const float* ferrite_audio_interleaved(RDAudio* a) { return a->scratch; }
uint32_t     ferrite_audio_samples(RDAudio* a) { return (uint32_t)a->out_samples; }
uint32_t     ferrite_audio_rate(RDAudio* a) { return (uint32_t)a->rate; }
uint32_t     ferrite_audio_channels(RDAudio* a) { return (uint32_t)a->channels; }
int64_t      ferrite_audio_pts_us(RDAudio* a) { return a->pts_us; }

// ===================== VIDEO (generic avcodec decode) =====================
struct RDVdec {
    AVCodecContext* ctx;
    AVFrame* frame;
    int w, h;
    int64_t pts_us;
    uint8_t* scratch[3]; int scratch_sz[3]; /* tight 8-bit planes (ferrite_vdec_plane8) */
    /* Deinterlace (avfilter): buffersrc -> bwdif (send_frame) -> buffersink. deint_mode:
     * 0=off 1=auto (bwdif, flagged frames only) 3=bwdif (all frames). (yadif removed — not compiled in.)
     * Graph built lazily on the first frame, rebuilt on format change. */
    int deint_mode;
    AVFilterGraph* fg;
    AVFilterContext* fsrc;
    AVFilterContext* fsink;
    AVFrame* filt;
    int fg_w, fg_h, fg_fmt;
    /* Deint retry-budget: when vdec_build_filter fails we bypass deint for the current
     * geometry but KEEP deint_mode, retrying up to DEINT_RETRY_BUDGET times per geometry and again
     * on the next format change — instead of permanently zeroing the mode. deint_failed is surfaced
     * to the UI ("deint n/a") via ferrite_vdec_deint_failed. */
    int deint_failed;   /* 1 = graph build failed for the current geometry → bypassing */
    int deint_retries;  /* remaining build attempts for the current geometry */
};
#define DEINT_RETRY_BUDGET 3

// Shared video open. par != NULL copies codecpar (incl. extradata) into the context — REQUIRED for
// MP4/MKV, where H.264/HEVC NALs are LENGTH-PREFIXED (AVCC/HVCC) and the SPS/PPS/VPS live in extradata;
// with extradata set, the decoder reads nal_length_size and parses length-prefixed packets natively.
// par == NULL is the bare live path (codec_id only; mpegts video is Annex-B with inline SPS/PPS).
static RDVdec* vdec_open(const AVCodec* dec, AVCodecParameters* par, int threads) {
    if (!dec) return NULL;
    RDVdec* v = (RDVdec*)calloc(1, sizeof(RDVdec));
    if (!v) return NULL;
    v->ctx = avcodec_alloc_context3(dec);
    if (!v->ctx) { ferrite_vdec_free(v); return NULL; }
    if (par && avcodec_parameters_to_context(v->ctx, par) < 0) { ferrite_vdec_free(v); return NULL; }
    if (threads > 0) {
        v->ctx->thread_count = threads;
        v->ctx->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE; // decoder uses what it supports
    }
    if (avcodec_open2(v->ctx, dec, NULL) < 0) { ferrite_vdec_free(v); return NULL; }
    v->frame = av_frame_alloc();
    if (!v->frame) { ferrite_vdec_free(v); return NULL; }
    return v;
}

RDVdec* ferrite_vdec_new(int codec_id, int threads) {
    return vdec_open(avcodec_find_decoder((enum AVCodecID)codec_id), NULL, threads);
}

// Pick a SPECIFIC decoder by name (e.g. "av1" native vs "libdav1d") — for the AV1 bench.
RDVdec* ferrite_vdec_new_by_name(const char* name, int threads) {
    return vdec_open(avcodec_find_decoder_by_name(name), NULL, threads);
}

// VOD/file path: build the video decoder from the demuxer's chosen video stream (carries the AVCC/HVCC
// extradata needed to decode length-prefixed MP4/MKV NALs). Threads as ferrite_vdec_new.
RDVdec* ferrite_vdec_new_from_demux(RDDemux* d, int threads) {
    if (!d || !d->fmt || d->vstream < 0) return NULL;
    AVCodecParameters* par = d->fmt->streams[d->vstream]->codecpar;
    return vdec_open(avcodec_find_decoder(par->codec_id), par, threads);
}

int ferrite_vdec_push(RDVdec* v, const uint8_t* data, uint32_t len, int64_t pts_us) {
    if (!v) return -1;
    if (!data || len == 0) return avcodec_send_packet(v->ctx, NULL) >= 0 ? 1 : -1; // EOF drain
    AVPacket* p = av_packet_alloc();
    if (!p || av_new_packet(p, (int)len) < 0) { if (p) av_packet_free(&p); return -1; }
    memcpy(p->data, data, len);
    p->pts = pts_us; p->dts = pts_us;
    int r = avcodec_send_packet(v->ctx, p);
    av_packet_free(&p);
    if (r == 0) return 1;
    if (r == AVERROR(EAGAIN)) return 0;
    return -1;
}

/* Build the deinterlace graph for the current frame's geometry (lazy; rebuilt on format change).
 * Always bwdif, forced to send_frame (1-in-1-out, same frame rate). Auto (mode 1) deinterlaces only
 * flagged frames; mode 3 deinterlaces all. (yadif is no longer compiled into the engine.) */
static int vdec_build_filter(RDVdec* v) {
    avfilter_graph_free(&v->fg);
    v->fg = avfilter_graph_alloc();
    if (!v->fg) return -1;
    // Cap the deint filter to 1 thread: it runs on the calling thread → draws NO emscripten pthread
    // pool worker, so the pool can be right-sized to the decoder's needs without starving deint.
    // Measured: single-threaded bwdif still runs 6-8x realtime on 1080i (the only interlaced case).
    v->fg->nb_threads = 1;
    const AVFilter* bsrc  = avfilter_get_by_name("buffer");
    const AVFilter* bsink = avfilter_get_by_name("buffersink");
    const AVFilter* deint = avfilter_get_by_name("bwdif");
    if (!bsrc || !bsink || !deint) return -1;
    AVFrame* f = v->frame;
    AVRational sar = f->sample_aspect_ratio.num ? f->sample_aspect_ratio : (AVRational){1, 1};
    char args[512];
    snprintf(args, sizeof args,
        "video_size=%dx%d:pix_fmt=%d:time_base=1/1000000:pixel_aspect=%d/%d:colorspace=%d:range=%d",
        f->width, f->height, f->format, sar.num, sar.den, f->colorspace, f->color_range);
    AVFilterContext* mid = NULL;
    int r;
    if ((r = avfilter_graph_create_filter(&v->fsrc, bsrc, "in", args, NULL, v->fg)) < 0) return r;
    /* Auto deinterlaces only flagged frames; forced modes deinterlace all. */
    const char* dopt = (v->deint_mode == 1) ? "mode=send_frame:deint=interlaced"
                                            : "mode=send_frame:deint=all";
    if ((r = avfilter_graph_create_filter(&mid, deint, "deint", dopt, NULL, v->fg)) < 0) return r;
    if ((r = avfilter_graph_create_filter(&v->fsink, bsink, "out", NULL, NULL, v->fg)) < 0) return r;
    if ((r = avfilter_link(v->fsrc, 0, mid, 0)) < 0) return r;
    if ((r = avfilter_link(mid, 0, v->fsink, 0)) < 0) return r;
    if ((r = avfilter_graph_config(v->fg, NULL)) < 0) return r;
    if (!v->filt) v->filt = av_frame_alloc();
    v->fg_w = f->width; v->fg_h = f->height; v->fg_fmt = f->format;
    return v->filt ? 0 : -1;
}

/* Toggle deinterlace mode (0=off 1=auto 3=bwdif); forces a graph rebuild next frame. Gives the new
 * mode a fresh retry-budget so a prior build failure doesn't keep deint disabled. */
void ferrite_vdec_set_deint(RDVdec* v, int mode) {
    if (!v) return;
    v->deint_mode = mode;
    v->fg_w = 0;            /* force a rebuild next frame */
    v->deint_failed = 0;    /* fresh chance for the new mode (also clears the UI flag when set to off) */
    v->deint_retries = DEINT_RETRY_BUDGET;
}

/* Did the deint graph fail to build for the current geometry (deint requested but bypassing)?
 * Surfaced to the UI as "deint n/a"; cleared on a successful (re)build, format change, or deint=off. */
int ferrite_vdec_deint_failed(RDVdec* v) { return v ? v->deint_failed : 0; }

/* DECODE-RELIEF skip controls: runtime-settable per-decode skip controls for a memory-
 * bandwidth-bound client. Both fields are read by avcodec PER FRAME, so this is honoured MID-STREAM with
 * NO re-init (no flush, no keyframe wait) — the worker re-applies it after every (re)create so the
 * choice persists across a codec change / WC→SW fallback / VOD seek.
 *  - skip_nonref: AVDISCARD_NONREF → the decoder discards non-reference frames → roughly halves the
 *    decoded-frame count AND the decode work. Safe: reference frames are intact, so no artifact build-up.
 *  - skip_loopfilter: AVDISCARD_ALL → skip the in-loop deblocking filter → cheaper decode, ALL frames
 *    kept, picture slightly softer (deblocking is a post-reconstruction smoothing pass).
 * Off (0) restores AVDISCARD_DEFAULT (decode everything / full loop filter) — the banked behaviour. */
void ferrite_vdec_set_skips(RDVdec* v, int skip_nonref, int skip_loopfilter) {
    if (!v || !v->ctx) return;
    v->ctx->skip_frame      = skip_nonref     ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
    v->ctx->skip_loop_filter = skip_loopfilter ? AVDISCARD_ALL    : AVDISCARD_DEFAULT;
}

int ferrite_vdec_step(RDVdec* v) {
    if (!v) return -1;
    int r = avcodec_receive_frame(v->ctx, v->frame);
    if (r == AVERROR(EAGAIN)) return 0;
    if (r < 0) return -1; // EOF/error (the graph's 1-frame look-ahead drops the last frame — fine)
    if (v->deint_mode != 0) {
        // Route every frame through the graph: Auto (mode 1) uses deint=interlaced (deinterlaces
        // only flagged frames, passes progressive through IN ORDER); mode 3 uses deint=all.
        int ok = 1;
        int geom_changed = (v->fg_w != v->frame->width || v->fg_h != v->frame->height
                            || v->fg_fmt != v->frame->format);
        if (geom_changed) {
            // New geometry (first frame OR a real format change): reset the retry budget so a
            // transient build failure on one format doesn't permanently disable deint for later ones.
            v->deint_retries = DEINT_RETRY_BUDGET;
            v->deint_failed = 0;
        }
        if (!v->fg || geom_changed) {
            if (v->deint_retries > 0 && vdec_build_filter(v) >= 0) {
                v->deint_failed = 0;  // graph up → deint active
            } else {
                // Build failed (or budget exhausted): bypass deint for this geometry but KEEP
                // deint_mode (retry-budget), so the next format change re-attempts. Record the failed
                // geometry so we don't realloc the graph every frame; surface "deint n/a" to the UI.
                avfilter_graph_free(&v->fg); v->fg = NULL;
                if (v->deint_retries > 0) v->deint_retries--;
                v->fg_w = v->frame->width; v->fg_h = v->frame->height; v->fg_fmt = v->frame->format;
                v->deint_failed = 1;
                ok = 0;
            }
        }
        if (ok) {
            if (av_buffersrc_add_frame_flags(v->fsrc, v->frame, AV_BUFFERSRC_FLAG_KEEP_REF) < 0) return -1;
            av_frame_unref(v->filt);
            int fr = av_buffersink_get_frame(v->fsink, v->filt);
            if (fr == AVERROR(EAGAIN)) return 0; // bwdif buffered the field; push the next packet
            if (fr < 0) return -1;
            // bwdif HALVES the output time_base (field resolution) → rescale the pts back to µs,
            // or the present clock sees doubled PTS and plays the stream at half speed.
            if (v->filt->pts != AV_NOPTS_VALUE)
                v->filt->pts = av_rescale_q(v->filt->pts, av_buffersink_get_time_base(v->fsink), (AVRational){1, 1000000});
            av_frame_unref(v->frame);
            av_frame_move_ref(v->frame, v->filt); // all getters keep reading v->frame
        }
    }
    v->w = v->frame->width;
    v->h = v->frame->height;
    v->pts_us = (v->frame->pts == AV_NOPTS_VALUE) ? INT64_MIN : v->frame->pts;
    return 1;
}

int ferrite_vdec_w(RDVdec* v) { return v ? v->w : 0; }
int ferrite_vdec_h(RDVdec* v) { return v ? v->h : 0; }
int ferrite_vdec_cw(RDVdec* v) {
    if (!v) return 0;
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)v->frame->format);
    int sw = d ? d->log2_chroma_w : 1;
    return (v->frame->width + (1 << sw) - 1) >> sw;
}
int ferrite_vdec_ch(RDVdec* v) {
    if (!v) return 0;
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)v->frame->format);
    int sh = d ? d->log2_chroma_h : 1;
    return (v->frame->height + (1 << sh) - 1) >> sh;
}

/* De-stride/downshift plane `ch` of frame `f` (10/12-bit → 8-bit by bd-8) into the caller's `dst`
 * (tight: w×h luma, cw×ch chroma). Returns bytes written. Shared by ferrite_vdec_plane8 (scratch) and
 * ferrite_vdec_pack (a worker-owned heap slot, for the zero-copy present path). */
static int pack_plane8(AVFrame* f, int ch, uint8_t* dst) {
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)f->format);
    int bd = d ? d->comp[0].depth : 8;
    int sw = (ch == 0 || !d) ? 0 : d->log2_chroma_w;
    int sh = (ch == 0 || !d) ? 0 : d->log2_chroma_h;
    int w = (f->width  + (1 << sw) - 1) >> sw;
    int h = (f->height + (1 << sh) - 1) >> sh;
    int stride = f->linesize[ch];
    const uint8_t* p = f->data[ch];
    if (bd <= 8) {
        for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * w, p + (size_t)y * stride, w);
    } else {
        uint32_t shift = (uint32_t)(bd - 8);
        for (int y = 0; y < h; y++) {
            const uint16_t* src = (const uint16_t*)(p + (size_t)y * stride);
            uint8_t* dd = dst + (size_t)y * w;
            for (int x = 0; x < w; x++) dd[x] = (uint8_t)(src[x] >> shift);
        }
    }
    return w * h;
}

/* Tight 8-bit plane `ch` of the decoded frame (de-strided; 10/12-bit downshifted by bd-8)
 * into a reusable scratch so the player presents FFmpeg frames identically across codecs.
 * Handles planar 4:2:0/4:2:2 8/10/12-bit (mainstream IPTV); exotic packed formats
 * would need swscale (deferred — YAGNI). */
const uint8_t* ferrite_vdec_plane8(RDVdec* v, int ch) {
    if (!v || ch < 0 || ch > 2) return 0;
    AVFrame* f = v->frame;
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)f->format);
    int sw = (ch == 0 || !d) ? 0 : d->log2_chroma_w;
    int sh = (ch == 0 || !d) ? 0 : d->log2_chroma_h;
    int w = (f->width  + (1 << sw) - 1) >> sw;
    int h = (f->height + (1 << sh) - 1) >> sh;
    int need = w * h;
    if (v->scratch_sz[ch] < need) {
        free(v->scratch[ch]);
        v->scratch[ch] = (uint8_t*)malloc(need);
        v->scratch_sz[ch] = v->scratch[ch] ? need : 0;
        if (!v->scratch[ch]) return 0;
    }
    pack_plane8(f, ch, v->scratch[ch]);
    return v->scratch[ch];
}

/* GPU-10-bit zero-copy present: luma bit depth (8/10/12) of the decoder's CURRENT frame. The
 * present worker picks the integer texture format (R8UI vs R16UI) + the shader's bit-scale (255 / 1023 /
 * 4095) from this. Supersedes the CPU 10→8 downshift that ferrite_vdec_pack/plane8 did (~100% of the
 * 10-bit 4K present cost) — the GPU now bit-scales for free. */
int ferrite_vdec_bitdepth(RDVdec* v) {
    if (!v || !v->frame) return 8;
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get((enum AVPixelFormat)v->frame->format);
    return d ? d->comp[0].depth : 8;
}

/* RENDER-QUALITY (color-conditioning): YUV→RGB matrix selection metadata of the decoder's CURRENT frame.
 * colorspace = AVColorSpace (matrix_coefficients): BT709=1, UNSPECIFIED=2, BT470BG=5 / SMPTE170M=6 (BT.601),
 * BT2020_NCL=9 / BT2020_CL=10 — the present worker picks the {601,709,2020} luma coefficients from this
 * (falling back on UNSPECIFIED to the resolution heuristic). color_range = AVColorRange: MPEG=1 (limited /
 * studio), JPEG=2 (full / PC), UNSPECIFIED=0 → limited default. These are constant for a stream but read
 * per-frame off the live AVFrame (cheap enum read; no decode-path effect). */
int ferrite_vdec_colorspace(RDVdec* v) {
    return (v && v->frame) ? (int)v->frame->colorspace : 2 /* AVCOL_SPC_UNSPECIFIED */;
}
int ferrite_vdec_color_range(RDVdec* v) {
    return (v && v->frame) ? (int)v->frame->color_range : 0 /* AVCOL_RANGE_UNSPECIFIED */;
}
/* HDR transfer characteristic (AVColorTransferCharacteristic) of the CURRENT frame: BT709=1, UNSPECIFIED=2,
 * SMPTE2084=16 (PQ), ARIB_STD_B67=18 (HLG). The present worker tone-maps PQ/HLG (with BT.2020 primaries) to
 * BT.709 for SDR display; everything else is treated as SDR (no tone-map). Per-frame enum read (cheap). */
int ferrite_vdec_color_trc(RDVdec* v) {
    return (v && v->frame) ? (int)v->frame->color_trc : 2 /* AVCOL_TRC_UNSPECIFIED */;
}

/* DISPLAY ASPECT (anamorphic): the sample (pixel) aspect ratio of the CURRENT frame — DAR = w*SAR/h.
 * 1:1 for square-pixel content (most modern IPTV + the test fixtures); non-1:1 for anamorphic (1440x1080
 * SAR 4:3 → DAR 16:9, 720x576 SAR 16:11 → 16:9). Read per-frame off the live AVFrame (cheap, zero decode
 * cost); an unspecified/invalid SAR (num<=0) reports 1:1 so the player falls back to the coded aspect. */
int ferrite_vdec_sar_num(RDVdec* v) {
    return (v && v->frame && v->frame->sample_aspect_ratio.num > 0) ? v->frame->sample_aspect_ratio.num : 1;
}
int ferrite_vdec_sar_den(RDVdec* v) {
    return (v && v->frame && v->frame->sample_aspect_ratio.num > 0 && v->frame->sample_aspect_ratio.den > 0)
        ? v->frame->sample_aspect_ratio.den : 1;
}

/* ---- Frame-pinning: TRUE zero-copy present (supersedes ferrite_vdec_pack's heap-slot ring). ----
 * Instead of de-striding + downshifting each decoded frame into a tight 8-bit slot (the per-sample
 * 10→8-bit scalar loop that capped 10-bit 4K at ~30 fps), we HOLD a ref on the decoder's output AVFrame:
 * av_frame_ref bumps the underlying buffers' refcount so the planes stay valid — at their NATIVE stride
 * AND native bit depth — until released. The present worker uploads those planes DIRECTLY to a WebGL2
 * integer texture (R8UI/R16UI) with UNPACK_ROW_LENGTH=stride, and the shader de-strides (free, via the
 * row length) + bit-scales (free, on the GPU). NO CPU copy, NO downshift → the pipeline goes decode-bound.
 *
 * A held frame keeps the decoder from reusing that buffer, so the table is BOUNDED (HELD_CAP) to the
 * present ring + transit headroom; the worker drops (live) / blocks (VOD) when hold returns 0, exactly
 * like the old slot ring. The table is GLOBAL (one pipeline decodes at a time); av_frame_ref holds its
 * own ref on the AVBufferRefs, independent of the decoder context, so a held frame stays valid even after
 * the decoder is freed (release is always safe). release_all reclaims any in-transit holds on teardown/
 * reload (the present worker has been reset by then, so it's no longer reading them). */
#define HELD_CAP 64
static AVFrame* g_held[HELD_CAP];   /* token = index+1; 0 = invalid / table full */

/* Clone-ref the decoder's CURRENT output frame into a free slot; returns a 1-based token (0 = table full
 * / no frame / OOM). The clone refs the buffers, so they survive the next ferrite_vdec_step (which unrefs
 * v->frame and receives into fresh buffers). The caller reads planes/linesizes off the TOKEN, not v. */
uint32_t ferrite_vdec_hold(RDVdec* v) {
    if (!v || !v->frame) return 0;
    for (int i = 0; i < HELD_CAP; i++) {
        if (g_held[i]) continue;
        AVFrame* clone = av_frame_alloc();
        if (!clone) return 0;
        if (av_frame_ref(clone, v->frame) < 0) { av_frame_free(&clone); return 0; }
        g_held[i] = clone;
        return (uint32_t)(i + 1);
    }
    return 0;
}
static AVFrame* held_get(uint32_t token) {
    return (token >= 1 && token <= HELD_CAP) ? g_held[token - 1] : NULL;
}
/* Heap offset of held plane `idx` (0=Y,1=U,2=V) — the present worker views memory.buffer at this offset
 * (wasm32: a pointer fits in int/u32). 0 on a bad token/idx. */
int ferrite_vdec_held_plane(uint32_t token, int idx) {
    AVFrame* f = held_get(token);
    return (f && idx >= 0 && idx < 3) ? (int)(uintptr_t)f->data[idx] : 0;
}
/* Held plane `idx` stride in BYTES (present sets UNPACK_ROW_LENGTH = linesize / bytes-per-sample). */
int ferrite_vdec_held_linesize(uint32_t token, int idx) {
    AVFrame* f = held_get(token);
    return (f && idx >= 0 && idx < 3) ? f->linesize[idx] : 0;
}
/* Release one held frame: unref its buffers (the decoder may reuse them) + free the slot. Idempotent. */
void ferrite_vdec_release(uint32_t token) {
    if (token >= 1 && token <= HELD_CAP && g_held[token - 1]) av_frame_free(&g_held[token - 1]);
}
/* Release ALL held frames — called on pipeline teardown / reload, once the present worker has been reset
 * (so it is no longer uploading from any held plane). Reclaims holds still in transit when the load ended. */
void ferrite_vdec_release_all(void) {
    for (int i = 0; i < HELD_CAP; i++) if (g_held[i]) av_frame_free(&g_held[i]);
}

const uint8_t* ferrite_vdec_plane(RDVdec* v, int ch, int* out_stride) {
    if (!v || ch < 0 || ch > 2) { if (out_stride) *out_stride = 0; return 0; }
    if (out_stride) *out_stride = v->frame->linesize[ch];
    return v->frame->data[ch];
}
double ferrite_vdec_pts(RDVdec* v) { return v ? (double)v->pts_us : 0.0; }
void ferrite_vdec_free(RDVdec* v) {
    if (!v) return;
    if (v->filt) av_frame_free(&v->filt);
    if (v->fg) avfilter_graph_free(&v->fg);
    for (int i = 0; i < 3; i++) free(v->scratch[i]);
    if (v->frame) av_frame_free(&v->frame);
    if (v->ctx) avcodec_free_context(&v->ctx);
    free(v);
}
