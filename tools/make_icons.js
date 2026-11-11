// Renders the Quriliş Go mark («Кирпичная стрелка»: an arrow "forward" laid of bricks, white on orange) into every icon the site
// and the app use. Run: node tools/make_icons.js   (needs Playwright with Chromium; the wordmark uses Inter Display Black if installed).
// The native launch screens (app/assets/splash*.png) are shot from the web intro by a separate step — see PROJECT.md.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const R = path.resolve(__dirname, '..'), ORANGE = '#F2661C';
const BRICKS = [[27, 20, 22], [27, 33, 9.5], [39.5, 33, 22], [27, 46, 22], [52, 46, 22], [27, 59, 9.5], [39.5, 59, 22], [27, 72, 22]].map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="10" rx="2.5"/>`).join('');
// the bricks take `k` of the square and sit in its middle (their own box is 47×62 around 50.5, 51)
const bricks = (k, fill) => `<g fill="${fill}" transform="translate(${(50 - 50.5 * k).toFixed(3)} ${(50 - 51 * k).toFixed(3)}) scale(${k})">${BRICKS}</g>`;
const tile = (px, { k = .725, rx = 22.5, bg = ORANGE, fg = '#fff' } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">${bg ? `<rect width="100" height="100" rx="${rx}" fill="${bg}"/>` : ''}${bricks(k, fg)}</svg>`;
const fontFile = '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf';
const FONT = fs.existsSync(fontFile) ? `@font-face { font-family: QD; src: url(data:font/otf;base64,${fs.readFileSync(fontFile).toString('base64')}); }` : '';
const word = (px, dark) => `<span style="font: 900 ${px}px QD, system-ui, sans-serif; letter-spacing: -.035em; color: ${dark ? '#F6F1EB' : '#1B1917'}">Quriliş<span style="color:${dark ? '#FF8A3D' : ORANGE};margin-left:.18em">go</span></span>`;
const jobs = [ // file, width, height, html, transparent background
  ['icons/icon-1024.png', 1024, 1024, tile(1024, { rx: 0 })],
  ['icons/icon-512.png', 512, 512, tile(512), true],
  ['icons/icon-192.png', 192, 192, tile(192), true],
  ['icons/maskable-512.png', 512, 512, tile(512, { rx: 0, k: .6 })], // the mark stays inside the safe circle
  ['icons/apple-touch-icon.png', 180, 180, tile(180, { rx: 0 })], // iOS rounds the corners itself and wants no transparency
  ['icons/favicon-64.png', 64, 64, tile(64, { k: .8 }), true],
  ['icons/og-image.png', 1200, 630, `<div style="width:1200px;height:630px;background:linear-gradient(105deg,#6E1A08 0%,#A12A0A 30%,#C9400D 58%,#E8650F 82%,#F59A1C 100%);display:flex;align-items:center;gap:56px;padding:0 90px;box-sizing:border-box"><div style="background:#fff;border-radius:72px;box-shadow:0 30px 70px rgba(60,10,0,.35);display:grid">${tile(310, { bg: null, fg: ORANGE, k: .76 })}</div><div style="display:grid;gap:18px"><span style="font: 900 92px QD, system-ui, sans-serif; letter-spacing:-.035em; color:#fff">Quriliş<span style="color:#FFE07A;margin-left:.18em">go</span></span><span style="font: 600 34px system-ui, sans-serif; color: rgba(255,248,240,.92); line-height:1.25">Строительные магазины Ташкента<br>Подберём, сравним, привезём</span></div></div>`],
  ['app/assets/icon-only.png', 1024, 1024, tile(1024, { rx: 0 })],
  ['app/assets/icon-background.png', 1024, 1024, `<div style="width:1024px;height:1024px;background:${ORANGE}"></div>`],
  ['app/assets/icon-foreground.png', 1024, 1024, tile(1024, { bg: null, k: .5 }), true], // Android adaptive icon: only the middle two thirds are shown
  ['brand/qurilish-go-logo.png', 2000, 560, `<div style="width:2000px;height:560px;display:flex;align-items:center;gap:60px;padding:0 80px;box-sizing:border-box">${tile(400)}${word(250)}</div>`, true],
  ['brand/qurilish-go-logo-dark.png', 2000, 560, `<div style="width:2000px;height:560px;display:flex;align-items:center;gap:60px;padding:0 80px;box-sizing:border-box">${tile(400)}${word(250, true)}</div>`, true],
];
(async () => {
  const b = await chromium.launch();
  for (const [f, w, h, html, transparent] of jobs) {
    const pg = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await pg.setContent(`<style>${FONT} html,body{margin:0;background:transparent} svg{display:block}</style>${html}`, { waitUntil: 'load' }); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(150);
    await pg.screenshot({ path: path.join(R, f), omitBackground: !!transparent, clip: { x: 0, y: 0, width: w, height: h } }); await pg.close();
  }
  await b.close();
  fs.writeFileSync(path.join(R, 'brand/qurilish-go-mark.svg'), tile(512).replace('<svg ', '<svg role="img" aria-label="Quriliş Go" ') + '\n');
  console.log('icons written:', jobs.length + 1);
})();
