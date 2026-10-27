const { XMODELS, XPRODUCTS } = require('./extra.js');
const fs = require('fs');
const base = JSON.parse(fs.readFileSync('/tmp/claude-0/-home-claude/9f0c48df-0791-5c13-8b30-34a5c53609ff/scratchpad/vrenders.json', 'utf8'));
const pk = Object.keys(base).find(k => k.startsWith('v55_4'));
const BGS = ['#e8ebe8', '#ebe6e1', '#e4e9ec', '#ece7ea', '#e6eae4', '#ebe9e2'];
const out = {};
for (const [id, key, cat, sub, icon, ru, uz, unit, price, kg, stores, model, col] of XPRODUCTS) {
  if (model === 'bucket') {
    const s = JSON.parse(JSON.stringify(base[pk]));
    s.label = { ...s.label, big: col[2], accent: col[0], accent2: col[1] }; s.bg = BGS[id % 6];
    out['x' + id] = s; continue;
  }
  const parts = XMODELS[model](...(col || []));
  let maxY = 0, W = 0, D = 0;
  for (const q of parts) { maxY = Math.max(maxY, q.p[1] + q.h[1]); W = Math.max(W, Math.abs(q.p[0]) + q.h[0]); D = Math.max(D, Math.abs(q.p[2]) + q.h[2]); }
  const minY = Math.min(...parts.map(q => q.p[1] - q.h[1]));
  const lift = model === 'curtains' ? 0 : 0;
  const diag = Math.sqrt((2 * W) ** 2 + (2 * D) ** 2 + (maxY - Math.min(0, minY)) ** 2);
  const flat = model === 'rug';
  out['x' + id] = { m: 65, model, parts, cam: [flat ? .02 : maxY * .46, Math.max(flat ? diag * 3.4 : diag * 4.25, 3.6), flat ? .85 : .34, .62], bg: BGS[id % 6] };
}
fs.writeFileSync('/tmp/claude-0/-home-claude/9f0c48df-0791-5c13-8b30-34a5c53609ff/scratchpad/xspecs.json', JSON.stringify(out));
console.log(Object.keys(out).length);
