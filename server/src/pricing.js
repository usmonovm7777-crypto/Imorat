import { bad, HttpError, int } from "./http.js";

/* Server-side price calculation. Mirrors the website's quote() so totals match,
   but always uses prices and stock from the database, never from the browser. */
export const round = p => (p < 20000 ? Math.round(p / 100) * 100 : Math.round(p / 500) * 500);

export function distanceKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const h = Math.sin((b.la - a.la) * r / 2) ** 2 + Math.cos(a.la * r) * Math.cos(b.la * r) * Math.sin((b.lo - a.lo) * r / 2) ** 2;
  return Math.max(2, 2 * R * Math.asin(Math.sqrt(h)) * 1.35);
}

export function tierOf(ref, product, q, role) {
  if (!ref.tierCats.includes(product.cat)) return 0;
  return q >= 50 ? 0.06 : q >= 10 || role === "pro" ? 0.03 : 0;
}

/* Loads cart lines from the DB and validates them. lines: [{id, store, q}] */
export function loadLines(db, ref, rawLines, user) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw bad("empty_cart", "Cart is empty");
  if (rawLines.length > 150) throw bad("cart_too_big", "Too many lines in the cart");
  const merged = new Map();
  for (const l of rawLines) {
    const id = int(l?.id, 1, 1e9), q = int(l?.q, 1, 100000), store = String(l?.store || "");
    if (!id || !q || !store) throw bad("bad_line", "Each cart line needs id, store and q");
    const k = id + "|" + store; merged.set(k, (merged.get(k) || 0) + q);
  }
  const out = [], problems = [];
  for (const [k, q] of merged) {
    const [id, store] = k.split("|");
    const row = db.get(`SELECT p.*, o.price, o.stock, s.status AS store_status FROM products p
      JOIN offers o ON o.product_id=p.id JOIN stores s ON s.id=o.store_id WHERE p.id=? AND o.store_id=?`, Number(id), store);
    if (!row || !row.active || row.store_status !== "active") { problems.push({ id: Number(id), store, reason: "unavailable" }); continue; }
    if (row.stock < q) problems.push({ id: row.id, store, reason: "stock", stock: row.stock });
    const tier = tierOf(ref, row, q, user?.role);
    out.push({ p: row, store, q, base: row.price, price: tier ? round(row.price * (1 - tier)) : row.price, tier });
  }
  return { lines: out, problems };
}

export function quote(db, ref, { lines, services = [], bundles = [], form = {}, promo = "", user = null, yandexPrices = null }) {
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const dest = D[form.district] || D[user?.district] || D.mirob;
  const vip = !!user?.vip;
  const groups = new Map();
  for (const l of lines) {
    let g = groups.get(l.store);
    if (!g) {
      const s = db.get("SELECT id,name,district,la,lo FROM stores WHERE id=?", l.store);
      g = { store: s, lines: [], sum: 0, kg: 0 }; groups.set(l.store, g);
    }
    g.lines.push(l); g.sum += l.price * l.q; g.kg += l.p.kg * l.q;
  }
  const floors = Math.max(0, (parseInt(form.floor, 10) || 1) - 1);
  const ships = [...groups.values()].map(g => {
    if (form.mode === "pickup") return { g, t: null, dist: 0, price: 0, full: 0 };
    const t = ref.tariffs.find(x => g.kg <= x.maxKg) || ref.tariffs[ref.tariffs.length - 1];
    const from = g.store.la != null ? { la: g.store.la, lo: g.store.lo } : D[g.store.district];
    const to = form.la != null && form.lo != null ? { la: Number(form.la), lo: Number(form.lo) } : dest;
    const dist = distanceKm(from, to);
    const yp = yandexPrices?.[g.store.id];
    let p = yp != null ? yp : t.base + t.perKm * dist;
    if (form.lift && t.id !== "courier") p += ref.fees.LOADER * floors;
    if (form.when === "slot") p *= 0.9;
    const full = round(p) + (form.when === "vip" ? ref.fees.VIP_HOUR_FEE : 0);
    if (vip) { if (t.id === "courier" && g.sum >= ref.fees.VIP_FREE_FROM) p = 0; else if (t.id !== "courier") p *= 0.5; }
    const price = round(p) + (form.when === "vip" && !vip ? ref.fees.VIP_HOUR_FEE : 0);
    return { g, t, dist, price, full, source: yp != null ? "yandex" : "estimate" };
  });
  const qtyOf = id => lines.filter(l => l.p.id === id).reduce((a, l) => a + l.q, 0);
  const goods = ships.reduce((a, s) => a + s.g.sum, 0);
  const del = ships.reduce((a, s) => a + s.price, 0);

  const svcLines = [...new Set(services.map(Number))].map(id => {
    const l = lines.find(x => x.p.id === id); const price = l && ref.service[l.p.sub];
    return price ? { id, q: qtyOf(id), price } : null;
  }).filter(Boolean);
  const svc = svcLines.reduce((a, s) => a + s.price * s.q, 0);

  const byKey = k => db.get("SELECT id FROM products WHERE key=? AND active=1", k)?.id;
  const minPrice = id => db.get("SELECT MIN(o.price) m FROM offers o JOIN stores s ON s.id=o.store_id AND s.status='active' WHERE o.product_id=?", id)?.m || 0;
  let disc = 0; const bundlesApplied = [];
  for (const bid of new Set(bundles)) {
    const b = ref.bundles.find(x => x.id === bid); if (!b) continue;
    const items = b.items.map(([k, q]) => [byKey(k), q]).filter(([id]) => id);
    if (!items.length || !items.every(([id, q]) => qtyOf(id) >= q)) continue;
    disc += Math.round(items.reduce((a, [id, q]) => a + minPrice(id) * q, 0) * ref.bundleOff / 1000) * 1000;
    bundlesApplied.push(bid);
  }

  let pd = 0, promoCode = null;
  const code = String(promo || "").trim().toUpperCase();
  const pr = code && ref.promo[code];
  if (pr) {
    const used = user && db.get("SELECT 1 FROM promo_uses WHERE user_id=? AND code=?", user.id, code);
    if (!used) { pd = Math.min(pr.cap, Math.round(goods * pr.pct / 1000) * 1000); promoCode = code; }
  }
  const total = goods + del + svc - disc - pd;
  return {
    goods, del, svc, disc, pd, total, cash: vip ? Math.round(goods * 0.03) : 0, promo: promoCode, bundles: bundlesApplied, services: svcLines,
    ships: ships.map(s => ({
      store: s.g.store.id, store_name: s.g.store.name, tariff: s.t?.id || null, price: s.price, full: s.full, kg: Math.round(s.g.kg * 100) / 100,
      dist: Math.round(s.dist * 10) / 10, source: s.source || null,
      lines: s.g.lines.map(l => ({ id: l.p.id, name: l.p.ru, q: l.q, price: l.price, base: l.base, tier: l.tier }))
    }))
  };
}

export function assertNoProblems(problems) {
  if (problems.length) throw new HttpError(409, "cart_changed", "Some items are unavailable or out of stock", { problems });
}
