// Draws every launcher-icon and splash PNG in assets/ from art.mjs. Needs Playwright's
// Chromium (not a dependency): node tools/icon/render.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import { group, svg, PAPER, INK } from './art.mjs';
// 0.928 keeps every pixel inside the 66dp safe circle (measured: 32.55dp of 33).
const S = +process.argv[2] || 0.928;
const out = {
  'android-icon-foreground.png': svg(group('light', S)),
  'android-icon-monochrome.png': svg(group('mono', S)),
  'icon.png': svg(group('light', S * 1.18), PAPER),
  'splash-icon.png': svg(group('light', S)),
  'splash-icon-dark.png': svg(group('dark', S)),
};
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
for (const [f, s] of Object.entries(out)) {
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${s}`);
  await p.locator('svg').screenshot({ path: new URL("../../assets/" + f, import.meta.url).pathname, omitBackground: true });
}
await b.close();
