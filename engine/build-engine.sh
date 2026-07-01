#!/usr/bin/env bash
# Build the self-contained Ferrite engine wasm: FFmpeg (ferrite decode subset) + ferrite.c
#   ferrite.c = TS demux + video (ferrite_vdec) + audio (ferrite_audio) decode + avfilter deint, all FFmpeg avcodec
#   -> ferrite.{mjs,wasm}  (MODULARIZE + EXPORT_ES6 + -pthread + SIMD), imported by the ferrite.js worker.
#
# Self-contained: NO external source dependency. Builds a pristine FFmpeg (version read from the
# engine-local ./ffmpeg-version file) to wasm via emscripten, with the ferrite decode subset (mpegts
# demux + matroska/mov for VOD; hevc/h264/mpeg2 + aac/ac3/eac3/mp2/mp3 decoders; bwdif/format/aresample
# filters; swresample; no swscale, no muxers). Standard emscripten pthreads (ferrite runs cross-origin
# isolated -> real Worker threads -> parallel decode; needed for realtime 4K HEVC software decode).
#
# The build writes the matched pair DIRECTLY into ../assets/ (the vendored, npm-published prebuilt)
# so the .mjs and .wasm are always produced together and never drift.
#
# Prereq: emsdk active. The script sources ~/emsdk/emsdk_env.sh (or $EMSDK_ROOT/emsdk_env.sh).
# Clean rebuild: rm -rf engine/build
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"      # repo root
FFVER="$(tr -d ' \n' < "$HERE/ffmpeg-version")"   # pinned FFmpeg version (engine-local single source of truth)
CACHE="$ROOT/.ffmpeg-cache"         # gitignored: downloaded FFmpeg tarball cache
TAR="$CACHE/ffmpeg-$FFVER.tar.xz"   # downloaded ONCE; each build extracts its own pristine copy
BUILD="$HERE/build"                 # gitignored: FFmpeg source + wasm .a's
FFSRC="$BUILD/ffmpeg-$FFVER"
BT="$BUILD/build-thr"               # FFmpeg wasm build tree
INSTALL="$BT/install"
HASH_MARKER="$BUILD/.config_hash"
OUT="$ROOT/assets"                  # the vendored, npm-published prebuilt engine (matched pair)
JOBS="$(nproc)"
# Opt level for the whole engine (FFmpeg .a's + ferrite.o + link), single source of truth. Override
# with FERRITE_OPT=Oz|Os|O2|O3 to trade wasm size against software-decode headroom; the value is folded
# into the config hash below so changing it forces a clean FFmpeg re-extract+rebuild (no stale .a reuse).
# DEFAULT = -O2, chosen on
# REAL-CLIENT browser data: a no-HW-HEVC client clears realtime by only ~1.5-2× (vs the node box's 3-4×),
# so decode headroom is scarcer than the box implied and is the valuable axis — it is a PERSISTENT
# every-frame property, whereas binary size is a one-time fetch (cache-amortized) + heap-dwarfed memory.
# -O2 sits at the efficiency knee: ~2.96 MiB / ~204 fps node (~98 fps / 1.97× browser) ≈ near-O3 headroom
# (O3→O2 is nearly free; O2→Os spends real decode margin: 1.97×→1.68×) for a trivial one-time size cost.
OPT="${FERRITE_OPT:-O2}"
case "$OPT" in O0|O1|O2|O3|Os|Oz) ;; *) echo "ERROR: FERRITE_OPT must be one of O0/O1/O2/O3/Os/Oz (got '$OPT')" >&2; exit 1;; esac
echo "opt level: -$OPT"

# Strip absolute build paths out of the published binary. FFmpeg's sources expand __FILE__ (av_log /
# av_assert messages) into rodata, so an un-remapped build bakes the local absolute path — and thus the
# builder's username — into ferrite.wasm. -ffile-prefix-map rewrites those prefixes (both __FILE__ and any
# debug paths) to neutral relative roots at compile time, so the binary is reproducible and carries no
# local path. Applied to the FFmpeg .a's AND ferrite.o AND the link. (Paired with -g0 below for a clean,
# stripped RELEASE build — no DWARF, no symbol/name section.)
PREFIX_MAP="-ffile-prefix-map=$FFSRC=ffmpeg-$FFVER -ffile-prefix-map=$BUILD=. -ffile-prefix-map=$HERE=. -ffile-prefix-map=$ROOT=."

