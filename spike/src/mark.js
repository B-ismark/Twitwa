// The C1 mark as plain data, and the ONE place its shapes are written down.
//
// Two consumers read it: `tools/icon/art.mjs` builds the launcher-icon and
// splash SVGs from it, and `Mark` in App.js draws the same shapes on the empty
// screen with react-native-svg. They used to be one hand-written SVG string in
// art.mjs, which is exactly how an in-app copy would have drifted from the
// icon the first time somebody nudged a radius. No react-native import, so
// node can load it for the art script and for the test.
//
// Drawn on Android's 108-unit adaptive-icon canvas. Do not change a number
// here without re-running `node tools/icon/render.mjs`: the PNGs in assets/
// are rendered from these values.

// The canvas is 108 units square (Android's adaptive-icon canvas); its centre:
export const CENTRE = 54;

// The launcher scale (render.mjs's default): it keeps every pixel inside the
// 66-unit safe circle that Android's masks leave alone. Measured 32.55 of 33.
export const LAUNCHER_SCALE = 0.928;
export const SAFE_RADIUS = 33;

export const PAPER = '#F6F4EF';
export const INK = '#15181D';
export const SIGNAL = '#3B5BA8';
export const SIGNAL_DARK = '#8FA9EA';

/**
 * Colour per role, per mode. `mono` is the themed-icon layer: Android tints
 * the white and drops the black, so its "colours" are mask values.
 * `line` and `screen` are both the accent in the coloured modes and differ
 * only in the mask, where the dashed line is kept and the screen is knocked out.
 */
export const COLOURS = {
  light: { body: INK, cut: PAPER, line: SIGNAL, screen: SIGNAL },
  dark: { body: PAPER, cut: INK, line: SIGNAL_DARK, screen: SIGNAL_DARK },
  mono: { body: 'white', cut: 'black', line: 'white', screen: 'black' },
};

/** The tilted bar (the "tweet"): a body with two knocked-out slots. */
export const BAR = {
  rotate: { deg: -9, cx: 54, cy: 30 },
  rects: [
    { x: 36, y: 25, width: 36, height: 10, rx: 3, fill: 'body' },
    { x: 40.5, y: 28.5, width: 9, height: 3, rx: 1.5, fill: 'cut' },
    { x: 61, y: 28, width: 7, height: 4, rx: 1.2, fill: 'cut' },
  ],
};

/** The dashed line between the bar and the card: the crop being drawn. */
export const LINE = {
  x1: 31, y1: 41, x2: 77, y2: 41,
  strokeWidth: 3, dash: [4, 6], fill: 'line',
};

/** The card: a body, its screen and two text lines. */
export const CARD = [
  { x: 35, y: 46, width: 38, height: 40, rx: 6, fill: 'body' },
  { x: 40, y: 51, width: 28, height: 14, rx: 3, fill: 'screen' },
  { x: 40, y: 70, width: 28, height: 4, rx: 2, fill: 'cut' },
  { x: 40, y: 78, width: 18, height: 4, rx: 2, fill: 'cut' },
];

/** The colours for a mode name; anything but 'dark' or 'mono' is light. */
export function coloursFor(mode) {
  return mode === 'dark' ? COLOURS.dark : mode === 'mono' ? COLOURS.mono : COLOURS.light;
}

const rotate = (px, py, { deg, cx, cy }) => {
  const a = (deg * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
};

// The farthest a rounded rectangle gets from a point: the farthest corner-arc
// centre, plus the radius. Corners alone overshoot (35,86 reads 37.2 at scale 1
// where the pixels reach 35.1), which is why the radius is not ignored.
function reachOfRect(r, from, turn) {
  const inset = [
    [r.x + r.rx, r.y + r.rx], [r.x + r.width - r.rx, r.y + r.rx],
    [r.x + r.rx, r.y + r.height - r.rx], [r.x + r.width - r.rx, r.y + r.height - r.rx],
  ];
  let far = 0;
  for (const [px, py] of inset) {
    const [qx, qy] = turn ? rotate(px, py, turn) : [px, py];
    far = Math.max(far, Math.hypot(qx - from, qy - from) + r.rx);
  }
  return far;
}

/**
 * The farthest any part of the mark is from the canvas centre once it is
 * scaled about that centre by `scale`, in canvas units. The round caps of the
 * dashed line count.
 */
export function reach(scale = 1) {
  let far = 0;
  for (const r of BAR.rects) far = Math.max(far, reachOfRect(r, CENTRE, BAR.rotate));
  for (const r of CARD) far = Math.max(far, reachOfRect(r, CENTRE, null));
  const half = LINE.strokeWidth / 2;
  for (const [x, y] of [[LINE.x1, LINE.y1], [LINE.x2, LINE.y2]]) {
    far = Math.max(far, Math.hypot(x - CENTRE, y - CENTRE) + half);
  }
  return far * scale;
}
