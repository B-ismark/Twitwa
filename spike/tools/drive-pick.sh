#!/bin/bash
#
# Drive the spike's Pick button through Android's photo picker to one fixture,
# so a device run does not need a human thumb.
#
#   tools/drive-pick.sh 20:43              # tile whose timestamp has "20:43"
#   tools/drive-pick.sh 08:1               # first match wins by default
#   MATCH_INDEX=1 tools/drive-pick.sh 20:43  # the SECOND of several matches
#
# Path: Pick -> Collections -> From this device -> TwitwaFixtures -> tile -> Done.
# Always through the TwitwaFixtures album, never the Photos tab, because the
# Photos tab opens on the owner's personal library.
#
# FOUR THINGS THIS SCRIPT EXISTS TO ENCODE, each of which cost a debugging
# detour before it was written down:
#
#   1. The Photos/Collections tabs are Jetpack Compose nodes that
#      `uiautomator dump` does not report. They are plainly on screen and
#      absent from the XML, so Collections is a fixed coordinate here and a
#      screenshot is the only honest way to re-derive it. Everything else is
#      matched by text.
#   2. Tiles are matched by TIMESTAMP, not by grid position. The picker orders
#      newest-first, the album gains rows as fixtures are pushed, and an index
#      into that grid silently selects a different picture next time.
#   3. Any DOWNWARD swipe dismisses the picker sheet, whatever y it starts at,
#      so a scrolled-away header cannot be scrolled back and
#      `am force-stop com.google.android.photopicker` does not reset it either.
#      Only upward swipes are safe, and this script avoids swiping at all
#      except where a higher density pushes "From this device" below the fold.
#   4. `MSYS_NO_PATHCONV=1` is required for adb arguments containing
#      /sdcard/..., and must NOT be set when the same command also hands a
#      /c/Users/... path to a Windows program — it disables both translations.
#
# Two things to check before blaming the script:
#   - `adb reverse --list` must show tcp:8081. It drops on its own under heavy
#     exec-out/uiautomator traffic, and the symptom is the dev client saying
#     "there was a problem with loading this project" while Metro is fine.
#   - THE PICKER'S CLOCK IS NOT THE FILE'S. `ls -l` prints 20:44 for
#     ig-feed-statusbar and x-timeline-statusbar; the picker labels both tiles
#     20:43, because it shows MediaStore's date_taken and that is not the mtime.
#     So match on what a probe prints, never on what `ls` says.
#   - Those two tiles are therefore AMBIGUOUS: `drive-pick.sh 20:43` warns and
#     takes the first, which is measured to be x-timeline-statusbar. Both are
#     1440x3120 and both sample a black frame, so picking the wrong one does not
#     look wrong - screenshot the app and read the source before trusting any
#     byte comparison.
#   - Do not try to fix that with a timestamp. `adb push` preserves the source
#     mtime, and `touch` plus a MEDIA_SCANNER_SCAN_FILE rescan moves
#     date_modified while date_taken, which is what the picker shows, stays put.
#     Both were tried on 2026-09-17 and neither moved the tile.
#   - A fixture pushed to /sdcard is not in the picker until it is scanned:
#       adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
#         -d file:///sdcard/Pictures/TwitwaFixtures/<name>.png
#     and the album view caches, so the Photos tab sees it before the album does.
#
# ADB is not on PATH on this machine; $ANDROID_HOME is D:\AndroidDev\sdk.
#
# Run tools/preflight.sh first. Every fault it checks for has cost a debugging
# detour that looked like a bug in the app.
set -u
A="${ADB:-/d/AndroidDev/sdk/platform-tools/adb.exe}"
S="$(dirname "$0")"
P="${PKG:-dev.bismark.twitwaspike}"
COLLECTIONS_XY="${COLLECTIONS_XY:-1070 1231}"   # density 476 on a 1440x3120 panel
export MSYS_NO_PATHCONV=1

dump() { "$A" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; "$A" exec-out cat /sdcard/ui.xml > "$S/ui.xml"; }

# centre of the first node whose text equals $1
coords() {
  node -e '
  const fs=require("fs");const want=process.argv[2];
  const xml=fs.readFileSync(process.argv[1],"utf8");
  for(const m of xml.matchAll(/<node[^>]*>/g)){const n=m[0];
    const t=(n.match(/text="([^"]*)"/)||[,""])[1];
    const b=n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/); if(!b) continue;
    if(t===want){console.log(Math.round((+b[1]+ +b[3])/2)+" "+Math.round((+b[2]+ +b[4])/2));process.exit(0);}
  }
  process.exit(3);' "$S/ui.xml" "$1"
}

tap_text() {
  for i in 1 2 3 4 5 6 7 8; do
    dump
    if c=$(coords "$1" 2>/dev/null); then
      "$A" shell input tap $c
      echo "  tapped '$1' at $c"
      return 0
    fi
    sleep 1
  done
  echo "  NOMATCH '$1'" >&2
  return 3
}

