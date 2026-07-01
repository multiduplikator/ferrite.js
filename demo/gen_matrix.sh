#!/usr/bin/env bash
# ferrite.js capability-matrix fixtures — SELF-CONTAINED (no dependency on any other repo). Generates the
# exact clip set the demo's fixture selector drives, into ../assets (where demo/serve.mjs serves them:
# .ts via /faux-live, .mp4/.mkv via the Range static handler). The media is gitignored (large, binary,
# reproducible); THIS script is the committed source of truth.
#
# A CONSTRAINED-PAIRWISE set over {container, video codec, resolution, scan, audio}, honouring real-world
# rules so no impossible clip is made:
#   mpeg2 / interlaced / mp2  -> TS only (broadcast)        hvc1 HEVC, seek -> MP4 / MKV (VOD)
#   hev1 HEVC, live           -> TS (Annex-B, in-band)      mp3 -> MKV/TS
# Covers all 3 containers, all 3 video codecs, all 3 resolutions (1080/1440/2160), both scans, and every
# audio codec the engine decodes (none/aac/ac3/eac3-5.1/mp2/mp3). 9 matrix clips + 2 standalone anamorphic.
#
# Each clip is 35s (a 30s play never hits the EOF seam) with a burned-in per-second white FLASH (first 50ms)
# + a large running TIMECODE/frame number, so a loop (TC jumps back) or skip (TC jumps forward) is VISUALLY
# obvious. The 1 kHz beep (where audio is present) is gated to the same first-50ms window -> an A/V-sync mark.
#
# Prereq: ffmpeg built with libx264 + libx265 (+ aac/ac3/eac3/mp2/mp3) and the freetype (drawtext) filter.
#   Run:  bash demo/gen_matrix.sh           (then `npm run demo`; the selector lists these by default)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)/assets"
mkdir -p "$OUT"
cd "$OUT"

# A usable TTF for drawtext — try a few common locations, then fontconfig, else fail with a clear message.
FONT=""
for f in /usr/share/fonts/opensans/OpenSans-Regular.ttf \
         /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
         /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf \
         "$(fc-match -f '%{file}' 2>/dev/null)"; do
  [ -n "$f" ] && [ -f "$f" ] && FONT="$f" && break
done
[ -z "$FONT" ] && { echo "ERROR: no TTF font found for drawtext (install dejavu/liberation or set FONT=)" >&2; exit 1; }
echo "font: $FONT"
echo "out:  $OUT"

DUR=35
FLASH="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.05)'"
# stereo 1 kHz beep + a 5.1 six-tone bed (FL 440 / FR 554 / FC 660 / LFE 60 / SL 880 / SR 990 Hz) so a
# stereo downmix is verifiable (every channel non-zero; a dropped channel changes the L/R sum).
G="*lt(mod(t\\,1)\\,0.05)"   # the per-second 50 ms gate (coincides with the FLASH) — ALL beeps use it
BEEP2="aevalsrc=exprs='0.4*sin(2*PI*1000*t)${G}|0.4*sin(2*PI*1000*t)${G}':channel_layout=stereo:sample_rate=48000"
BEEP6="aevalsrc=exprs='0.4*sin(2*PI*440*t)${G}|0.4*sin(2*PI*554*t)${G}|0.35*sin(2*PI*660*t)${G}|0.4*sin(2*PI*60*t)${G}|0.3*sin(2*PI*880*t)${G}|0.3*sin(2*PI*990*t)${G}':channel_layout=5.1(side):sample_rate=48000"

# Video codec presets (keyint = 1s; veryfast — these are test patterns, quality is not the point).
X264="-c:v libx264  -pix_fmt yuv420p -preset veryfast -crf 24 -g 50 -keyint_min 50"
X264I="-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 24 -x264-params interlaced=1:tff=1"
X265="-c:v libx265  -pix_fmt yuv420p -preset veryfast -crf 26 -x265-params log-level=error:keyint=50:min-keyint=50"
# 10-bit HLG/HDR HEVC (the real 4K-IPTV shape): yuv420p10le + BT.2020 primaries/matrix + ARIB STD-B67 (HLG)
# transfer, tagged both at the stream level (-color_*) and in the HEVC VUI (x265-params) so the decoder reads
# it. NB: testsrc2 is not HDR-GRADED content — this validates the 10-bit decode + HLG/tone-map PATH, not look.
X265H="-c:v libx265 -pix_fmt yuv420p10le -preset veryfast -crf 26 -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -x265-params log-level=error:keyint=50:min-keyint=50:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"
MP2I="-c:v mpeg2video -pix_fmt yuv420p -q:v 4 -g 25 -flags +ilme+ildct -top 1"