# --- emsdk ---
if ! command -v emcc >/dev/null 2>&1; then
  EMSDK_ENV="${EMSDK_ROOT:-$HOME/emsdk}/emsdk_env.sh"
  if [ -f "$EMSDK_ENV" ]; then
    # shellcheck disable=SC1090
    source "$EMSDK_ENV" >/dev/null 2>&1
  else
    echo "ERROR: emcc not found. Install emsdk or set EMSDK_ROOT." >&2
    exit 1
  fi
fi
echo "emcc: $(emcc --version | head -1)"

mkdir -p "$BUILD" "$CACHE" "$OUT"

# --- 1. fetch the FFmpeg source tarball into the cache (downloaded ONCE). Override with
#        FERRITE_FFMPEG_TARBALL to seed the cache for offline/CI. ---
if [ -n "${FERRITE_FFMPEG_TARBALL:-}" ]; then
  cp -f "$FERRITE_FFMPEG_TARBALL" "$TAR"
elif [ ! -f "$TAR" ]; then
  echo "Downloading FFmpeg $FFVER to cache ($CACHE) ..."
  curl -fL "https://ffmpeg.org/releases/ffmpeg-$FFVER.tar.xz" -o "$TAR"
fi

# --- 2. hash-gate: re-extract pristine + reconfigure when the configure flags (this script) OR the
#        pinned FFmpeg version change. Folding $FFVER into the hash forces a clean re-extract on a
#        version bump (the source dir name changes, but a stale build/ from the old version would
#        otherwise be reused if only the marker existed). ---
NEW_HASH="$(printf '%s\n%s\n%s' "$(sha256sum "$HERE/build-engine.sh" | cut -d' ' -f1)" "$FFVER" "$OPT" | sha256sum | cut -d' ' -f1)"
OLD_HASH="$(cat "$HASH_MARKER" 2>/dev/null || echo none)"
if [ ! -d "$FFSRC" ] || [ "$NEW_HASH" != "$OLD_HASH" ]; then
  echo "Extracting pristine FFmpeg $FFVER ..."
  rm -rf "$FFSRC" "$BT"
  mkdir -p "$FFSRC"
  tar -xf "$TAR" -C "$FFSRC" --strip-components=1
fi

# --- 3. configure + build the wasm FFmpeg subset (pristine $FFVER, no patches) ---
if [ ! -f "$INSTALL/lib/libavcodec.a" ]; then
  mkdir -p "$BT"
  cd "$BT"
  emconfigure "$FFSRC/configure" \
    --prefix="$INSTALL" \
    --target-os=none --enable-cross-compile --arch=emscripten \
    --cc=emcc --ranlib=emranlib --nm=emnm --ar=emar \
    --disable-x86asm --disable-inline-asm --disable-runtime-cpudetect \
    --disable-doc --disable-stripping --disable-programs \
    --disable-ffplay --disable-ffprobe \
    --disable-network --disable-iconv --disable-xlib --disable-sdl2 --disable-zlib \
    --disable-everything --disable-swscale \
    --enable-swresample \
    --enable-pthreads \
    --extra-cflags="-pthread -$OPT -msimd128 -g0 $PREFIX_MAP" \
    --extra-ldflags="-pthread" \
    --optflags=-$OPT \
    --enable-demuxer=mpegts \
    `# VOD/file containers (probe by 'mod ferrite_demux_new'): matroska covers .mkv AND .webm; mov` \
    `# covers .mp4/.mov/.m4a. IPTV VOD/Series often serve Matroska even when the URL claims .mp4,` \
    `# so the probe routes by content, not extension. The live mpegts streaming path` \
    `# (ferrite_demux_new_streaming) still forces the mpegts iformat — untouched.` \
    --enable-demuxer=matroska --enable-demuxer=mov \
    --enable-decoder=aac --enable-parser=aac \
    --enable-decoder=ac3 --enable-parser=ac3 \
    --enable-decoder=eac3 \
    --enable-decoder=mp2 --enable-decoder=mp3 --enable-parser=mpegaudio \
    --enable-decoder=hevc --enable-parser=hevc \
    --enable-decoder=h264 --enable-parser=h264 \
    --enable-decoder=mpeg2video --enable-parser=mpegvideo \
    `# extract_extradata: the ONLY bsf ferrite.c instantiates (streaming param-set pull, av_bsf_get_by_name).` \
    `# hevc_metadata/h264_metadata were enabled speculatively and are never referenced — dropped (pure size win).` \
    --enable-bsf=extract_extradata \
    `# iso_writer (internal CONFIG_EXTRA symbol; not CLI-settable, only SELECTED by a muxer): compiles` \
    `# libavformat's avc.o/hevc.o box-writers. ferrite.c reuses ff_isom_write_{hvcc,avcc} to build the` \
    `# WebCodecs config record (hvcC/avcC) from live Annex-B — the SAME functions the mov muxer uses, no` \
    `# hand-rolled NAL parsing. (Per-AU reframing uses ff_nal_parse_units_buf from base nal.o.) flv is the` \
    `# LEANEST selector (flv_muxer_select="aac_adtstoasc_bsf iso_writer"); the muxer .o itself is dead-code-` \
    `# eliminated from the wasm (ferrite.c never calls it), so only the box-writers land → proportional size.` \
    --enable-muxer=flv \
    --enable-filter=bwdif --enable-filter=format --enable-filter=aresample
  emmake make -j"$JOBS"
  emmake make install
  echo "$NEW_HASH" > "$HASH_MARKER"
