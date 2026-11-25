// C1 v2, drawn on Android's 108dp canvas. One group, scaled about the centre by S.
export const PAPER = '#F6F4EF', INK = '#15181D', SIGNAL = '#3B5BA8', SIGNAL_DARK = '#8FA9EA';
export function group(mode, S = 1) {
  // mode: 'light' (paper ground), 'dark' (ink ground), 'mono'
  const dark = mode === 'dark';
  const body = dark ? PAPER : INK, ink = dark ? INK : PAPER, blue = dark ? SIGNAL_DARK : SIGNAL;
  const mono = mode === 'mono';
  // knockouts for mono use a mask; colours otherwise
  const cut = mono ? 'black' : ink;
  const parts = `
    <g id="bar" transform="rotate(-9 54 30)">
      <rect x="36" y="25" width="36" height="10" rx="3" fill="${mono ? 'white' : body}"/>
      <rect x="40.5" y="28.5" width="9" height="3" rx="1.5" fill="${cut}"/>
      <rect x="61" y="28" width="7" height="4" rx="1.2" fill="${cut}"/>
    </g>
    <line x1="31" y1="41" x2="77" y2="41" stroke="${mono ? 'white' : blue}" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 6"/>
    <rect x="35" y="46" width="38" height="40" rx="6" fill="${mono ? 'white' : body}"/>
    <rect x="40" y="51" width="28" height="14" rx="3" fill="${mono ? 'black' : blue}"/>
    <rect x="40" y="70" width="28" height="4" rx="2" fill="${cut}"/>
    <rect x="40" y="78" width="18" height="4" rx="2" fill="${cut}"/>`;
  const t = `translate(54 54) scale(${S}) translate(-54 -54)`;
  if (!mono) return `<g transform="${t}">${parts}</g>`;
  return `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108"><g transform="${t}">${parts}</g></mask>
    <rect width="108" height="108" fill="#000" mask="url(#m)"/>`;
}
export const svg = (inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="1024" height="1024">${bg ? `<rect width="108" height="108" fill="${bg}"/>` : ''}${inner}</svg>`;
