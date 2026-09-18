// Answer Phase 0's Q1 and Q3 from a screenshot on disk, with no device.
//
//   node tools/probe.mjs shot.png [more.png ...]
//   node tools/probe.mjs shot.png --box=40,1180,980,64
//   node tools/probe.mjs shot.png --grid          # the old blind scan
//
// Q1 asks whether a flat fill sampled from around a box looks seamless. The
// fill is the ring's mean, so the seam shows exactly to the degree the ring is
// not flat — which makes the ring's standard deviation a prediction, available
// before anyone looks at anything.
//
// It is measured over the rows Cover would actually target: thin bands of ink
// sitting on flat ground, like a like-count row. An earlier version scanned a
// blind grid of boxes across the whole image and reported ~68% "textured",
// which was true and meaningless — most of those boxes sat over a photograph,
// and nobody covers a photograph. The population was the instrument's own
// invention rather than the thing under test.
//
// What it still cannot do: decide. A number below the eye's threshold is a
// judgement on a real display. This says where to look, and how hard.
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';
import {
  ringStats,
  ringBackground,
  rowInkProfile,
  detectStatusBar,
  inkRuns,
  zoneInk,
  looksLikeStatusBar,
  cropBackground,
} from '../src/pixels.js';

const THICKNESS = 6;
const MAX_TARGET_H = 90;   // taller than this is a content block, not a chrome row
const MIN_GAP = 4;         // a fill needs flat ground to be sampled from

const BUCKETS = [
  { max: 1, label: 'flat        (<1)' },
  { max: 3, label: 'near-flat   (1-3)' },
  { max: 8, label: 'gradient    (3-8)' },
  { max: Infinity, label: 'textured    (>8)' },
];

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return +sorted[i].toFixed(2);
}

function histogram(values, total) {
  let lower = -Infinity;
  const lines = [];
  for (const b of BUCKETS) {
    const n = values.filter((v) => v > lower && v <= b.max).length;
    lines.push(`     ${b.label}  ${String(n).padStart(4)}  ` +
      `${((n / total) * 100).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round((n / total) * 40))}`);
    lower = b.max;
  }
  return lines.join('\n');
}

