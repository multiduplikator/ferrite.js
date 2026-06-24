#!/usr/bin/env bash
# Generate the VOD / file-container fixtures for vod_seek_test.mjs: short MP4 + MKV clips with a real
# header/index so the whole-file demuxer can autodetect the container, find_stream_info, and SEEK.
# A keyframe every ~1 s (-g) gives the BACKWARD seek a non-trivial landing keyframe to find.
# Content = testsrc2 video + a 1 kHz tone, ~12 s. Needs ffmpeg built with libx264 + libx265 + aac.
set -e
cd "$(dirname "$0")"
SRC="-f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=1000:sample_rate=48000"
COMMON="-t 12 -c:a aac -b:a 128k -map 0:v -map 1:a"

# H.264 in MP4 (mov demuxer) — +faststart moves the moov atom to the front (seekable in memory).
ffmpeg -hide_banner -y $SRC -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -g 25 $COMMON \
  -movflags +faststart vod_h264_aac.mp4 2>/dev/null && echo "  ✅ vod_h264_aac.mp4"
# H.264 in MKV (matroska demuxer).
ffmpeg -hide_banner -y $SRC -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -g 25 $COMMON \
  vod_h264_aac.mkv 2>/dev/null && echo "  ✅ vod_h264_aac.mkv"
# HEVC in MKV (matroska demuxer; the no-HW-HEVC software path).
ffmpeg -hide_banner -y $SRC -c:v libx265 -pix_fmt yuv420p -preset fast -crf 26 -x265-params log-level=error -g 25 $COMMON \
  vod_hevc_aac.mkv 2>/dev/null && echo "  ✅ vod_hevc_aac.mkv"
echo "VOD FIXTURES DONE"
