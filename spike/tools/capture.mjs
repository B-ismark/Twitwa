// Capture the spike's PHASE0 lines off the device into a file.
//
//   node tools/capture.mjs clear     # before tapping anything
//   node tools/capture.mjs dump      # after, writes results/phase0-device-raw.txt
//
// Why a script and not a pipe: `adb logcat | grep` never terminates, so a
// transcript is the only place the numbers land, and a transcript is the one
// place a measurement must not live. `logcat -d` drains the buffer and exits,
// so the answer becomes a file that survives a compaction.
//
// It also refuses to write an empty capture. A dump of zero lines means the
// buttons were not tapped, or the marker changed, or the device disconnected —
// three different problems that an empty file silently reports as "done".
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ADB = process.env.ADB || join(process.env.ANDROID_HOME || 'D:/AndroidDev/sdk', 'platform-tools', 'adb.exe');
const MARKER = 'PHASE0';
const OUT = 'results/phase0-device-raw.txt';

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const mode = process.argv[2];

if (mode === 'clear') {
  adb('logcat', '-c');
  console.log('logcat buffer cleared. Tap the buttons now, then: node tools/capture.mjs dump');
} else if (mode === 'dump') {
  const raw = adb('logcat', '-d', '-s', 'ReactNativeJS:V');
  const lines = raw.split(/\r?\n/).filter((l) => l.includes(MARKER));
  if (!lines.length) {
    console.error(`no ${MARKER} lines in the buffer (${raw.split(/\r?\n/).length} ReactNativeJS lines total).`);
    console.error('Either nothing was tapped, the app is not the build with the marker, or logcat rotated.');
    process.exit(1);
  }
  mkdirSync('results', { recursive: true });
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`${lines.length} ${MARKER} lines -> ${OUT}`);
  for (const l of lines) console.log('  ' + l.replace(/^.*ReactNativeJS\s*:\s*/, ''));
} else {
  console.log('Usage: node tools/capture.mjs clear | dump');
  process.exit(2);
}
