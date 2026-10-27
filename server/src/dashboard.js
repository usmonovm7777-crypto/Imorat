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
}
