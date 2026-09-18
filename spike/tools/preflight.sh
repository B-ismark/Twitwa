#!/bin/bash
#
# Check the things that break a device run, before they cost a debugging detour.
#
#   tools/preflight.sh                       # check and report
#   tools/preflight.sh --reload              # also restart the app onto a fresh bundle
#   tools/preflight.sh --marker readSubRect  # also prove Metro serves that token
#
# Every check here exists because its absence has already been mistaken for a
# bug in the app. In the order they have actually bitten:
#
#   1. ADB IS NOT ON PATH. A bare `adb` fails with "command not found".
#   2. `adb reverse` DROPS ON ITS OWN, under exactly the exec-out and uiautomator
#      traffic a driven run produces. It dropped twice on 2026-09-18, once
#      between being set and the very next command. The symptom is the dev
#      client saying "Failed to connect to localhost/127.0.0.1:8081" while Metro
#      is perfectly healthy, or Fast Refresh going quiet. So this re-asserts it
#      and then VERIFIES it, because setting it is not evidence it is set.
#   3. A REPLY ON 8081 IS NOT PROOF METRO IS YOURS. An orphaned Metro from a
#      previous session answers `packager-status:running` identically. One
#      rooted in this project but started before a file existed will never serve
#      that file. Check the listening process's command line, not the port.
#   4. METRO SEEING AN EDIT IS NOT THE DEVICE RUNNING IT. On 2026-09-18 a
#      mutation was in the served bundle and absent from the device for two full
#      test cycles, because the HMR socket had gone with the reverse. If source
#      changed, --reload. Anything less is testing the previous program.
#   5. "NOTHING HAPPENS" IS USUALLY THE SCREEN. `mWakefulness=Dozing` makes
#      screencap return a valid all-black PNG and every tap go nowhere, which
#      reads exactly like a hung app. A secure keyguard needs the owner.
#
# Hard failures exit non-zero. Warnings print and continue.
set -u
A="${ADB:-/d/AndroidDev/sdk/platform-tools/adb.exe}"
PKG="${PKG:-dev.bismark.twitwa}"
PORT="${PORT:-8081}"
cd "$(dirname "$0")/.." || exit 1

RELOAD=""
MARKER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reload) RELOAD=1 ;;
    --marker) shift; MARKER="${1:-}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

fail=0
ok()   { echo "  ok    $1"; }
warn() { echo "  WARN  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

echo "adb"
if [ ! -x "$A" ]; then bad "no adb at $A (it is not on PATH; \$ANDROID_HOME is D:\\AndroidDev\\sdk)"; echo; exit 1; fi
serial=$("$A" get-serialno 2>/dev/null)
case "$serial" in
  ''|unknown) bad "no device (adb get-serialno said '${serial:-nothing}')" ;;
  *) ok "device $serial" ;;
esac
[ "$fail" = 1 ] && { echo; exit 1; }

echo "screen"
wake=$("$A" shell dumpsys power 2>/dev/null | grep -m1 -o 'mWakefulness=[A-Za-z]*' | cut -d= -f2)
case "$wake" in
  Awake) ok "awake" ;;
  '')    warn "could not read mWakefulness" ;;
  *)     warn "mWakefulness=$wake — screencap will look black and taps will go nowhere; 'input keyevent KEYCODE_WAKEUP' fixes a doze, a keyguard needs the owner" ;;
esac
focus=$("$A" shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus)
case "$focus" in
  *keyguard*|*Keyguard*) warn "keyguard has focus — ask the owner to unlock; do not work around it" ;;
  *) ok "focus:${focus#*mCurrentFocus=}" ;;
esac

echo "metro on :$PORT"
status=$(curl -s -m 5 "http://127.0.0.1:$PORT/status" 2>/dev/null)
if [ "$status" != "packager-status:running" ]; then
  bad "nothing answering /status (got '${status:-nothing}')"
else
  # Whose Metro is it? A stale one answers identically.
  cmd=$(powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { (Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$c.OwningProcess)\").CommandLine }" 2>/dev/null | tr -d '\r')
  here=$(pwd -W 2>/dev/null || pwd)
  case "$cmd" in
    *"$(basename "$here")"*) ok "served by a Metro rooted in $(basename "$here")" ;;
    '')                      warn "answering, but could not identify the listening process" ;;
    *)                       warn "answering, but the listener does not look rooted here: $cmd" ;;
  esac
fi

echo "adb reverse"
"$A" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1
if "$A" reverse --list 2>/dev/null | grep -q "tcp:$PORT"; then
  ok "tcp:$PORT (re-asserted and verified — it drops on its own under load)"
else
  bad "tcp:$PORT not listed after setting it"
fi

echo "git"
head=$(git rev-parse --short HEAD 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null)
if [ -n "$dirty" ]; then
  warn "HEAD $head, working tree DIRTY — the device will run the tree, not the commit:"
  echo "$dirty" | sed 's/^/        /'
else
  ok "HEAD $head, tree clean"
fi

if [ -n "$MARKER" ]; then
  echo "served bundle"
  tmp="${TEMP:-/tmp}/preflight-bundle.js"
  code=$(curl -s -m 600 "http://127.0.0.1:$PORT/index.bundle?platform=android&dev=true&minify=false" -o "$tmp" -w '%{http_code}' 2>/dev/null)
  if [ "$code" != "200" ]; then
    bad "bundle fetch returned $code"
  elif grep -q -- "$MARKER" "$tmp"; then
    ok "contains '$MARKER' ($(wc -c < "$tmp") bytes)"
  else
    bad "does NOT contain '$MARKER' — Metro is serving something other than this tree"
  fi
fi

if [ -n "$RELOAD" ]; then
  echo "reload"
  "$A" shell am force-stop "$PKG" >/dev/null 2>&1
  "$A" logcat -c >/dev/null 2>&1
  "$A" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  # The dev client opens on its launcher; the first DEVELOPMENT SERVERS row is
  # the project. A fixed coordinate because those rows are Compose nodes that
  # uiautomator does not report, same as the picker's tabs.
  curl -s -m 20 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1
  "$A" shell input tap "${DEV_SERVER_XY:-718 722}"
  echo "  tapped the first development server row (${DEV_SERVER_XY:-718 722}: not in the dump)"
  for i in $(seq 1 60); do
    if "$A" logcat -d -s ReactNativeJS:V 2>/dev/null | grep -q 'Running "main"'; then
      ok "JS running (bundle re-fetched, so the device is on the current tree)"
      break
    fi
    curl -s -m 3 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1
    [ "$i" = 60 ] && bad "JS never reported Running \"main\""
  done
fi

echo
[ "$fail" = 0 ] && echo "preflight ok" || echo "preflight FAILED"
exit "$fail"
