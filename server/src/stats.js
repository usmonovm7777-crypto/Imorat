import { readJson, int } from "./http.js";

/* Anonymous shop analytics for sellers: product views and add-to-cart counts per day.
   Only counters are stored (no user ids or IPs), so it is safe to keep them for a long time. */
const day = t => new Date(t + 5 * 3600000).toISOString().slice(0, 10); // Tashkent date

export function registerStats({ r, db, lim, needSeller }) {
  const bump = db.raw.prepare("INSERT INTO events_daily(day,product_id,store_id,kind,n) VALUES(?,?,?,?,1) ON CONFLICT(day,product_id,store_id,kind) DO UPDATE SET n=n+1");
  r.post("/api/events", async req => {
    lim.hit("ev:" + req.ip, 1500, 60_000); // generous: many phones share one IP on mobile networks
    const b = await readJson(req, 32 * 1024);
    const evs = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    const d = day(Date.now()); let n = 0;
    db.tx(() => {
      for (const e of evs) {
        const kind = e?.t === "cart" ? "cart" : e?.t === "view" ? "view" : null, pid = int(e?.id, 1, 1e9);
        if (!kind || !pid) continue;
        const store = kind === "cart" && typeof e.store === "string" ? e.store.slice(0, 40) : "";
        if (!db.get("SELECT 1 FROM products WHERE id=?", pid)) continue;
        bump.run(d, pid, store, kind); n++;
      }
    });
    return { ok: true, n };
  });
  r.get("/api/seller/stats", (req, res, p, url) => {
    const { s } = needSeller(req);
    const days = Math.min(90, Math.max(7, int(url.searchParams.get("days") || 30, 7, 90) || 30));
    const since = day(Date.now() - (days - 1) * 86400000), sinceTs = Date.now() - days * 86400000;
    const mine = db.all(`SELECT p.id, p.ru, p.uz, o.price, o.stock FROM offers o JOIN products p ON p.id=o.product_id WHERE o.store_id=? AND p.active=1`, s.id);
    const ids = new Set(mine.map(x => x.id));
    const views = new Map(db.all(`SELECT product_id, SUM(n) n FROM events_daily WHERE kind='view' AND day>=? AND product_id IN (SELECT product_id FROM offers WHERE store_id=?) GROUP BY product_id`, since, s.id).map(x => [x.product_id, x.n]));
    const carts = new Map(db.all(`SELECT product_id, SUM(n) n FROM events_daily WHERE kind='cart' AND day>=? AND store_id=? GROUP BY product_id`, since, s.id).map(x => [x.product_id, x.n]));
    const ordered = new Map();
    for (const sh of db.all("SELECT sh.lines, sh.status FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND o.created_at>=?", s.id, sinceTs))
      for (const l of JSON.parse(sh.lines)) if (ids.has(l.id)) { const x = ordered.get(l.id) || { n: 0, q: 0, sum: 0 }; x.n++; x.q += l.q; if (sh.status !== "cancelled") x.sum += l.price * l.q; ordered.set(l.id, x); }
    const market = new Map(db.all(`SELECT o.product_id, MIN(o.price) mn, COUNT(*) c FROM offers o JOIN stores st ON st.id=o.store_id AND st.status='active' WHERE o.store_id<>? AND o.product_id IN (SELECT product_id FROM offers WHERE store_id=?) GROUP BY o.product_id`, s.id, s.id).map(x => [x.product_id, x]));
    const products = mine.map(x => {
      const m = market.get(x.id), o = ordered.get(x.id) || { n: 0, q: 0, sum: 0 };
      return { id: x.id, ru: x.ru, uz: x.uz, price: x.price, stock: x.stock, views: views.get(x.id) || 0, carts: carts.get(x.id) || 0, orders: o.n, qty: o.q, revenue: o.sum,
        market_min: m ? m.mn : null, rivals: m ? m.c : 0, diff: m ? Math.round((x.price - m.mn) * 1000 / m.mn) / 10 : null };
    });
    const daily = db.all(`SELECT day, kind, SUM(n) n FROM events_daily WHERE day>=? AND ((kind='view' AND product_id IN (SELECT product_id FROM offers WHERE store_id=?)) OR (kind='cart' AND store_id=?)) GROUP BY day, kind`, since, s.id, s.id);
    const series = [];
    for (let i = days - 1; i >= 0; i--) { const d = day(Date.now() - i * 86400000); series.push({ day: d, views: daily.find(x => x.day === d && x.kind === "view")?.n || 0, carts: daily.find(x => x.day === d && x.kind === "cart")?.n || 0 }); }
    const sum = k => products.reduce((a, x) => a + x[k], 0);
    const withRivals = products.filter(x => x.market_min != null);
    return {
      days, series, products,
      totals: { views: sum("views"), carts: sum("carts"), orders: sum("orders"), revenue: sum("revenue") },
      prices: { compared: withRivals.length, cheapest: withRivals.filter(x => x.price <= x.market_min).length, pricier: withRivals.filter(x => x.diff > 5).length }
    };
  });
}
