/* The ready first screen of the home page.
   Runs the built site in a headless browser the way a first-time visitor opens it (nothing saved, Russian, the home page) —
   once at a phone's size and once at a computer's — and takes the header, the first blocks of the home and the phone's tab bar
   exactly as the page script rendered them. build_site.py puts both into index.html as <template> elements; a small inline
   script shows the fitting one before the page script has even been requested (see "__pre" in the page's first script).
   The page is the single source of the markup: nothing is written by hand here, so the ready screen cannot drift from the page.

   Usage: node tools/prerender.js <site folder>   → JSON on stdout: { m: {hdr, app, tabbar, lcp}, d: {…} }
   Needs the "playwright" package with its Chromium. Without it the script exits with code 3 and the site is built without
   the ready screen (it then renders from the page script as before). */
const http = require("http"), fs = require("fs"), path = require("path");
let chromium; try { ({ chromium } = require("playwright")); } catch { process.stderr.write("playwright is not installed\n"); process.exit(3); }
const ROOT = path.resolve(process.argv[2] || ".");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
const SIZES = { m: { viewport: { width: 412, height: 823 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, d: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1 } };
/* in the page: when the first render is done, copy the three containers. Of the home only what a first screen shows is kept:
   blocks held back for later (.late), switched off or lying far below are left out, and a rail keeps its first cards. */
const hook = () => {
  window.__snap = () => {
    const drop = [], wrap = document.querySelector("#app > .wrap");
    if (wrap) {
      for (const c of wrap.children) if (c.classList.contains("late") || c.hidden || getComputedStyle(c).display === "none" || c.getBoundingClientRect().top > 1150) drop.push(c);
      for (const rail of wrap.querySelectorAll(".rail")) [...rail.children].forEach((c, i) => { if (i >= 3 && c.getBoundingClientRect().left > innerWidth * 1.4) drop.push(c); });
    }
    for (const c of drop) c.setAttribute("data-snapdrop", "");
    const pick = id => { const el = document.getElementById(id); if (!el) return ""; const c = el.cloneNode(true); c.querySelectorAll("[data-snapdrop]").forEach(n => n.remove()); return c.innerHTML; };
    const cls = [...document.documentElement.classList].filter(c => !/^(boot|boot-plain|pre|intro-on|xmas|hd-sc|kb)$/.test(c) && /^[\w-]+$/.test(c)).join(" "); // the page's state classes the layout depends on (r-home: the home's own header on a phone)
    window.__snapOut = { hdr: pick("hdr"), app: pick("app"), tabbar: pick("tabbar"), cls };
    for (const c of drop) c.removeAttribute("data-snapdrop");
  };
};
/* the largest picture of the first screen: the page's head preloads it, so the browser asks for it with the first bytes */
const largest = () => {
  let best = null, area = 0;
  for (const i of document.querySelectorAll("#app img, #hdr img")) {
    const r = i.getBoundingClientRect(), w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (w * h > area) { area = w * h; best = i; }
  }
  return best ? { src: best.getAttribute("src"), srcset: best.getAttribute("srcset") || "", sizes: best.getAttribute("sizes") || "", area: Math.round(area) } : null;
};
async function take(browser, base, size, time) {
  const ctx = await browser.newContext({ ...size, locale: "ru-RU", timezoneId: "Asia/Tashkent", serviceWorkers: "block" });
  const page = await ctx.newPage();
  if (time && page.clock) await page.clock.install({ time });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort()); // the markup does not depend on the fonts
  await page.addInitScript(hook);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__snapOut, null, { timeout: 20000 });
  const out = await page.evaluate(() => window.__snapOut);
  out.lcp = await page.evaluate(largest);
  await ctx.close();
  return out;
}
(async () => {
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const res = {};
  try {
    for (const [k, size] of Object.entries(SIZES)) {
      const a = await take(browser, base, size, new Date("2026-06-03T10:30:00+05:00")), b = await take(browser, base, size, new Date("2026-06-07T22:45:00+05:00"));
      // a ready screen that changes with the hour or the day would show stale words: such a page is not taken
      const same = a.hdr === b.hdr && a.app === b.app && a.tabbar === b.tabbar && a.cls === b.cls;
      const now = await take(browser, base, size, 0);
      res[k] = { ...now, stable: same, size: size.viewport };
      if (!now.app || now.app.length < 2000) throw new Error("the home page did not render at " + JSON.stringify(size.viewport));
    }
  } finally { await browser.close(); srv.close(); }
  process.stdout.write(JSON.stringify(res));
})().catch(e => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
