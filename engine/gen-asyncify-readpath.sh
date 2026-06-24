#!/usr/bin/env bash
# Regenerate engine/asyncify_readpath.txt — the ASYNCIFY_ADD list for the VOD range-read transport.
#
# WHY a hand-validated list (not ASYNCIFY_ADVISE directly): the engine fetches bytes through a custom
# AVIO read callback (ferrite_io_read_range) that FFmpeg invokes via a FUNCTION POINTER. With Asyncify's
# default indirect-call instrumentation ON, Asyncify must assume any fn-ptr call may suspend → it
# instruments ~everything including the 4K-HEVC DECODE hot loop → +28% wasm AND a big decode tax (the
# moat-killer). So we build with -sASYNCIFY_IGNORE_INDIRECT=1 (do NOT auto-instrument fn-ptr calls,
# protecting decode) and supply an EXPLICIT ADD list of exactly the functions on the range-read SUSPEND
# STACK. That stack is: ferrite_demux_{new_range,step,seek_us} → av_read_frame / avformat_open_input /
# avformat_find_stream_info / av_seek_frame → the avio/avformat read internals → [fn ptr] →
# ferrite_io_read_range → ferrite_js_range_read (the async import). EVERY frame on that stack must be
# instrumented or a classic-Asyncify rewind lands in an uninstrumented frame and corrupts/hangs.
#
# THE GENERATION RULE (this script):
#   1. Build with whole-program ASYNCIFY_ADVISE (IGNORE_INDIRECT OFF) → the conservative OVER-report of
#      every function reachable to the suspend (≈1300 funcs, includes all of decode/dsp via fn-ptrs).
#   2. KEEP only the funcs DEFINED in libavformat.a. The suspend stack is ENTIRELY in avformat: the
#      demuxers (mov/matroska/mpegts read callbacks), av_read_frame/av_seek_frame, and the avio/aviobuf
#      read primitives all live there. Decode/DSP (avcodec), deint/format (avfilter) and resample
#      (swresample) run BETWEEN reads, never on the suspend stack, and are reached via fn-ptr → skipped by
#      IGNORE_INDIRECT → NOT instrumented → the moat is protected. avutil LEAF utils (av_log, av_realloc,
#      av_fifo, av_opt, av_malloc…) are called DIRECTLY by decode, so listing them would make ASYNCIFY_ADD
#      pull their decode callers into instrumentation (balloon + moat tax) — they are NOT on the read
#      SUSPEND stack (they run between reads), so we exclude them. This archive-membership cut is what makes
#      the list both COMPLETE (every avformat read frame) and TIGHT (no decode-caller bleed): +3.6% wasm,
#      ZERO decode_sweep regression.
#   3. Append the ferrite range-bridge entry points (not in any FFmpeg archive): ferrite_io_read_range (the
#      indirectly-reached read callback — IGNORE_INDIRECT can't see it, so it MUST be named explicitly),
#      ferrite_io_seek_range, the demux exports, and demux_finish_file_open.
#
# THE VALIDATOR (mandatory after regenerating): tests/asyncify_coexist.mjs drives a genuinely-suspending
# async range hook through mpegts + mov + matroska (open + decode through the live pthread pool + backward
# seek). A missing read-path frame → the assertions build aborts naming it (add it to the list); a moat
# regression → decode_sweep catches it. PIN: FFmpeg version per engine/ffmpeg-version. REGENERATE + REVALIDATE
# on any FFmpeg version bump — the avformat symbol set changes.
#
# Run:  bash engine/gen-asyncify-readpath.sh   (requires build-engine.sh to have built the FFmpeg .a libs)
#       then rebuild the engine (build-engine.sh) and run: node tests/asyncify_coexist.mjs
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FFVER="$(tr -d ' \n' < "$HERE/ffmpeg-version")"
BUILD="$HERE/build"; FFSRC="$BUILD/ffmpeg-$FFVER"; INSTALL="$BUILD/build-thr/install"
OUT="$HERE/asyncify_readpath.txt"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if ! command -v emcc >/dev/null 2>&1; then source "${EMSDK_ROOT:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1; fi
[ -f "$INSTALL/lib/libavformat.a" ] || { echo "ERROR: FFmpeg libs missing — run engine/build-engine.sh first"; exit 1; }
INC="-I$FFSRC -I$INSTALL/include"

