// Moves the Uzbek and English texts written inline in the page script — L("ru", "uz", "en") — into per-language tables.
// stdin: the page script. stdout: JSON { code, uz: [...], en: [...] } where every such call has become L("ru", n) and n is
// the row of both tables (en[n] is null when the call had no English and the page falls back to its dictionary).
// Only calls whose arguments are all plain string literals are touched; anything computed stays as written.
// Needs acorn (exit code 3 without it: the build then leaves the texts inline).
let acorn; try { acorn = require('acorn'); } catch (e) { process.exit(3); }
let src = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => src += d).on('end', () => {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const str = n => n && (n.type === 'Literal' && typeof n.value === 'string' ? n.value : n.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null);
  const hits = []; const seen = new Set();
  (function walk(n) { if (!n || typeof n.type !== 'string' || seen.has(n)) return; seen.add(n);
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'L' && (n.arguments.length === 2 || n.arguments.length === 3) && n.arguments.every(a => str(a) != null)) hits.push(n);
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(ast);
  const uz = [], en = [], row = new Map(); let code = src;
  hits.sort((a, b) => b.start - a.start); // from the end, so earlier offsets stay valid
  const idx = hits.map(n => { const u = str(n.arguments[1]), e = n.arguments.length === 3 ? str(n.arguments[2]) : null, key = u + '\u0000' + (e == null ? '\u0001' : e); if (!row.has(key)) row.set(key, null); return key; });
  [...row.keys()].sort().forEach((k, i) => { row.set(k, i); const [u, e] = k.split('\u0000'); uz[i] = u; en[i] = e === '\u0001' ? null : e; }); // a stable order: the same texts give the same files
  hits.forEach((n, j) => { code = code.slice(0, n.arguments[1].start) + row.get(idx[j]) + code.slice(n.arguments[n.arguments.length - 1].end); });
  process.stdout.write(JSON.stringify({ code, uz, en, calls: hits.length }));
});
