// ferrite.h — TS-demux + video/audio-decode reactor API (the Ferrite engine, build-engine.sh).
// ferrite_* return discipline: positive = ready, 0 = EOF/need-more, <0 = error.
// All functions null-safe. PTS is delivered in MICROSECONDS (rescaled in C); audio is
// delivered as INTERLEAVED float (swresample), ready for Web Audio copyToChannel.
#ifndef FERRITE_H
#define FERRITE_H
#include <stdint.h>

typedef struct RDDemux RDDemux;
typedef struct RDAudio RDAudio;
typedef struct RDVdec RDVdec;

// --- DEMUX (one memory-AVIO context; picks the first video + first audio stream) ---
// Whole-file (finite) mode: AUTODETECTS the container (mpegts / matroska+webm / mov+mp4) + reads the
// header (find_stream_info) over a SEEKABLE AVIO. ferrite_demux_new and ferrite_demux_new_file are the
// same path (new_file is the canonical VOD name; new is kept for the fixture path).
RDDemux*       ferrite_demux_new(const uint8_t* ts, uint32_t len, int* out_vcodec, int* out_acodec);
RDDemux*       ferrite_demux_new_file(const uint8_t* data, uint32_t len, int* out_vcodec, int* out_acodec);
// Range-streamed VOD: same seekable/autodetecting whole-file demux, but the AVIO pulls bytes ON DEMAND
// from JS (Module.__ferriteRangeRead → a synchronous XHR with a Range header on the worker thread)
// instead of a pre-filled buffer — so playback/seek stream over HTTP Range like native ffmpeg, no
// whole-file prefetch. `handle` keys the JS reader; `total_size` is the file size probed up front.
RDDemux*       ferrite_demux_new_range(int handle, double total_size, int* out_vcodec, int* out_acodec);
int64_t        ferrite_demux_duration_us(RDDemux*);                 // container duration in µs (0 = unknown)
int            ferrite_demux_seek_us(RDDemux*, double ts_us, int backward); // av_seek_frame on the video stream; 0 = ok. Caller flushes its decoder. DOUBLE µs (suspending export — no i64/BigInt arg survives an Asyncify rewind).
// --- Streaming (live) variant: incrementally fed, mpegts demuxer kept. ---
RDDemux*       ferrite_demux_new_streaming(void);
void           ferrite_demux_feed(RDDemux*, const uint8_t* ptr, uint32_t len);  // append network bytes
void           ferrite_demux_eof(RDDemux*);                                     // mark true server-close
int            ferrite_demux_buffered(RDDemux*);                                // unread bytes in the fed ring (peak-track to prove boundedness)
void           ferrite_demux_set_max_buffered(RDDemux*, uint32_t max);          // opt-in live cap (0 = unbounded); sheds oldest on overflow
int            ferrite_demux_open(RDDemux*);                                    // open once a startup window is buffered; 0 = ok (streams may still be empty)
int            ferrite_demux_vcodec(RDDemux*);                                  // codec_id once the PMT is seen; 0 until then — POLL each step (cold-start null preamble)
int            ferrite_demux_acodec(RDDemux*);                                  // poll likewise; create the decoder lazily when this turns > 0
int            ferrite_demux_step(RDDemux*);          // 1 = packet, 2 = need-more (streaming), 0 = EOF, -1 = error
int            ferrite_demux_pkt_stream(RDDemux*);     // 0 = video, 1 = audio, -1 = other
const uint8_t* ferrite_demux_pkt_data(RDDemux*);
uint32_t       ferrite_demux_pkt_size(RDDemux*);
int64_t        ferrite_demux_pkt_pts_us(RDDemux*);     // INT64_MIN if no pts
int64_t        ferrite_demux_pkt_dts_us(RDDemux*);
int            ferrite_demux_pkt_is_key(RDDemux*);     // 1 = AV_PKT_FLAG_KEY set (for WebCodecs Key/Delta)
int            ferrite_demux_v_profile(RDDemux*);      // video codecpar profile (-99 = unknown)
int            ferrite_demux_v_level(RDDemux*);        // video codecpar level   (-99 = unknown)
int            ferrite_demux_v_sar_num(RDDemux*);      // pixel aspect (SAR) via one-shot keyframe decode; 1 if square/unknown
int            ferrite_demux_v_sar_den(RDDemux*);      // — all-codec (the WebCodecs tier has no FFmpeg decoder to read it off)
const uint8_t* ferrite_demux_v_extradata(RDDemux*);    // resolved video param sets (Annex-B); 0 until captured
int            ferrite_demux_v_extradata_size(RDDemux*); // extradata byte count; 0 until captured
void           ferrite_demux_reset_v_extradata(RDDemux*); // re-arm capture on a mid-stream codec change
void           ferrite_demux_free(RDDemux*);

