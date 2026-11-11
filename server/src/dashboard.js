import { HttpError } from "./http.js";
/* Owner dashboard: how the marketplace is doing, in one request. Tashkent days. */
const day = t => new Date(t + 5 * 3600000).toISOString().slice(0, 10);

export function registerDashboard({ r, db, needAdmin }) {
  r.get("/api/admin/dashboard", (req, res, p, url) => {
    needAdmin(req);
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30)), now = Date.now(), since = now - days * 86400000, prevSince = since - days * 86400000;
    const ships = db.all(`SELECT sh.store_id, sh.status, sh.lines, sh.goods, sh.commission, sh.cancel_reason, sh.accepted_at, sh.start_at, o.created_at, o.user_id
      FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE o.created_at>=?`, prevSince);
    const cur = ships.filter(s => s.created_at >= since), prev = ships.filter(s => s.created_at < since);
    const ok = s => s.status !== "cancelled", goodsOf = s => s.goods || JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0);
    const orders = db.all("SELECT id, user_id, created_at, status, total FROM orders WHERE created_at>=?", prevSince);
    const oc = orders.filter(o => o.created_at >= since), op = orders.filter(o => o.created_at < since);
    const gmv = list => list.filter(ok).reduce((a, s) => a + goodsOf(s), 0);
    const buyers = new Set(oc.map(o => o.user_id));
    const repeat = [...buyers].filter(u => db.get("SELECT COUNT(*) n FROM orders WHERE user_id=?", u).n > 1).length;
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = day(now - i * 86400000), dayShips = cur.filter(s => day(s.created_at) === d);
      series.push({ day: d, orders: oc.filter(o => day(o.created_at) === d).length, gmv: gmv(dayShips) });
    }
    const users = db.all("SELECT created_at FROM users WHERE created_at>=?", since);
    series.forEach(x => { x.users = users.filter(u => day(u.created_at) === x.day).length; });
    // products and stores
    const prod = new Map(), store = new Map();
    for (const s of cur) {
      const st = store.get(s.store_id) || { orders: 0, gmv: 0, fail: 0, acc: [], done: 0 };
      st.orders++;
      if (ok(s)) { st.gmv += goodsOf(s); for (const l of JSON.parse(s.lines)) { const x = prod.get(l.id) || { id: l.id, name: l.name, q: 0, sum: 0 }; x.q += l.q; x.sum += l.price * l.q; prod.set(l.id, x); } }
      if (s.status === "cancelled" && ["not_accepted", "out_of_stock", "not_shipped"].includes(s.cancel_reason)) st.fail++;
      if (["delivered", "picked"].includes(s.status)) st.done++;
      if (s.accepted_at && s.start_at && s.accepted_at >= s.start_at) st.acc.push((s.accepted_at - s.start_at) / 60000);
      store.set(s.store_id, st);
    }
    const names = Object.fromEntries(db.all("SELECT id, name FROM stores").map(x => [x.id, x.name]));
    const stores = [...store].map(([id, x]) => ({ id, name: names[id] || id, orders: x.orders, gmv: x.gmv, fail: x.fail, done: x.done, accept_min: x.acc.length ? Math.round(x.acc.reduce((a, b) => a + b, 0) / x.acc.length) : null, fail_pct: Math.round(x.fail * 100 / x.orders) }));
    const ev = db.all("SELECT kind, SUM(n) n FROM events_daily WHERE day>=? GROUP BY kind", day(since));
    const cnt = sql => db.get(sql).n;
    return {
      days,
      totals: {
        orders: oc.length, orders_prev: op.length, gmv: gmv(cur), gmv_prev: gmv(prev), commission: cur.filter(ok).reduce((a, s) => a + (s.commission || 0), 0),
        avg_check: oc.length ? Math.round(gmv(cur) / Math.max(1, oc.filter(o => o.status !== "cancelled").length)) : 0,
        buyers: buyers.size, repeat_pct: buyers.size ? Math.round(repeat * 100 / buyers.size) : 0, new_users: users.length,
        cancel_pct: cur.length ? Math.round(cur.filter(s => s.status === "cancelled").length * 100 / cur.length) : 0,
        views: ev.find(x => x.kind === "view")?.n || 0, carts: ev.find(x => x.kind === "cart")?.n || 0
      },
      counts: {
        users: cnt("SELECT COUNT(*) n FROM users"), stores_active: cnt("SELECT COUNT(*) n FROM stores WHERE status='active'"), stores_pending: cnt("SELECT COUNT(*) n FROM stores WHERE status='pending'"),
        masters_active: cnt("SELECT COUNT(*) n FROM masters WHERE status='active'"), masters_pending: cnt("SELECT COUNT(*) n FROM masters WHERE status='pending'"),
        problems_open: cnt("SELECT COUNT(*) n FROM disputes WHERE status IN ('open','answered')"), questions_open: cnt("SELECT COUNT(*) n FROM store_questions WHERE answer IS NULL")
      },
      series,
      top_products: [...prod.values()].sort((a, b) => b.sum - a.sum).slice(0, 10),
      top_stores: [...stores].sort((a, b) => b.gmv - a.gmv).slice(0, 10),
      slow_stores: stores.filter(s => s.fail || (s.accept_min ?? 0) > 10).sort((a, b) => b.fail_pct - a.fail_pct || (b.accept_min ?? 0) - (a.accept_min ?? 0)).slice(0, 10)
    };
  });

  /* ---------- every store on its own: the owner watches each one (orders, turnover, failures, speed, rating, goods) ---------- */
  const FAIL = ["not_accepted", "out_of_stock", "not_shipped"];
  function storeRows(days) {
    const now = Date.now(), since = now - days * 86400000;
    const ships = db.all(`SELECT sh.id, sh.store_id, sh.status, sh.lines, sh.goods, sh.commission, sh.cancel_reason, sh.accepted_at, sh.start_at, o.created_at
      FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.status<>'unpaid'`);
    const goodsOf = s => s.goods || JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0);
    const by = new Map();
    for (const s of ships) { const l = by.get(s.store_id) || []; l.push(s); by.set(s.store_id, l); }
    const rev = Object.fromEntries(db.all("SELECT store_id, AVG(stars) a, COUNT(*) n FROM reviews GROUP BY store_id").map(x => [x.store_id, x]));
    const goods = Object.fromEntries(db.all("SELECT store_id, COUNT(*) n, SUM(stock<=0) oos FROM offers GROUP BY store_id").map(x => [x.store_id, x]));
    const probs = Object.fromEntries(db.all("SELECT store_id, COUNT(*) n FROM disputes WHERE status IN ('open','answered') GROUP BY store_id").map(x => [x.store_id, x.n]));
    return db.all("SELECT s.*, u.name owner_name, u.phone owner_phone FROM stores s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.created_at").map(st => {
      const all = by.get(st.id) || [], cur = all.filter(s => s.created_at >= since), ok = cur.filter(s => s.status !== "cancelled");
      const acc = cur.filter(s => s.accepted_at && s.start_at && s.accepted_at >= s.start_at).map(s => (s.accepted_at - s.start_at) / 60000);
      const fail = cur.filter(s => s.status === "cancelled" && FAIL.includes(s.cancel_reason)).length;
      return {
        id: st.id, name: st.name, status: st.status, d: st.district, owner_name: st.owner_name || "", owner_phone: st.owner_phone || "", phone: st.phone,
        contract_no: st.contract_no || "", created: st.created_at, free_until: st.free_until || null, prices_confirmed_at: st.prices_confirmed_at || null, verified: !!st.verified, logo: st.logo || null,
        orders: cur.length, gmv: ok.reduce((a, s) => a + goodsOf(s), 0), commission: ok.reduce((a, s) => a + (s.commission || 0), 0),
        done: cur.filter(s => ["delivered", "picked"].includes(s.status)).length, cancelled: cur.filter(s => s.status === "cancelled").length,
        fail, fail_pct: cur.length ? Math.round(fail * 100 / cur.length) : 0, accept_min: acc.length ? Math.round(acc.reduce((a, b) => a + b, 0) / acc.length) : null,
        open: all.filter(s => !["delivered", "picked", "cancelled"].includes(s.status)).length, last_order: all.length ? Math.max(...all.map(s => s.created_at)) : null,
        stars: rev[st.id] ? Math.round(rev[st.id].a * 10) / 10 : null, reviews: rev[st.id]?.n || 0,
        products: goods[st.id]?.n || 0, out_of_stock: goods[st.id]?.oos || 0, problems: probs[st.id] || 0
      };
    });
  }
  r.get("/api/admin/stores-overview", (req, res, p, url) => {
    needAdmin(req);
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30));
    return { days, stores: storeRows(days) };
  });
  r.get("/api/admin/stores-overview/:id", (req, res, p, url) => {
    needAdmin(req);
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30)), now = Date.now(), since = now - days * 86400000;
    const row = storeRows(days).find(x => x.id === p.id);
    if (!row) throw new HttpError(404, "not_found", "Store not found");
    const ships = db.all(`SELECT sh.id, sh.status, sh.lines, sh.goods, sh.cancel_reason, o.num, o.created_at FROM shipments sh JOIN orders o ON o.id=sh.order_id
      WHERE sh.store_id=? AND sh.status<>'unpaid' ORDER BY o.created_at DESC`, p.id);
    const goodsOf = s => s.goods || JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0);
    const series = [];
    for (let i = days - 1; i >= 0; i--) { const d = day(now - i * 86400000), ds = ships.filter(s => s.created_at >= since && day(s.created_at) === d); series.push({ day: d, orders: ds.length, gmv: ds.filter(s => s.status !== "cancelled").reduce((a, s) => a + goodsOf(s), 0) }); }
    const prod = new Map();
    for (const s of ships.filter(s => s.created_at >= since && s.status !== "cancelled")) for (const l of JSON.parse(s.lines)) { const x = prod.get(l.id) || { id: l.id, name: l.name, q: 0, sum: 0 }; x.q += l.q; x.sum += l.price * l.q; prod.set(l.id, x); }
    return {
      days, store: row, series,
      recent: ships.slice(0, 12).map(s => ({ num: s.num, t: s.created_at, status: s.status, sum: goodsOf(s), cancel_reason: s.cancel_reason || null })),
      top_products: [...prod.values()].sort((a, b) => b.sum - a.sum).slice(0, 8),
      reviews: db.all("SELECT r.stars, r.text, r.reply, r.created_at, u.name FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.store_id=? ORDER BY r.created_at DESC LIMIT 5", p.id)
    };
  });
}
