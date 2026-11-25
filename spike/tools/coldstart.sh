#!/usr/bin/env bash
#
# Cold-start time, measured the way Android measures it: force-stop the app,
# then `am start -W`, which blocks until the first frame and reports TotalTime.
#
#   tools/coldstart.sh                              # release id, 5 runs
#   tools/coldstart.sh dev.bismark.twitwa 10        # package, then run count
#   ADB=/path/to/adb tools/coldstart.sh dev.bismark.twitwa.debug
#
# Run it before and after a change on the same phone, same build type: P4's
# "measure cold start" is a comparison, and a number from one build is not.
#
# THE PACKAGE IS NOT THE ACTIVITY'S NAMESPACE. withDebugSuffix gives the debug
# build the id dev.bismark.twitwa.debug, but MainActivity's class stays
# dev.bismark.twitwa.MainActivity. A relative `.MainActivity` resolves against
# the package argument and would ask for ...debug.MainActivity, which does not
# exist, so the class is always spelled out from app.json's own package.
#
# The release id is the default because a debug build is a dev client waiting
# on Metro: its "cold start" times the wait, not the app. Median, not mean, so
# one run that landed on a background sync does not move the answer.
set -u
A="${ADB:-adb}"
PKG="${1:-dev.bismark.twitwa}"
N="${2:-5}"
CLASS="dev.bismark.twitwa.MainActivity"

case "$N" in ''|*[!0-9]*|0) echo "run count must be a positive integer, got: $N" >&2; exit 2 ;; esac
command -v "$A" >/dev/null 2>&1 || { echo "adb not found (set ADB=)" >&2; exit 2; }

times=()
for i in $(seq 1 "$N"); do
  "$A" shell am force-stop "$PKG" >/dev/null 2>&1
  sleep 1   # let the process die and the launcher settle; a start on a dying process is not cold
  out=$("$A" shell am start -W -n "$PKG/$CLASS" 2>&1 | tr -d '\r')
  t=$(printf '%s\n' "$out" | sed -n 's/^TotalTime:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  if [ -z "$t" ]; then
    echo "run $i: no TotalTime in the output of am start -W:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  echo "run $i: ${t} ms"
  times+=("$t")
done

sorted=$(printf '%s\n' "${times[@]}" | sort -n)
count=${#times[@]}
mid=$(( (count + 1) / 2 ))
if [ $((count % 2)) -eq 1 ]; then
  median=$(printf '%s\n' "$sorted" | sed -n "${mid}p")
else
  a=$(printf '%s\n' "$sorted" | sed -n "$((count / 2))p")
  b=$(printf '%s\n' "$sorted" | sed -n "$((count / 2 + 1))p")
  median=$(( (a + b) / 2 ))
fi
echo "median of $count: ${median} ms  ($PKG)"
