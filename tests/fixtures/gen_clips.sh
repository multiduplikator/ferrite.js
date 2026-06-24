#!/usr/bin/env bash
# Regenerate the test clip set — ALL MPEG-TS now. Both tiers consume .ts:
# the software tier demuxes+decodes via FFmpeg, and WebCodecs is fed by demuxing the SAME .ts
# (the raw .265/.264 and native .mp4 tiers are gone). Content = testsrc2 + a 1 kHz beep / full-
# frame white flash, both gated to the first 50ms of each second by the IDENTICAL expression
# lt(mod(t,1),0.05) so they coincide (A/V-sync signal). Encoded DIRECTLY to mpegts so the
# display PTS (!= DTS) is preserved for B-frame streams.
set -e
cd "$(dirname "$0")"
FLASH="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.05)'"
BEEP="aevalsrc=0.5*sin(2*PI*1000*t)*lt(mod(t\,1)\,0.05):s=48000"

# Video: <codec>_<res>[_10]_<fps>.ts — HEVC/H.264 @ 25/50/60, AAC audio.
sw() { # $1=size $2=fps $3=vcodec-args $4=out
  ffmpeg -hide_banner -y -f lavfi -i "testsrc2=size=$1:rate=$2" -f lavfi -i "$BEEP" \
    -map 0:v -map 1:a -t 10 -vf "$FLASH" $3 -c:a aac -b:a 128k -f mpegts "$4" 2>/dev/null && echo "  ✅ $4"
}
for F in 25 50 60; do
  sw 1920x1080 $F "-c:v libx265 -pix_fmt yuv420p     -preset fast -crf 24 -x265-params log-level=error" hevc_1080_$F.ts
  sw 1920x1080 $F "-c:v libx265 -pix_fmt yuv420p10le -preset fast -crf 24 -x265-params log-level=error" hevc_1080_10_$F.ts
  sw 3840x2160 $F "-c:v libx265 -pix_fmt yuv420p     -preset fast -crf 26 -x265-params log-level=error" hevc_2160_$F.ts
  sw 3840x2160 $F "-c:v libx265 -pix_fmt yuv420p10le -preset fast -crf 26 -x265-params log-level=error" hevc_2160_10_$F.ts
  sw 1920x1080 $F "-c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -g $F" h264_1080_$F.ts
  sw 3840x2160 $F "-c:v libx264 -pix_fmt yuv420p -preset fast -crf 24 -g $F" h264_2160_$F.ts
done
# MPEG-2: SD/HD broadcast — 25 fps progressive only (HFR / 4K / 10-bit excluded as not-real-world).
sw 1920x1080 25 "-c:v mpeg2video -pix_fmt yuv420p -q:v 4 -g 25" mpeg2_1080_25.ts

# Interlaced 1080i25 (50 fields): classic broadcast. Source 50p → interlace filter → 25i.
il() { # $1=vcodec-args $2=out
  ffmpeg -hide_banner -y -f lavfi -i "testsrc2=size=1920x1080:rate=50" -f lavfi -i "$BEEP" \
    -map 0:v -map 1:a -t 10 -vf "$FLASH,interlace=scan=tff" $1 -c:a aac -b:a 128k -f mpegts "$2" 2>/dev/null && echo "  ✅ $2"
}
il "-c:v mpeg2video -pix_fmt yuv420p -q:v 4 -flags +ilme+ildct -top 1" mpeg2_1080i_25.ts
il "-c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -x264-params interlaced=1:tff=1" h264_1080i_25.ts

# Audio matrix: one light HEVC carrier (640x360, 8s) per audio codec → aud_<codec>.ts.
for pair in "aac:aac" "ac3:ac3" "eac3:eac3" "mp2:mp2" "mp3:libmp3lame"; do
  ac="${pair%%:*}"; enc="${pair##*:}"
  ffmpeg -hide_banner -y -f lavfi -i "testsrc2=size=640x360:rate=25" -f lavfi -i "$BEEP" \
    -map 0:v -map 1:a -t 8 -vf "$FLASH" \
    -c:v libx265 -preset ultrafast -crf 28 -x265-params log-level=error -c:a "$enc" -b:a 192k -f mpegts "aud_${ac}.ts" 2>/dev/null && echo "  ✅ aud_${ac}.ts"
done
echo "ALL CLIPS DONE"