# Pick button lives in the RN view; find it by text
tap_text "Pick" || exit 3
sleep 3
# The Photos/Collections tabs are Jetpack Compose nodes that uiautomator does not
# report, so this one is a fixed coordinate rather than a text match. Verified by
# screenshot: Collections sits at (1070, 1231) on a 1440x3120 panel.
"$A" shell input tap $COLLECTIONS_XY
echo "  tapped 'Collections' at $COLLECTIONS_XY (fixed coordinate: not in the dump)"
sleep 2
tap_text "From this device" || exit 3
sleep 2

# TwitwaFixtures is NOT reliably on the first screen of "From this device": that
# list is ordered by how recently each album gained a picture, so the fixtures
# album sinks as the owner uses the phone. On 2026-09-18 it had fallen to row 3
# and a plain tap_text found nothing.
#
# Two failures were paid for here, in this order, and both are why this is not a
# tap_text call any more:
#
#   1. A 1100px swipe stepped OVER the row. One album row is ~824px on this
#      panel, so any swipe longer than a row can move a row through the gap
#      between two dumps. 500px, dumping every step.
#   2. A tap used coordinates from a dump taken while the fling was still
#      decelerating. The row moved under the tap, a DIFFERENT album opened, and
#      the run ended in the owner's personal library with a photo selected. So
#      the coordinates must be STABLE across two consecutive dumps before
#      anything is tapped: a label found once is a label that was somewhere once.
#
# And the tile matcher below will select from whatever grid is on screen, which
# is why the album is confirmed by name before any tile is touched. Failing
# closed here is the whole point — the alternative is handing the app a picture
# out of the owner's camera roll.
found=""
for i in $(seq 1 20); do
  dump
  if c1=$(coords TwitwaFixtures 2>/dev/null); then
    dump
    c2=$(coords TwitwaFixtures 2>/dev/null) || c2=""
    if [ "$c1" = "$c2" ]; then found="$c1"; echo "  found TwitwaFixtures at $c1, stable across two dumps"; break; fi
    echo "  TwitwaFixtures moved ($c1 -> ${c2:-gone}); the list is still settling"
    continue
  fi
  echo "  scroll $i: not in the dump, swiping up 500px"
  "$A" shell input swipe 720 2200 720 1700 400
done
[ -z "$found" ] && { echo "  never found TwitwaFixtures" >&2; exit 3; }
"$A" shell input tap $found
echo "  tapped TwitwaFixtures at $found"

opened=""
for i in 1 2 3 4 5 6 7 8; do
  dump
  if grep -q 'text="TwitwaFixtures"' "$S/ui.xml" && grep -q "Photo taken on" "$S/ui.xml"; then opened=yes; break; fi
  if grep -q "Search Google Photos" "$S/ui.xml"; then
    echo "  ABORT: this is the Photos tab, not TwitwaFixtures. Selecting nothing." >&2
    exit 4
  fi
  sleep 1
done
[ -z "$opened" ] && { echo "  ABORT: could not confirm the TwitwaFixtures album is open" >&2; exit 4; }
echo "  album confirmed: TwitwaFixtures"

# $1 is a substring of the tile's content-desc, e.g. "08:10" or "20:43".
# MATCH_INDEX picks among several matches, newest-first, 0-based. It exists
# because two fixtures genuinely share a minute and their content-descs are
# character-for-character identical, so no text can separate them - see the note
# on the picker's clock above. Measured on 2026-09-17: index 0 is
# x-timeline-statusbar and index 1 is ig-feed-statusbar. Verify by screenshot
# before trusting either, since both are 1440x3120 with a black frame.
# Matching on the timestamp rather than a grid position: the picker orders
# newest-first, the album gains rows as fixtures are pushed, and an index into
# that grid silently selects a different picture the next time.
dump
read TX TY <<EOF
$(node -e '
const fs=require("fs");const want=process.argv[2];
const xml=fs.readFileSync(process.argv[1],"utf8");
const hits=[];
for(const m of xml.matchAll(/<node[^>]*content-desc="(Photo taken on [^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g)){
  const [,d,x1,y1,x2,y2]=m;
  hits.push([Math.round((+x1+ +x2)/2), Math.round((+y1+ +y2)/2), d]);
}
const match=hits.filter(h=>h[2].includes(want));
const idx=+(process.env.MATCH_INDEX||0);
if(!match.length){
  console.error("  no tile matching \""+want+"\". Visible: "+hits.map(h=>h[2].replace("Photo taken on ","")).join(" | "));
  process.exit(3);
}
if(!match[idx]){
  console.error("  MATCH_INDEX="+idx+" but only "+match.length+" tile(s) match \""+want+"\"");
  process.exit(3);
}
if(match.length>1) console.error("  NOTE "+match.length+" tiles match \""+want+"\"; taking index "+idx+" of 0.."+(match.length-1));
console.log(match[idx][0]+" "+match[idx][1]);
console.error("  tile: "+match[idx][2]);
' "$S/ui.xml" "$1")
EOF
[ -z "${TX:-}" ] && { echo "  no tiles found" >&2; exit 3; }
"$A" shell input tap "$TX" "$TY"
echo "  tapped tile at $TX $TY"
sleep 2
tap_text "Done" || exit 3
echo "  done"