# 1. whole-program ADVISE (IGNORE_INDIRECT OFF) — the conservative over-report.
echo "[1/3] ASYNCIFY_ADVISE (whole-program over-report) ..."
emcc "$HERE/ferrite.c" -c -o "$TMP/ferrite.o" $INC -O3 -msimd128 -pthread
emcc "$TMP/ferrite.o" \
  "$INSTALL/lib/libavformat.a" "$INSTALL/lib/libavcodec.a" "$INSTALL/lib/libavfilter.a" \
  "$INSTALL/lib/libswresample.a" "$INSTALL/lib/libavutil.a" \
  $INC -O3 -msimd128 -pthread -sPTHREAD_POOL_SIZE=10 \
  -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1 \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=node,worker \
  -sEXPORTED_FUNCTIONS="@$HERE/ferrite.exports" -sEXPORTED_RUNTIME_METHODS="['HEAPU8','PThread','Asyncify']" \
  -sASYNCIFY=1 -sASYNCIFY_ADVISE=1 -o "$TMP/advise.mjs" > "$TMP/advise.log" 2>&1 || true
# ASYNCIFY_ADVISE prints "[asyncify] <func> can change the state due to <reason>"; the prefix can repeat
# and two names can share a line. Extract the token immediately before "can change the state" (portable
# awk — busybox grep has no -P). Junk tokens (e.g. "that" from the import line) are harmless: step 2's
# libavformat intersection drops anything that isn't a real avformat symbol.
awk '{ for (i=1;i<=NF;i++) if ($i=="can" && $(i+1)=="change" && $(i+2)=="the" && $(i+3)=="state") print $(i-1) }' \
  "$TMP/advise.log" | sort -u > "$TMP/advise_funcs.txt"
[ -s "$TMP/advise_funcs.txt" ] || { echo "ERROR: ASYNCIFY_ADVISE produced no functions — check $TMP/advise.log"; exit 1; }
echo "      advise reported $(wc -l < "$TMP/advise_funcs.txt") funcs"

# 2. KEEP only libavformat-defined funcs (the read/open/seek suspend cone).
echo "[2/3] intersect with libavformat-defined symbols ..."
emnm --defined-only "$INSTALL/lib/libavformat.a" 2>/dev/null | awk '$2 ~ /[TtWw]/ {print $3}' | sort -u > "$TMP/avformat_syms.txt"
grep -Fxf "$TMP/avformat_syms.txt" "$TMP/advise_funcs.txt" > "$TMP/keep.txt"

# 3. append the ferrite range-bridge entry points (not in any FFmpeg archive).
echo "[3/3] append ferrite range-bridge entry points ..."
cat >> "$TMP/keep.txt" <<'BRIDGE'
ferrite_io_read_range
ferrite_io_seek_range
ferrite_demux_new_range
ferrite_demux_step
ferrite_demux_seek_us
ferrite_demux_duration_us
demux_finish_file_open
BRIDGE
sort -u "$TMP/keep.txt" > "$OUT"
echo "WROTE $OUT ($(wc -l < "$OUT") funcs). VALIDATE: rebuild + node tests/asyncify_coexist.mjs (+ decode_sweep moat)."
# CLEANUP after a regen: the FINAL optimized engine link (build-engine.sh, -O2) INLINES a few of these
# avformat symbols (e.g. handle_packet, read_string_to_bprint_overwrite) so they no longer exist as named
# functions in the wasm; emscripten then warns "Asyncify addlist contained a non-existing function name: X".
# Those are harmless — an inlined body is covered by its (instrumented) caller — but they are dead entries.
# Remove each named X from this file to keep the build warning-clean, then re-run tests/asyncify_coexist.mjs
# to confirm the suspend cone is still GREEN (the validator names any frame that is genuinely missing).
# NOTE: ASYNCIFY_ADVISE's over-report varies slightly run-to-run (its conservative indirect traversal), so
# the func COUNT can wobble by a few (e.g. ffurl_* protocol helpers we never reach with our custom AVIO).
# The COMMITTED asyncify_readpath.txt is the VALIDATED snapshot — completeness is proven by
# tests/asyncify_coexist.mjs (assertions build names any missing frame), not by exact regen equality.