# genv <out> <size> <fps> <fontsize> <interlace 0/1> "<vcodec args>" <audio none|aac|ac3|eac3|mp2|mp3> "<muxer/extra>"
genv() {
  local out=$1 size=$2 fps=$3 fs=$4 il=$5 vc=$6 aud=$7 xtra=$8
  local tc="drawtext=fontfile=${FONT}:text='%{pts\\:hms}  f=%{n}':fontcolor=white:fontsize=${fs}:box=1:boxcolor=black@0.6:x=40:y=h-$((fs*2))"
  local vf="${FLASH},${tc}"
  local srcrate=$fps
  if [ "$il" = "1" ]; then vf="${vf},interlace=scan=tff"; srcrate=$((fps*2)); fi
  local beep="$BEEP2" acodec=""
  case "$aud" in
    aac)  acodec="-c:a aac -b:a 128k" ;;
    ac3)  acodec="-c:a ac3 -b:a 192k" ;;
    eac3) beep="$BEEP6"; acodec="-c:a eac3 -b:a 384k" ;;
    mp2)  acodec="-c:a mp2 -b:a 192k" ;;
    mp3)  acodec="-c:a libmp3lame -b:a 192k" ;;
  esac
  if [ "$aud" = "none" ]; then
    ffmpeg -hide_banner -y -f lavfi -i "testsrc2=size=${size}:rate=${srcrate}" \
      -map 0:v -t $DUR -vf "$vf" $vc $xtra "$out" 2>/dev/null && echo "  ✅ $out (no audio)"
  else
    ffmpeg -hide_banner -y -f lavfi -i "testsrc2=size=${size}:rate=${srcrate}" -f lavfi -i "$beep" \
      -map 0:v -map 1:a -t $DUR -vf "$vf" $vc $acodec $xtra "$out" 2>/dev/null && echo "  ✅ $out ($aud)"
  fi
}

echo "matrix (11 clips × 35s)…"
# --- TS (broadcast / live path): hev1 HEVC, interlaced, mpeg2, the 4K cases ---
genv cap_ts_hevc2160_10hlg_eac3.ts 3840x2160 50 128 0 "$X265H" eac3 "-f mpegts" & # 1  hev1 4K · 10-bit HLG · EAC3 5.1 downmix
genv cap_ts_h264_1080i_ac3.ts    1920x1080 25 64  1 "$X264I" ac3  "-f mpegts" &   # 2  1080i deint + AC3 (→ software)
genv cap_ts_h264_1080p_aac.ts    1920x1080 50 64  0 "$X264"  aac  "-f mpegts -profile:v high -level 4.1" & # 2b progressive H.264 + AAC → WebCodecs (the WC-vs-software isolation pair)
genv cap_ts_mpeg2_1080i_mp2.ts   1920x1080 25 64  1 "$MP2I"  mp2  "-f mpegts" &   # 3  MPEG-2 1080i + MP2
genv cap_ts_h264_2160_noaudio.ts 3840x2160 50 128 0 "$X264"  none "-f mpegts" &   # 4  4K H264 WC, video-only
wait
# --- MP4 (VOD / seek): hvc1 HEVC, avcC H264 ---
genv cap_mp4_hevc1080_aac.mp4    1920x1080 50 64  0 "$X265"  aac  "-tag:v hvc1 -movflags +faststart" &  # 5
genv cap_mp4_h264_1440_aac.mp4   2560x1440 50 80  0 "$X264"  aac  "-movflags +faststart" &              # 6
# --- MKV (VOD / seek): the regression case, hvc1 HEVC, mp3 ---
genv cap_mkv_h264_1080_aac.mkv   1920x1080 50 64  0 "$X264"  aac  "-f matroska" &   # 7  the MKV+AAC regression case
wait
genv cap_mkv_hevc1440_ac3.mkv    2560x1440 50 80  0 "$X265"  ac3  "-tag:v hvc1 -f matroska" &   # 8
wait

# --- standalone: ANAMORPHIC aspect — GRID + CIRCLE (H.264 #10 + HEVC #11). The pattern (round ring + crosshair
#     + 120px SQUARE grid) is drawn at 1920×1080 (round circle / square cells), then SQUISHED to 1440×1080 and
#     tagged `-aspect 16:9` (→ SAR 4:3): the circle reads ROUND + cells SQUARE *only* when the player applies
#     the SAR; an ellipse / rectangles if it ignores it. Both exercise the demux one-shot SAR decode (H.264 +
#     HEVC) — WC tier on HW, software off-HW. ---
ASPECT_GEQ="geq=lum='if(lt(abs(hypot(X-960\,Y-540)-480)\,3)\,255\,if(lt(abs(X-960)\,2)+lt(abs(Y-540)\,2)\,210\,if(lt(mod(X\,120)\,2)+lt(mod(Y\,120)\,2)\,110\,24)))':cb=128:cr=128"
ffmpeg -hide_banner -v error -y -f lavfi -i "color=c=black:s=1920x1080:d=1" -vf "$ASPECT_GEQ" -frames:v 1 /tmp/aspect_pat.png
ASPECT_TC="drawtext=fontfile=${FONT}:text='%{pts\\:hms}  f=%{n}':fontcolor=cyan:fontsize=64:box=1:boxcolor=black@0.6:x=40:y=h-128"
ASPECT_VF="scale=1440:1080,${FLASH},${ASPECT_TC}"
ffmpeg -hide_banner -v error -y -loop 1 -i /tmp/aspect_pat.png -f lavfi -i "$BEEP2" -map 0:v -map 1:a -t $DUR -r 50 \
  -vf "$ASPECT_VF" $X264 -aspect 16:9 -c:a aac -b:a 128k -f mpegts cap_aspect_h264_1440x1080.ts && echo "  ✅ cap_aspect_h264_1440x1080.ts (grid+circle · #10)"
ffmpeg -hide_banner -v error -y -loop 1 -i /tmp/aspect_pat.png -f lavfi -i "$BEEP2" -map 0:v -map 1:a -t $DUR -r 50 \
  -vf "$ASPECT_VF" $X265 -aspect 16:9 -c:a libmp3lame -b:a 192k -f mpegts cap_aspect_hevc_1440x1080.ts && echo "  ✅ cap_aspect_hevc_1440x1080.ts (grid+circle · #11 · hev1 · mp3)"
echo "MATRIX DONE → $OUT"