fi

# --- 4. compile ferrite.c + link the engine module (directly into ../assets/) ---
cd "$HERE"
INC="-I$FFSRC -I$INSTALL/include"
emcc ferrite.c -c -o "$BUILD/ferrite.o" $INC -$OPT -msimd128 -pthread -g0 $PREFIX_MAP

emcc "$BUILD/ferrite.o" \
  "$INSTALL/lib/libavformat.a" \
  "$INSTALL/lib/libavcodec.a" \
  "$INSTALL/lib/libavfilter.a" \
  "$INSTALL/lib/libswresample.a" \
  "$INSTALL/lib/libavutil.a" \
  $INC -$OPT -msimd128 -pthread -g0 -sASSERTIONS=0 $PREFIX_MAP \
  `# -g0 + -sASSERTIONS=0 + the -ffile-prefix-map above = a stripped RELEASE wasm: no DWARF, no name/symbol` \
  `# section, no embedded local build paths. (-O2 already runs Binaryen wasm-opt; -g0 makes the strip explicit.)` \
  `# PTHREAD_POOL_SIZE is sized per-instance at runtime via the factory moduleArg "ferritePool"` \
  `# (SW decode passes decode-threads + 2; WC demux passes 2) — so each ferrite instance pre-spawns` \
  `# only the workers it needs instead of a fixed 24, cutting idle memory (each pooled worker holds a` \
  `# 4 MiB stack). The deint filter is capped to 1 thread (ferrite.c) so it never draws from the pool.` \
  `# ||10 = the 8-thread default + 2 fallback if a caller omits the arg. Emscripten emits this as` \
  `# 'var pthreadPoolSize = (Module["ferritePool"]||10)' inside initMainThread (after the moduleArg` \
  `# merge), so the per-instance value is honoured.` \
  -sPTHREAD_POOL_SIZE='(Module["ferritePool"]||10)' -sDEFAULT_PTHREAD_STACK_SIZE=4194304 -sSTACK_SIZE=8388608 \
  `# GROWABLE shared memory: start small (256 MiB) and grow on demand up to a 2 GiB ceiling, instead` \
  `# of reserving a fixed 2 GiB SharedArrayBuffer per instance up front. A fixed 2 GiB floor made every` \
  `# ferrite instance (and every orphaned pthread) pin 2 GiB regardless of use, capping concurrency.` \
  `# Growth REPLACES the SharedArrayBuffer, so emscripten's updateMemoryViews() reassigns Module.HEAPU8` \
  `# on each grow — callers MUST read Module.HEAPU8 FRESH per access (never cache the view across an` \
  `# allocating call). ferrite-bindings.ts re-reads on every access (see its notes).` \
  `# MAXIMUM_MEMORY is mandatory with -pthread (the WebAssembly.Memory is created shared+maximum).` \
  `# INITIAL_MEMORY here is only the engine's import MINIMUM (a small 16 MiB floor ≈ static data + the main` \
  `# stack — the proven minimum). The HOST (ferrite-bindings.ts loadFerrite) PROVIDES the real per-load` \
  `# WebAssembly.Memory above this floor: a 256 MiB warm initial (the decode realm starts warm for 4K/HEVC)` \
  `# and a 1.5 GiB maximum. GROWABLE from the host initial up to that 1.5 GiB ceiling. We briefly ran 4 GiB` \
  `# to prove the old "2 GiB wall" was a JS SIGN bug (a >2 GiB pointer returns signed-negative →` \
  `# new Uint16Array(buffer, negOffset) throws), not a wasm32 limit — V8 (Chrome M83, 2020) made wasm heap` \
  `# access unsigned. The fix that MATTERS is reading engine POINTERS as UNSIGNED (ptr >>> 0) in` \
  `# ferrite-bindings.ts, kept permanently. Measured peak is only ~1.1 GiB (geometry-bound 4K/HEVC, reached` \
  `# at init, no creep), so 1.5 GiB is ample — and for SHARED memory the MAXIMUM is reserved as virtual` \
  `# address space up front, so trimming the ceiling 2.0→1.5 GiB lowers the risk iOS/Safari refuses to` \
  `# instantiate on a memory-constrained iPad/iPhone (the EngineInitFailed failure mode). The engine MAXIMUM` \
  `# stays 2 GiB so the host's 1.5 GiB descriptor is a valid subset (host max ≤ engine max).` \
  -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1 \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=node,worker \
  `# --- ASYNCIFY: single-forward-connection VOD range transport. ---` \
  `# The VOD demuxer fetches container bytes through a custom AVIO read callback (ferrite_io_read_range)` \
  `# that calls the JS source asynchronously (ferrite_js_range_read = EM_ASYNC_JS → await). Asyncify lets` \
  `# that read SUSPEND the worker stack (unwind) and RESUME (rewind) when the bytes arrive, WITHOUT a` \
  `# sync-XHR-per-window — one long-lived forward fetch, VLC-parity. The pthread decode pool keeps running` \
  `# during the suspend (per-thread Asyncify state; only the demux/worker-main stack parks — proven to` \
  `# coexist). CRITICAL SCOPING for the SW-HEVC moat: FFmpeg reaches avio + the decoders through` \
  `# FUNCTION POINTERS, so Asyncify's DEFAULT indirect instrumentation would instrument the DECODE hot loop` \
  `# too (≈+28% wasm + a big decode tax). IGNORE_INDIRECT turns that off (decode reached via fn-ptr → not` \
  `# instrumented → moat protected) and we instrument ONLY the explicit read-suspend cone in` \
  `# asyncify_readpath.txt (avformat read/open/seek + the ferrite range bridge — see gen-asyncify-readpath.sh).` \
  `# Measured: +3.6% wasm, ZERO decode_sweep regression. Do NOT pass ASYNCIFY_IMPORTS — EM_ASYNC_JS emits` \
  `# the import as __asyncjs__ferrite_js_range_read, auto-matched by the default pattern; a manual list` \
  `# OVERRIDES it → the suspend silently fizzles. 'Asyncify' in EXPORTED_RUNTIME_METHODS gives` \
  `# the host whenDone() to await the suspending exports. Validator: tests/asyncify_coexist.mjs.` \
  -sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=1 -sASYNCIFY_STACK_SIZE=131072 \
  -sASYNCIFY_ADD=@"$HERE/asyncify_readpath.txt" \
  -sEXPORTED_FUNCTIONS="@$HERE/ferrite.exports" \
  `# PThread is exported so the host worker can deterministically tear the pthread pool down on` \
  `# teardown (Module.PThread.terminateAllThreads()). Without it the pooled decode Workers are` \
  `# closure-private and orphan when the coordinator Worker is terminate()d — each pins the grown` \
  `# SharedArrayBuffer wasm instance (up to 2 GiB) that can't be GC'd, leaking across Stop/Play. JS-glue` \
  `# only: the .wasm is unaffected.` \
  -sEXPORTED_RUNTIME_METHODS="['HEAPU8','PThread','Asyncify']" \
  -o "$OUT/ferrite.mjs"
echo "OK: $OUT/ferrite.wasm = $(stat -c%s "$OUT/ferrite.wasm") bytes (matched pair in $OUT)"
