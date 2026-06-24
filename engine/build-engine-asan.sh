#!/usr/bin/env bash
# ASan-instrumented build of the Ferrite engine for the node gates (memory-error check of ferrite.c:
# the streaming ring, plane handling, demux). Separate output (ferrite_asan.{mjs,wasm}) so it never
# clobbers the production assets/ferrite.{mjs,wasm}. Instruments ferrite.c (our code); the FFmpeg .a
# are NOT instrumented, but ASan's allocator interceptors still catch heap UAF/OOB/double-free
# globally. -O1 + -g for readable reports. Growable heap with a 768 MiB initial (the gates use up to
# 4K clips) so heap + ASan shadow fit wasm32. -pthread is forced (the FFmpeg .a are threaded).
#
# Prereq: run ./build-engine.sh FIRST — this reuses the FFmpeg subset .a it builds under ./build.
# Run the gates against the ASan engine, e.g.:
#   FERRITE_ENGINE=../engine/ferrite_asan.mjs ~/emsdk/node/*/bin/node ../tests/leakcheck.mjs
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FFVER="$(tr -d ' \n' < "$HERE/ffmpeg-version")"
BUILD="$HERE/build"
FFSRC="$BUILD/ffmpeg-$FFVER"
INSTALL="$BUILD/build-thr/install"

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

if [ ! -f "$INSTALL/lib/libavcodec.a" ]; then
  echo "ERROR: FFmpeg subset not built. Run ./build-engine.sh first." >&2
  exit 1
fi

cd "$HERE"
INC="-I$FFSRC -I$INSTALL/include"

emcc ferrite.c -c -o "$BUILD/ferrite_asan.o" $INC -O1 -g -msimd128 -pthread -fsanitize=address

emcc "$BUILD/ferrite_asan.o" \
  "$INSTALL/lib/libavformat.a" \
  "$INSTALL/lib/libavcodec.a" \
  "$INSTALL/lib/libavfilter.a" \
  "$INSTALL/lib/libswresample.a" \
  "$INSTALL/lib/libavutil.a" \
  $INC -O1 -g -msimd128 -pthread -fsanitize=address \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=805306368 -sMAXIMUM_MEMORY=2147483648 \
  -sPTHREAD_POOL_SIZE='(Module["ferritePool"]||10)' -sDEFAULT_PTHREAD_STACK_SIZE=4194304 -sSTACK_SIZE=8388608 \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=node,worker \
  -sEXPORTED_FUNCTIONS="@$HERE/ferrite.exports" \
  -sEXPORTED_RUNTIME_METHODS="['HEAPU8','PThread']" \
  -o "$HERE/ferrite_asan.mjs"
echo "OK: ferrite_asan.wasm = $(stat -c%s "$HERE/ferrite_asan.wasm") bytes"
