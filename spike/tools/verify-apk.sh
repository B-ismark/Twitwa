#!/usr/bin/env bash
# Assert that an APK is signed by THIS project's release key, and not by the
# React Native debug key.
#
# Why this exists. Everything else in this repo checks source. A review pointed
# out that the one input the signing work exists to get right -- which key
# actually signed the artifact -- was the one input nothing checked. The plugin's
# test exercises string surgery on a fixture and can never observe a signature;
# `assembleRelease` with TWITWA_KEYSTORE_PROPERTIES unset produces a
# debug-signed app-release.apk, under the same filename, and exits 0. The only
# signal was one logger.lifecycle line, emitted at configuration time so it also
# fires on every ordinary `expo run:android` -- trained noise by the time it
# matters.
#
# This reads the artifact. It is the only gate here that does.
#
#   tools/verify-apk.sh [path/to.apk]
#
# Exit 0 only if the signer certificate's SHA-256 equals EXPECTED below.
# Exit 2 if it is the Android debug key, named as such, because that is the
# failure this is for and it deserves its own message.
set -uo pipefail

# The release key's certificate fingerprint, read out of the keystore on
# 2026-09-18 with `keytool -list -v`. Recorded here, not read from the keystore
# at run time, on purpose: the check must be able to fail even on a machine that
# has the wrong keystore, or no keystore at all.
EXPECTED="D4:BB:57:2D:CE:98:5D:EF:22:65:AB:90:E3:1F:06:EF:53:43:0E:78:06:70:6F:A8:AC:87:83:64:60:68:09:2B"

# Every RN project shares this one. If an APK carries it, it is not a build
# anyone should hand to another person: anybody can sign an update over it.
DEBUG_CN="CN=Android Debug"

APK="${1:-android/app/build/outputs/apk/release/app-release.apk}"

if [ ! -f "$APK" ]; then
  echo "no APK at $APK" >&2
  echo "build one first:  (cd android && TWITWA_KEYSTORE_PROPERTIES=... ./gradlew assembleRelease)" >&2
  exit 1
fi

# Newest build-tools wins; apksigner is not on PATH in this environment.
APKSIGNER=""
for d in $(ls -d "$ANDROID_HOME/build-tools"/*/ 2>/dev/null | sort -V -r); do
  if [ -f "${d}apksigner.bat" ]; then APKSIGNER="${d}apksigner.bat"; break; fi
  if [ -f "${d}apksigner" ]; then APKSIGNER="${d}apksigner"; break; fi
done
if [ -z "$APKSIGNER" ]; then
  echo "apksigner not found under \$ANDROID_HOME/build-tools" >&2
  exit 1
fi

OUT="$("$APKSIGNER" verify --print-certs "$APK" 2>&1)"
RC=$?

echo "$OUT" | grep -iE "Signer #1 certificate (DN|SHA-256)|^DOES NOT VERIFY|error" || true
echo

if [ $RC -ne 0 ]; then
  echo "FAIL: apksigner could not verify $APK" >&2
  echo "$OUT" >&2
  exit 1
fi

if echo "$OUT" | grep -qF "$DEBUG_CN"; then
  echo "FAIL: this APK is signed with the shared Android DEBUG key." >&2
  echo "Do not distribute it. Anyone can sign an update over it, and the day a" >&2
  echo "real key is introduced every recipient must uninstall, losing their data." >&2
  echo "Cause: TWITWA_KEYSTORE_PROPERTIES was unset or empty when Gradle ran." >&2
  exit 2
fi

# Normalise: apksigner prints the digest lowercase and colonless, keytool prints
# it uppercase with colons. Compare in one form so the constant above can stay
# in the form a human reads out of keytool.
GOT="$(echo "$OUT" | grep -i "Signer #1 certificate SHA-256 digest" | head -1 | sed 's/.*: *//' | tr -d ': \r' | tr 'A-Z' 'a-z')"
WANT="$(echo "$EXPECTED" | tr -d ': ' | tr 'A-Z' 'a-z')"

if [ -z "$GOT" ]; then
  echo "FAIL: could not read a SHA-256 digest out of apksigner's output" >&2
  exit 1
fi

if [ "$GOT" != "$WANT" ]; then
  echo "FAIL: signed by an unexpected key." >&2
  echo "  expected ${WANT}" >&2
  echo "  got      ${GOT}" >&2
  echo "An APK signed by a different key cannot update one already installed." >&2
  exit 1
fi

echo "OK: $APK is signed by the Twitwa release key."
echo "    sha256 $GOT"