// --- AUDIO (decode + swresample to interleaved float; one fixed codec) ---
RDAudio*       ferrite_audio_new(int codec_id);
RDAudio*       ferrite_audio_new_from_demux(RDDemux*);  // VOD/file: copies codecpar extradata (raw AAC ASC etc.)
int            ferrite_audio_push(RDAudio*, const uint8_t* pkt, uint32_t len, int64_t pts_us); // pkt=NULL/len=0 => EOF drain. 1=ok,0=again,-1=err
int            ferrite_audio_step(RDAudio*);           // 1 = frame ready, 0 = need-more, -1 = drained/error
int            ferrite_audio_flush(RDAudio*);          // EOF: drain swr delay line. 1 = final chunk ready, 0 = none
const float*   ferrite_audio_interleaved(RDAudio*);    // samples*channels floats, valid until next step
uint32_t       ferrite_audio_samples(RDAudio*);        // per-channel sample count
uint32_t       ferrite_audio_rate(RDAudio*);           // OUTPUT rate (after resample to the requested out-rate)
uint32_t       ferrite_audio_channels(RDAudio*);       // OUTPUT channels after engine stereo downmix (= 2)
uint32_t       ferrite_audio_src_channels(RDAudio*);   // decoded/source channels pre-downmix (telemetry)
void           ferrite_audio_set_out_rate(RDAudio*, int rate); // 0 = passthrough; engine resamples to it
void           ferrite_audio_set_drc(RDAudio*, int mode);      // Dyna: 0=line 1=RF/heavy 2=night (universal compressor)
int64_t        ferrite_audio_pts_us(RDAudio*);
void           ferrite_audio_free(RDAudio*);

// --- VIDEO (generic FFmpeg avcodec decode) ---
// The foundation for all software codecs (HEVC, H.264, MPEG-2, ...). `threads`>0 enables
// frame+slice threading. Planes are the decoder's NATIVE format/stride (no swscale) — fine for a
// decode throughput benchmark; the player path would add swscale → I420 later.
RDVdec*        ferrite_vdec_new(int codec_id, int threads);
RDVdec*        ferrite_vdec_new_by_name(const char* name, int threads); // pick decoder by name (av1/libdav1d)
RDVdec*        ferrite_vdec_new_from_demux(RDDemux*, int threads);      // VOD/file: copies AVCC/HVCC extradata (length-prefixed MP4/MKV NALs)
int            ferrite_vdec_push(RDVdec*, const uint8_t* pkt, uint32_t len, int64_t pts_us); // pkt=NULL => EOF drain
int            ferrite_vdec_step(RDVdec*);             // 1 = frame ready, 0 = need-more, -1 = drained/error
int            ferrite_vdec_w(RDVdec*);
int            ferrite_vdec_h(RDVdec*);
int            ferrite_vdec_cw(RDVdec*);               // chroma width  (per pix-fmt subsampling)
int            ferrite_vdec_ch(RDVdec*);               // chroma height
const uint8_t* ferrite_vdec_plane(RDVdec*, int ch, int* out_stride); // native (strided) plane
const uint8_t* ferrite_vdec_plane8(RDVdec*, int ch);   // tight 8-bit plane (de-strided/downshifted)
int            ferrite_vdec_bitdepth(RDVdec*);         // current frame luma bit depth (8/10/12) → R8UI vs R16UI + bit-scale
int            ferrite_vdec_colorspace(RDVdec*);       // AVColorSpace (matrix_coefficients): 1=709 5/6=601 9/10=2020 2=unspec → YUV→RGB matrix
int            ferrite_vdec_color_range(RDVdec*);      // AVColorRange: 1=MPEG/limited 2=JPEG/full 0=unspec → range branch
// Frame-pinning (TRUE zero-copy present): hold a ref on the decoder's current output frame so the
// present worker uploads its NATIVE-stride/native-bit-depth planes straight to a WebGL2 integer texture
// (R8UI/R16UI, UNPACK_ROW_LENGTH=stride, GPU de-strides + bit-scales). No CPU copy, no 10→8 downshift.
uint32_t       ferrite_vdec_hold(RDVdec*);             // hold current frame → 1-based token (0 = table full / none)
int            ferrite_vdec_held_plane(uint32_t token, int idx);    // heap offset of held plane idx (0=Y,1=U,2=V)
int            ferrite_vdec_held_linesize(uint32_t token, int idx); // held plane idx stride in BYTES
void           ferrite_vdec_release(uint32_t token);   // release one held frame (decoder may reuse the buffer)
void           ferrite_vdec_release_all(void);         // release ALL held frames (teardown/reload, after present reset)
double         ferrite_vdec_pts(RDVdec*);              // µs, double for JS Number
void           ferrite_vdec_set_deint(RDVdec*, int mode); // deinterlace: 0=off 1=auto 3=bwdif (bwdif-only)
// DECODE-RELIEF skip controls: runtime-settable per-decode skip controls (read per-frame → honoured
// mid-stream, no re-init). skip_nonref → AVDISCARD_NONREF (~half the decoded frames + decode work);
// skip_loopfilter → AVDISCARD_ALL (skip in-loop deblock, all frames kept, slightly softer). 0/0 = default.
void           ferrite_vdec_set_skips(RDVdec*, int skip_nonref, int skip_loopfilter);
int            ferrite_vdec_deint_failed(RDVdec*);    // 1 = deint requested but the filter graph won't build
void           ferrite_vdec_free(RDVdec*);

#endif
