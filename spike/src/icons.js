// The app's icons, as path data on a 24 by 24 grid.
//
// Plain data, no React: `Icon` in App.js hands each string to react-native-svg's
// <Path>, and src/icons.test.mjs can parse every one in node. Stroke-based in
// the Lucide style (2 wide, round caps and joins, no fill), so they sit with
// Material's own chrome without a second weight to match.
//
// WHY NOT lucide-react-native: it is the package whose icons these are, and it
// would bring its whole component tree for seven glyphs. The APK's size is
// phase P5's business, and react-native-svg is the only dependency this needs.
// Share is Lucide's `share-2` (three joined dots), which is also what Android's
// own share glyph is; the rest are `download`, `copy`, `crop`,
// `sliders-horizontal`, `ellipsis-vertical` and `x`.
//
// The paths below are those Lucide shapes (circles rewritten as arcs so every
// glyph is paths only). Lucide is ISC licensed:
//
//   ISC License
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as
//   part of Feather (MIT). All other copyright (c) for Lucide are held by
//   Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any
//   purpose with or without fee is hereby granted, provided that the above
//   copyright notice and this permission notice appear in all copies.
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
//   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
//   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
//   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
//   IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
import { TOUCH } from './theme.js';

export const ICON_GRID = 24;
export const ICON_STROKE = 2;
export const ICON_SIZE = 20;

export const ICONS = {
  share: [
    'M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M3 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M15 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M8.59 13.51l6.83 3.98',
    'M15.41 6.51l-6.82 3.98',
  ],
  save: [
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    'M7 10l5 5 5-5',
    'M12 15V3',
  ],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ],
  crop: [
    'M6 2v14a2 2 0 0 0 2 2h14',
    'M18 22V8a2 2 0 0 0-2-2H2',
  ],
  style: [
    'M21 4h-7', 'M10 4H3', 'M21 12h-9', 'M8 12H3', 'M21 20h-5', 'M12 20H3',
    'M14 2v4', 'M8 10v4', 'M16 18v4',
  ],
  // Three dots, vertical: Android's overflow, not iOS's horizontal ellipsis.
  // Each is a radius-1 circle; the 2 wide round stroke makes it a 4 wide dot.
  more: [
    'M11 5a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    'M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    'M11 19a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  ],
  close: ['M18 6L6 18', 'M6 6l12 12'],
};

/**
 * The side of an icon-only control. Square by construction (one number is
 * both width and height), and never under the touch floor: an icon has no
 * label to widen it, so without a fixed size it would shrink to the glyph.
 * `bar` matches the height of a labelled Action on a bar (TOUCH + 4); `fit` is
 * Close's, which floats over the stage and is its own size.
 */
export const ICON_ONLY = { bar: TOUCH + 4, fit: TOUCH };

/** Gap between an icon and its label, in dp. */
export const ICON_GAP = 8;