function report(path, opts) {
  const bytes = readFileSync(path);
  let img;
  try {
    img = decodePng(bytes);
  } catch (e) {
    console.log(`\n=== ${path} ===`);
    console.log(`  cannot decode: ${e.message}`);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      console.log('  that is a JPEG. Re-save as PNG, or run this question on the device.');
    }
    return;
  }

  console.log(`\n=== ${path} ===`);
  console.log(`  ${img.width}x${img.height}  colorType=${img.colorType}  ` +
    `${((img.width * img.height) / 1e6).toFixed(2)}MP  ` +
    `${((img.width * img.height * 4) / (1024 * 1024)).toFixed(1)}MiB as RGBA`);

  const full = rowInkProfile(img.buf, img.rowBytes, img.width, img.height, img.height);

  // --- Q3 -----------------------------------------------------------------
  const sb = detectStatusBar(full.subarray(0, Math.min(400, img.height)));
  if (!sb.detected) {
    console.log(`\n  Q3 status bar: NOT DETECTED (${sb.reason})`);
  } else {
    const zones = zoneInk(img.buf, img.rowBytes, img.width, sb.inkAt, sb.cut);
    const v = looksLikeStatusBar(zones, sb.cut, img.height);
    console.log(`\n  Q3 boundary found at row ${sb.cut} (${(sb.cut / img.height * 100).toFixed(2)}% of height)`);
    console.log(`     zone ink across the band: [${Array.from(zones, (z) => z.toFixed(3)).join(' ')}]`);
    console.log(`     looks like a status bar? ${v.likely ? 'YES' : 'NO'}` +
      (v.reasons.length ? `  — ${v.reasons.join('; ')}` : ''));
    if (!v.likely) {
      console.log('     => auto-trim must NOT fire here. This is an app header, not chrome.');
    }
  }

  // --- Q1 -----------------------------------------------------------------
  const runs = inkRuns(full).filter(
    (r) => r.length <= MAX_TARGET_H && r.gapAbove >= MIN_GAP && r.gapBelow >= MIN_GAP,
  );

  console.log(`\n  Q1 Cover targets — thin ink rows on flat ground (<=${MAX_TARGET_H}px tall)`);
  if (!runs.length) {
    console.log('     none found. Nothing here has the shape Cover handles.');
  } else {
    const rows = [];
    for (const r of runs) {
      const box = { x: 0, y: r.start, w: img.width, h: r.length };
      const mean = ringStats(img.buf, img.rowBytes, img.width, img.height, box, THICKNESS);
      const bg = ringBackground(img.buf, img.rowBytes, img.width, img.height, box, THICKNESS);
      if (!mean || !bg) continue;
      rows.push({
        ...r,
        meanHex: mean.hex,
        meanSd: Math.max(...mean.stddev),
        bgHex: bg.hex,
        spread: bg.spread,
        coverage: bg.coverage,
      });
    }
    const spreads = rows.map((r) => r.spread).sort((a, b) => a - b);
    console.log(`     ${rows.length} target rows.  Background spread (the seam predictor):  ` +
      `p50 ${pct(spreads, 50)}   p90 ${pct(spreads, 90)}   max ${pct(spreads, 100)}`);
    console.log(histogram(rows.map((r) => r.spread), rows.length));
    console.log('     y / h / modal fill / spread / coverage  ||  mean fill / mean sd');
    for (const r of rows.sort((a, b) => b.spread - a.spread)) {
      const flag = r.spread <= 1 ? 'seamless' : r.spread <= 3 ? '~ok' : 'SEAM';
      const lowCov = r.coverage < 0.6 ? '  <- ring is mostly not background' : '';
      console.log(`       ${String(r.start).padStart(5)} ${String(r.length).padStart(3)}  ` +
        `${r.bgHex}  ${r.spread.toFixed(2).padStart(6)}  ${(r.coverage * 100).toFixed(0).padStart(3)}%  ` +
        `${flag.padEnd(8)} || ${r.meanHex}  ${r.meanSd.toFixed(2).padStart(6)}${lowCov}`);
    }
    const drifted = rows.filter((r) => r.meanHex !== r.bgHex);
    if (drifted.length) {
      console.log(`\n     ${drifted.length}/${rows.length} rows: a MEAN fill differs from the modal ` +
        `background. Worst drift:`);
      const worstDrift = drifted.sort((a, b) => b.meanSd - a.meanSd)[0];
      console.log(`       y=${worstDrift.start}  modal ${worstDrift.bgHex}  vs  mean ${worstDrift.meanHex}` +
        `  — text in the sampling ring pulls the mean off the background.`);
    }
  }

  // --- Phase 1: the card background, four-edge agreement ------------------
  console.log('\n  Card background — sampled from the four inside edges of a crop');
  const crops = [
    { label: 'whole image', rect: { x: 0, y: 0, w: img.width, h: img.height } },
    {
      label: 'centred 60%',
      rect: {
        x: Math.round(img.width * 0.2),
        y: Math.round(img.height * 0.2),
        w: Math.round(img.width * 0.6),
        h: Math.round(img.height * 0.6),
      },
    },
    {
      label: 'top third',
      rect: { x: 0, y: 0, w: img.width, h: Math.round(img.height / 3) },
    },
  ];
  for (const c of crops) {
    const bg = cropBackground(img.buf, img.rowBytes, img.width, img.height, c.rect);
    const edgeHexes = Object.entries(bg.edges || {})
      .map(([k, v]) => `${k[0]}:${v ? v.hex : '--'}`)
      .join(' ');
    if (bg.source === 'sampled') {
      console.log(`     ${c.label.padEnd(12)} SAMPLED  ${bg.hex}  ` +
        `edge spread ${bg.spread}  edges differ by ${bg.maxEdgeDiff}   [${edgeHexes}]`);
    } else {
      console.log(`     ${c.label.padEnd(12)} FALLBACK ${bg.hex || '--'}  ` +
        `${bg.reason}${bg.luma !== undefined ? `, luma ${bg.luma}` : ''}   [${edgeHexes}]`);
    }
  }

  // --- the old blind grid, only on request --------------------------------
  if (opts.grid) {
    const BOX_W = 300;
    const BOX_H = 40;
    const STRIDE = 64;
    const boxes = [];
    for (let y = THICKNESS; y + BOX_H + THICKNESS <= img.height; y += STRIDE) {
      for (let x = THICKNESS; x + BOX_W + THICKNESS <= img.width; x += STRIDE) {
        const s = ringStats(img.buf, img.rowBytes, img.width, img.height,
          { x, y, w: BOX_W, h: BOX_H }, THICKNESS);
        if (s) boxes.push(Math.max(...s.stddev));
      }
    }
    const sorted = [...boxes].sort((a, b) => a - b);
    console.log(`\n  (--grid) ${boxes.length} blind boxes, mostly over content nobody covers:`);
    console.log(`     p50 ${pct(sorted, 50)}   p90 ${pct(sorted, 90)}   max ${pct(sorted, 100)}`);
  }

  if (opts.box) {
    const [x, y, w, h] = opts.box;
    const s = ringStats(img.buf, img.rowBytes, img.width, img.height, { x, y, w, h }, THICKNESS);
    console.log(`\n  --box ${x},${y},${w},${h}:  ` +
      (s ? `fill ${s.hex}  stddev ${JSON.stringify(s.stddev)}  maxDev ${s.maxDev}  n=${s.n}`
         : 'no ring (box covers the image)'));
  }
}

// --- main -------------------------------------------------------------------
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const boxArg = args.find((a) => a.startsWith('--box'));
const opts = {
  grid: args.includes('--grid'),
  box: boxArg ? boxArg.split('=')[1].split(',').map(Number) : null,
};

if (!files.length) {
  console.log(`Usage: node tools/probe.mjs <screenshot.png> [...] [--box=x,y,w,h] [--grid]

Answers Phase 0 Q1 (ring flatness over the rows Cover would actually target)
and Q3 (top-boundary detection, and whether it is really a status bar).
Q2, Q4 and Q5 need the device.`);
  process.exit(2);
}

for (const f of files) report(f, opts);
console.log('\nThe number predicts the seam; the device decides. Q2, Q4, Q5 need the phone.');
