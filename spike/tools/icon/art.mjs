// C1 v2, drawn on Android's 108dp canvas. One group, scaled about the centre by S.
// The shapes live in src/mark.js, which the app draws from too: one mark, two renderers.
import { BAR, CARD, LINE, PAPER, INK, SIGNAL, SIGNAL_DARK, CENTRE, coloursFor } from '../../src/mark.js';
export { PAPER, INK, SIGNAL, SIGNAL_DARK };
const rect = (r, c) =>
  `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}" fill="${c[r.fill]}"/>`;
export function group(mode, S = 1) {
  // mode: 'light' (paper ground), 'dark' (ink ground), 'mono'
  // knockouts for mono use a mask; colours otherwise
  const mono = mode === 'mono';
  const c = coloursFor(mode);
  const { deg, cx, cy } = BAR.rotate;
  const parts = `
    <g id="bar" transform="rotate(${deg} ${cx} ${cy})">
      ${BAR.rects.map((r) => rect(r, c)).join('\n      ')}
    </g>
    <line x1="${LINE.x1}" y1="${LINE.y1}" x2="${LINE.x2}" y2="${LINE.y2}" stroke="${c[LINE.fill]}" stroke-width="${LINE.strokeWidth}" stroke-linecap="round" stroke-dasharray="${LINE.dash.join(' ')}"/>
    ${CARD.map((r) => rect(r, c)).join('\n    ')}`;
  const t = `translate(${CENTRE} ${CENTRE}) scale(${S}) translate(-${CENTRE} -${CENTRE})`;
  if (!mono) return `<g transform="${t}">${parts}</g>`;
  return `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108"><g transform="${t}">${parts}</g></mask>
    <rect width="108" height="108" fill="#000" mask="url(#m)"/>`;
}
export const svg = (inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="1024" height="1024">${bg ? `<rect width="108" height="108" fill="${bg}"/>` : ''}${inner}</svg>`;
