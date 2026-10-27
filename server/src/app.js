import { createServer } from "node:http";
import { createReadStream, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { openDb } from "./db.js";
import { Router, HttpError, bad, readJson, readBody, send, cors, Limiter, clientIp, int, str } from "./http.js";
import { signJwt, verifyJwt, parsePhone, issueOtp, checkOtp, verifyIdToken, newUserId, publicUser } from "./auth.js";
import { createSms } from "./sms.js";
import { loadLines, quote, assertNoProblems } from "./pricing.js";
import { yandexPrices } from "./delivery.js";
import { buildRequest, streamChat } from "./ai.js";

export const STEPS = {
  yandex: ["new", "assembling", "searching", "to_store", "on_way", "delivered"],
  pickup: ["new", "assembling", "ready", "picked"]
};
const SELLER_MOVES = { new: ["assembling", "cancelled"], assembling: ["searching", "ready", "cancelled"], ready: ["picked"], searching: ["to_store"], to_store: ["on_way"], on_way: ["delivered"] };
const SESSION_TTL = 60 * 86400;
const MIME = { ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png" };

export function createApp(cfg, log = console) {
  const db = openDb(cfg.dbPath, cfg.catalogPath);
  const ref = db.ref;
  const sms = createSms(cfg.sms, log);
  const lim = new Limiter();
  const r = new Router();
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const CATS = new Set(ref.cats.map(c => c.id));
  mkdirSync(cfg.uploadsDir, { recursive: true });
  const bumpCatalog = () => db.setMeta("catalog_rev", Date.now());

  /* ---------- helpers ---------- */
  const userFrom = req => {
    const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    const p = m && verifyJwt(m[1], cfg.jwtSecret);
    if (!p || p.typ !== "session") return null;
    return db.get("SELECT * FROM users WHERE id=?", p.sub) || null;
  };
  const need = req => { if (!req.user) throw new HttpError(401, "auth_required", "Sign in first"); return req.user; };
  const isAdmin = u => !!u?.phone && cfg.admins.includes(u.phone);
  const needAdmin = req => { const u = need(req); if (!isAdmin(u)) throw new HttpError(403, "forbidden", "Admins only"); return u; };
  const needSeller = req => {
    const u = need(req);
    const s = u.store_id && db.get("SELECT * FROM stores WHERE id=?", u.store_id);
    if (!s) throw new HttpError(403, "no_store", "Register your store first");
    return { u, s };
  };
  const session = u => ({ token: signJwt({ sub: u.id, typ: "session" }, cfg.jwtSecret, SESSION_TTL), user: publicUser(u, cfg.admins) });
  const mediaUrl = p => (p && p.startsWith("/uploads/") ? cfg.publicUrl + p : p);
  const publicStore = s => ({
    id: s.id, name: s.name, d: s.district, addr: s.addr, addrUz: s.addr_uz || s.addr, hours: s.hours, ru: s.ru || s.descr.slice(0, 80), uz: s.uz || s.ru || s.descr.slice(0, 80),
    descr: s.descr, cats: JSON.parse(s.cats || "[]"), phone: s.phone, telegram: s.telegram, landmark: s.landmark, la: s.la, lo: s.lo, status: s.status
  });

  /* ---------- meta ---------- */
  r.get("/api/health", () => ({ ok: true, time: Date.now() }));
  r.get("/api/config", () => ({
    sms: sms.mode, google_client_id: cfg.google.clientId || null, apple_client_id: cfg.apple.clientId || null,
    apple_redirect_uri: cfg.apple.redirectUri || null, ai: !!cfg.ai.key, yandex: !!cfg.yandex.token, vip_free: cfg.vipFree,
    payments: [] // Click / Payme / Uzum are the next step
  }));

  /* ---------- auth ---------- */
  r.post("/api/auth/otp/send", async req => {
    const b = await readJson(req);
    const phone = parsePhone(b.phone);
    lim.hit("otp-ip:" + req.ip, 20, 3600_000);
    const code = issueOtp(db, cfg.jwtSecret, phone);
    const out = await sms.sendCode(phone, code);
    return { sent: true, retry_in: 60, ...(out.dev ? { dev_code: code } : {}) };
  });

  r.post("/api/auth/otp/verify", async req => {
    const b = await readJson(req);
    const phone = parsePhone(b.phone);
    lim.hit("otpv-ip:" + req.ip, 40, 3600_000);
    checkOtp(db, cfg.jwtSecret, phone, b.code);
    let link = null;
    if (b.ticket) { link = verifyJwt(b.ticket, cfg.jwtSecret); if (!link || link.typ !== "link") throw bad("ticket_expired", "Sign-in took too long, start again"); }
    return db.tx(() => {
      let u = db.get("SELECT * FROM users WHERE phone=?", phone), isNew = false;
      if (!u) {
        isNew = true;
        db.run("INSERT INTO users(id,phone,name,email,role,district,created_at) VALUES(?,?,?,?, 'buyer', 'mirob', ?)", newUserId(), phone, link?.name || "", link?.email || "", Date.now());
        u = db.get("SELECT * FROM users WHERE phone=?", phone);
      }
      if (link) {
        const col = link.prov === "google" ? "google_sub" : "apple_sub";
        const other = db.get(`SELECT id FROM users WHERE ${col}=? AND id<>?`, link.sub, u.id);
        if (other) throw new HttpError(409, "already_linked", "This account is already linked to another phone number");
        db.run(`UPDATE users SET ${col}=?, email=CASE WHEN email='' THEN ? ELSE email END, name=CASE WHEN name='' THEN ? ELSE name END WHERE id=?`, link.sub, link.email || "", link.name || "", u.id);
        u = db.get("SELECT * FROM users WHERE id=?", u.id);
      }
      return { ...session(u), is_new: isNew || !u.name };
    });
  });

  async function social(req, prov, token, nameHint) {
    lim.hit("social-ip:" + req.ip, 30, 3600_000);
    const c = prov === "google"
      ? await verifyIdToken(token, { jwksUrl: cfg.google.jwksUrl, issuers: ["accounts.google.com", "https://accounts.google.com"], audience: cfg.google.clientId })
      : await verifyIdToken(token, { jwksUrl: cfg.apple.jwksUrl, issuers: ["https://appleid.apple.com"], audience: cfg.apple.clientId });
    const col = prov === "google" ? "google_sub" : "apple_sub";
    const emailOk = c.email && (c.email_verified === true || c.email_verified === "true");
    let u = db.get(`SELECT * FROM users WHERE ${col}=?`, c.sub);
    if (!u && emailOk) {
      u = db.get(`SELECT * FROM users WHERE email=? AND ${col} IS NULL`, c.email);
      if (u) { db.run(`UPDATE users SET ${col}=? WHERE id=?`, c.sub, u.id); u = db.get("SELECT * FROM users WHERE id=?", u.id); }
    }
    if (u) return { ...session(u), is_new: !u.name };
    const name = str(nameHint, 80) || str(c.name, 80);
    // A phone number is required for every account (couriers and stores call the customer).
    return { need_phone: true, ticket: signJwt({ typ: "link", prov, sub: c.sub, email: emailOk ? c.email : "", name }, cfg.jwtSecret, 900), name, email: emailOk ? c.email : "" };
  }
  r.post("/api/auth/google", async req => { const b = await readJson(req); return social(req, "google", b.credential, b.name); });
  r.post("/api/auth/apple", async req => { const b = await readJson(req); return social(req, "apple", b.id_token, b.name); });

  r.get("/api/me", req => ({ user: publicUser(need(req), cfg.admins), store: req.user.store_id ? publicStore(db.get("SELECT * FROM stores WHERE id=?", req.user.store_id)) : null }));
  r.patch("/api/me", async req => {
    const u = need(req), b = await readJson(req);
    const name = b.name !== undefined ? str(b.name, 80) : u.name;
    if (b.name !== undefined && name.length < 2) throw bad("bad_name", "Name is too short");
    const district = b.district !== undefined ? (D[b.district] ? b.district : null) : u.district;
    if (!district) throw bad("bad_district", "Unknown district");
    let role = u.role;
    if (b.role !== undefined) {
      if (!["buyer", "pro"].includes(b.role)) throw bad("bad_role", "Role must be buyer or pro; stores register via /api/seller/store");
      if (u.role !== "seller") role = b.role;
    }
    const email = b.email !== undefined ? str(b.email, 120) : u.email;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("bad_email", "Invalid e-mail");
    db.run("UPDATE users SET name=?, district=?, role=?, email=? WHERE id=?", name, district, role, email, u.id);
    return { user: publicUser(db.get("SELECT * FROM users WHERE id=?", u.id), cfg.admins) };
  });
  r.post("/api/me/vip", async req => {
    const u = need(req), b = await readJson(req);
    if (b.on && !cfg.vipFree) throw new HttpError(402, "payment_required", "VIP is paid; payments are not connected yet");
    db.run("UPDATE users SET vip=? WHERE id=?", b.on ? 1 : 0, u.id);
    return { user: publicUser(db.get("SELECT * FROM users WHERE id=?", u.id), cfg.admins) };
  });

  /* ---------- catalog ---------- */
  r.get("/api/catalog", (req, res) => {
    const rev = db.meta("catalog_rev"), etag = `"c${rev}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    const stores = db.all("SELECT * FROM stores WHERE status='active' ORDER BY created_at, id").map(publicStore);
    const offers = db.all("SELECT o.product_id, o.store_id, o.price, o.stock FROM offers o JOIN stores s ON s.id=o.store_id AND s.status='active' ORDER BY o.product_id, o.price");
    const by = new Map();
    for (const o of offers) { const a = by.get(o.product_id) || []; a.push({ store: o.store_id, price: o.price, stock: o.stock }); by.set(o.product_id, a); }
    const products = db.all("SELECT * FROM products WHERE active=1 ORDER BY id").filter(p => by.has(p.id)).map(p => ({
      id: p.id, cat: p.cat, sub: p.sub, icon: p.icon, ru: p.ru, uz: p.uz, unit: p.unit, kg: p.kg, img: mediaUrl(p.img), group: p.grp, hit: !!p.hit, isNew: !!p.is_new,
      key: p.key, rating: p.rating, reviews: p.reviews, country: JSON.parse(p.country), warranty: p.warranty, desc: p.descr, offers: by.get(p.id)
    }));
    const body = Buffer.from(JSON.stringify({ rev: Number(rev), stores, products }));
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const out = gz ? gzipSync(body) : body;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": "no-cache", "Content-Length": out.length, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding, Origin" } : {}) });
    res.end(out);
  });

  /* ---------- quote & orders ---------- */
  const cleanForm = f => ({
    name: str(f?.name, 80), phone: str(f?.phone, 30), district: D[f?.district] ? f.district : "mirob", street: str(f?.street, 160), flat: str(f?.flat, 30),
    floor: String(int(f?.floor, 1, 60) || 1), lift: !!f?.lift, mode: f?.mode === "pickup" ? "pickup" : "yandex",
    when: ["asap", "slot", "vip"].includes(f?.when) ? f.when : "asap", hour: String(int(f?.hour, 8, 20) ?? 9).padStart(2, "0"),
    pay: ["click", "payme", "uzum", "nasiya", "cash"].includes(f?.pay) ? f.pay : "cash", comment: str(f?.comment, 300),
    la: Number.isFinite(Number(f?.la)) && f?.la !== null && f?.la !== "" ? Number(f.la) : null, lo: Number.isFinite(Number(f?.lo)) && f?.lo !== null && f?.lo !== "" ? Number(f.lo) : null
  });
  async function computeQuote(req, b) {
    const user = req.user;
    const form = cleanForm(b.form || {});
    const { lines, problems } = loadLines(db, ref, b.lines, user);
    const yp = await yandexPrices(db, ref, cfg.yandex, lines, form, log);
    const q = quote(db, ref, { lines, services: b.services || [], bundles: b.bundles || [], form, promo: b.promo, user, yandexPrices: yp });
    return { q, form, lines, problems };
  }
  r.post("/api/quote", async req => { const b = await readJson(req); const { q, problems } = await computeQuote(req, b); return { quote: q, problems }; });

  r.post("/api/orders", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("order:" + u.id, 30, 3600_000);
    const { q, form, lines, problems } = await computeQuote(req, b);
    assertNoProblems(problems);
    const phone = form.phone.replace(/\D/g, "");
    if (!/^998\d{9}$/.test(phone)) throw bad("bad_phone", "Recipient phone must be +998 XX XXX XX XX");
    if (form.mode !== "pickup" && form.street.length < 4) throw bad("bad_address", "Street and house are required for delivery");
    if (b.expected_total != null && Number(b.expected_total) !== q.total) throw new HttpError(409, "total_changed", "Prices or delivery changed, check the new total", { quote: q });
    const now = Date.now();
    const order = db.tx(() => {
      for (const l of lines) {
        const res = db.run("UPDATE offers SET stock=stock-?, updated_at=? WHERE product_id=? AND store_id=? AND stock>=?", l.q, now, l.p.id, l.store, l.q);
        if (!res.changes) throw new HttpError(409, "cart_changed", "Some items just went out of stock", { problems: [{ id: l.p.id, store: l.store, reason: "stock" }] });
      }
      const ins = db.run(`INSERT INTO orders(num,user_id,created_at,status,pay,pay_status,form,goods,del,svc,disc,promo_disc,total,cash,promo,services)
        VALUES(?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?)`,
        "tmp-" + randomBytes(6).toString("hex"), u.id, now, form.pay, form.pay === "cash" ? "on_delivery" : "pending", JSON.stringify(form),
        q.goods, q.del, q.svc, q.disc, q.pd, q.total, q.cash, q.promo, JSON.stringify(q.services));
      const id = Number(ins.lastInsertRowid), num = "IM-" + (100000 + id);
      db.run("UPDATE orders SET num=? WHERE id=?", num, id);
      for (const s of q.ships) {
        db.run("INSERT INTO shipments(order_id,store_id,tariff,price,kg,dist,lines,status,status_at,history) VALUES(?,?,?,?,?,?,?,'new',?,?)",
          id, s.store, s.tariff, s.price, s.kg, s.dist, JSON.stringify(s.lines), now, JSON.stringify([{ s: "new", t: now }]));
      }
      if (q.promo) db.run("INSERT OR IGNORE INTO promo_uses(user_id,code,order_id) VALUES(?,?,?)", u.id, q.promo, id);
      return num;
    });
    bumpCatalog();
    log.info(`[order] ${order} by ${u.id}: ${q.total} so'm, ${q.ships.length} shipment(s)`);
    return { order: orderOut(db.get("SELECT * FROM orders WHERE num=?", order)) };
  });

  function orderOut(o, { forStore = null } = {}) {
    const ships = db.all("SELECT * FROM shipments WHERE order_id=? ORDER BY id", o.id).filter(s => !forStore || s.store_id === forStore);
    return {
      num: o.num, t: o.created_at, status: o.status, pay: o.pay, pay_status: o.pay_status, d: JSON.parse(o.form),
      goods: o.goods, del: o.del, svc: o.svc, disc: o.disc + o.promo_disc, total: o.total, cash: o.cash, promo: o.promo,
      ships: ships.map(s => ({ id: s.id, store: s.store_id, tariff: s.tariff, price: s.price, kg: s.kg, dist: s.dist, status: s.status, status_at: s.status_at,
        step: (STEPS[s.tariff ? "yandex" : "pickup"].indexOf(s.status)), history: JSON.parse(s.history), lines: JSON.parse(s.lines), courier: s.courier }))
    };
  }
  r.get("/api/orders", req => {
    const u = need(req);
    return { orders: db.all("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50", u.id).map(o => orderOut(o)) };
  });
  r.get("/api/orders/:num", (req, res, p) => {
    const u = need(req);
    const o = db.get("SELECT * FROM orders WHERE num=?", p.num);
    if (!o || (o.user_id !== u.id && !isAdmin(u))) throw new HttpError(404, "not_found", "Order not found");
    return { order: orderOut(o) };
  });
  r.post("/api/orders/:num/cancel", (req, res, p) => {
    const u = need(req);
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const ships = db.all("SELECT * FROM shipments WHERE order_id=?", o.id);
    if (ships.some(s => !["new", "assembling"].includes(s.status))) throw new HttpError(409, "too_late", "The order is already on its way");
    db.tx(() => {
      for (const s of ships) {
        for (const l of JSON.parse(s.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, s.store_id);
        setShipStatus(s, "cancelled");
      }
      db.run("UPDATE orders SET status='cancelled' WHERE id=?", o.id);
      if (o.promo) db.run("DELETE FROM promo_uses WHERE user_id=? AND code=?", u.id, o.promo);
    });
    bumpCatalog();
    return { order: orderOut(db.get("SELECT * FROM orders WHERE id=?", o.id)) };
  });

  function setShipStatus(s, status) {
    const now = Date.now(), h = JSON.parse(s.history); h.push({ s: status, t: now });
    db.run("UPDATE shipments SET status=?, status_at=?, history=? WHERE id=?", status, now, JSON.stringify(h), s.id);
    const all = db.all("SELECT status FROM shipments WHERE order_id=?", s.order_id).map(x => x.status);
    const st = all.every(x => x === "cancelled") ? "cancelled" : all.every(x => ["delivered", "picked", "cancelled"].includes(x)) ? "done" : "active";
    db.run("UPDATE orders SET status=? WHERE id=?", st, s.order_id);
  }

  /* ---------- AI ---------- */
  r.post("/api/ai/chat", async (req, res) => {
    const b = await readJson(req, 7 * 1024 * 1024);
    const u = req.user;
    const day = new Date().toISOString().slice(0, 10);
    if (u) lim.hit(`ai:${u.id}:${day}`, cfg.ai.dailyUser, 86400_000); else lim.hit(`ai-ip:${req.ip}:${day}`, cfg.ai.dailyGuest, 86400_000);
    lim.hit("ai-min:" + (u?.id || req.ip), 8, 60_000);
    await streamChat(cfg.ai, buildRequest(db, ref, cfg.ai, b, u), res, log);
  });

  /* ---------- stores (registration and seller cabinet) ---------- */
  function storeInput(b, partial = false) {
    const out = {};
    const has = k => b[k] !== undefined;
    if (!partial || has("name")) { out.name = str(b.name, 80); if (out.name.length < 2) throw bad("bad_store_name", "Store name is required"); }
    if (!partial || has("descr")) { out.descr = str(b.descr, 600); if (out.descr.length < 10) throw bad("bad_descr", "Describe the store in a sentence or two"); }
    if (!partial || has("cats")) {
      out.cats = Array.isArray(b.cats) ? [...new Set(b.cats.map(String).filter(c => CATS.has(c)))] : [];
      if (!out.cats.length) throw bad("bad_cats", "Choose at least one category");
    }
    if (!partial || has("phone")) {
      const d = String(b.phone || "").replace(/\D/g, ""); const ph = d.length === 9 ? "998" + d : d;
      if (!/^998\d{9}$/.test(ph)) throw bad("bad_store_phone", "Store phone must be +998 XX XXX XX XX");
      out.phone = ph;
    }
    if (has("telegram") || !partial) out.telegram = str(b.telegram, 64).replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "");
    if (has("hours") || !partial) out.hours = str(b.hours, 40) || "09:00–19:00";
    if (has("landmark") || !partial) out.landmark = str(b.landmark, 160);
    if (!partial || has("addr")) { out.addr = str(b.addr, 200); if (out.addr.length < 3) throw bad("bad_addr", "Address is required"); }
    if (has("la") || has("lo") || !partial) {
      const la = b.la === null || b.la === undefined || b.la === "" ? null : Number(b.la), lo = b.lo === null || b.lo === undefined || b.lo === "" ? null : Number(b.lo);
      if ((la === null) !== (lo === null)) throw bad("bad_location", "Both latitude and longitude are needed");
      if (la !== null && !(la > 37 && la < 46 && lo > 55 && lo < 74)) throw bad("bad_location", "The location must be in Uzbekistan");
      out.la = la; out.lo = lo; out.loc_src = la === null ? "district" : b.loc_src === "gps" ? "gps" : "map";
    }
    if (!partial || has("district")) {
      let d = D[b.district] ? b.district : null;
      if (!d && out.la != null) d = ref.districts.reduce((best, x) => ((x.la - out.la) ** 2 + (x.lo - out.lo) ** 2 < (best.la - out.la) ** 2 + (best.lo - out.lo) ** 2 ? x : best)).id;
      if (!d) throw bad("bad_district", "Choose the district");
      out.district = d;
    }
    if (out.la === null && out.district) { out.la = D[out.district].la; out.lo = D[out.district].lo; }
    return out;
  }

  r.post("/api/seller/store", async req => {
    const u = need(req), b = await readJson(req);
    if (u.store_id) throw new HttpError(409, "store_exists", "You already have a store; edit it in the cabinet");
    const s = storeInput(b);
    const base = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "store";
    const id = base + "-" + randomBytes(2).toString("hex");
    const status = process.env.STORE_AUTO_APPROVE === "1" ? "active" : "pending";
    db.tx(() => {
      db.run(`INSERT INTO stores(id,name,district,addr,addr_uz,hours,ru,uz,phone,la,lo,owner_id,status,created_at,descr,cats,landmark,telegram,loc_src)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, s.name, s.district, s.addr, s.addr, s.hours, s.descr.slice(0, 80), s.descr.slice(0, 80), s.phone, s.la, s.lo, u.id, status, Date.now(), s.descr, JSON.stringify(s.cats), s.landmark, s.telegram, s.loc_src);
      db.run("UPDATE users SET role='seller', store_id=? WHERE id=?", id, u.id);
    });
    if (status === "active") bumpCatalog();
    log.info(`[store] new ${status} store ${id} "${s.name}" by ${u.id}`);
    return { store: publicStore(db.get("SELECT * FROM stores WHERE id=?", id)), user: publicUser(db.get("SELECT * FROM users WHERE id=?", u.id), cfg.admins) };
  });
  r.patch("/api/seller/store", async req => {
    const { s } = needSeller(req), b = await readJson(req);
    const x = storeInput(b, true);
    const cols = Object.keys(x); if (!cols.length) return { store: publicStore(s) };
    const vals = cols.map(k => (k === "cats" ? JSON.stringify(x[k]) : x[k]));
    db.run(`UPDATE stores SET ${cols.map(c => c + "=?").join(",")} WHERE id=?`, ...vals, s.id);
    if (x.descr) db.run("UPDATE stores SET ru=?, uz=? WHERE id=?", x.descr.slice(0, 80), x.descr.slice(0, 80), s.id);
    if (x.addr) db.run("UPDATE stores SET addr_uz=? WHERE id=?", x.addr, s.id);
    bumpCatalog();
    return { store: publicStore(db.get("SELECT * FROM stores WHERE id=?", s.id)) };
  });

  r.get("/api/seller/summary", req => {
    const { s } = needSeller(req);
    const since = Date.now() - 30 * 86400_000;
    const ships = db.all("SELECT sh.*, o.num, o.form, o.created_at oc, o.pay, o.pay_status FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? ORDER BY sh.id DESC LIMIT 100", s.id);
    const revenue = ships.filter(x => x.oc >= since && x.status !== "cancelled").reduce((a, x) => a + JSON.parse(x.lines).reduce((b, l) => b + l.price * l.q, 0), 0);
    const products = db.all(`SELECT p.id,p.ru,p.uz,p.cat,p.sub,p.unit,p.kg,p.img,p.active,p.store_id, o.price,o.stock FROM offers o JOIN products p ON p.id=o.product_id WHERE o.store_id=? ORDER BY p.id`, s.id)
      .map(p => ({ ...p, img: mediaUrl(p.img), own: p.store_id === s.id }));
    return {
      store: publicStore(s),
      kpi: { revenue30: revenue, orders30: ships.filter(x => x.oc >= since).length, open: ships.filter(x => !["delivered", "picked", "cancelled"].includes(x.status)).length, products: products.length, out_of_stock: products.filter(p => p.stock <= 0).length },
      orders: ships.map(x => {
        const f = JSON.parse(x.form);
        return { ship_id: x.id, num: x.num, t: x.oc, status: x.status, tariff: x.tariff, price: x.price, kg: x.kg, pay: x.pay, pay_status: x.pay_status,
          buyer: f.name, phone: f.phone, district: f.district, street: f.mode === "pickup" ? "" : f.street, when: f.when, hour: f.hour, comment: f.comment, lines: JSON.parse(x.lines),
          next: SELLER_MOVES[x.status]?.filter(n => (x.tariff ? n !== "ready" : !["searching"].includes(n))) || [] };
      }),
      products
    };
  });
  r.patch("/api/seller/offers/:pid", async (req, res, p) => {
    const { s } = needSeller(req), b = await readJson(req);
    const o = db.get("SELECT * FROM offers WHERE product_id=? AND store_id=?", Number(p.pid), s.id);
    if (!o) throw new HttpError(404, "not_found", "This store does not sell the product");
    const price = b.price !== undefined ? int(b.price, 100, 1e10) : o.price, stock = b.stock !== undefined ? int(b.stock, 0, 1e7) : o.stock;
    if (price === null || stock === null) throw bad("bad_offer", "Price must be ≥ 100 so'm, stock ≥ 0");
    db.run("UPDATE offers SET price=?, stock=?, updated_at=? WHERE product_id=? AND store_id=?", price, stock, Date.now(), o.product_id, s.id);
    bumpCatalog();
    return { offer: { product_id: o.product_id, store: s.id, price, stock } };
  });
  r.post("/api/seller/offers", async req => {
    // Start selling an existing catalog product (e.g. the same cement another store has)
    const { s } = needSeller(req), b = await readJson(req);
    const pid = int(b.product_id, 1, 1e9), price = int(b.price, 100, 1e10), stock = int(b.stock ?? 0, 0, 1e7);
    if (!pid || !price || stock === null) throw bad("bad_offer", "product_id, price and stock are required");
    if (!db.get("SELECT 1 FROM products WHERE id=? AND active=1", pid)) throw new HttpError(404, "not_found", "Product not found");
    db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id,store_id) DO UPDATE SET price=excluded.price, stock=excluded.stock, updated_at=excluded.updated_at", pid, s.id, price, stock, Date.now());
    bumpCatalog();
    return { offer: { product_id: pid, store: s.id, price, stock } };
  });
  r.post("/api/seller/products", async req => {
    const { s } = needSeller(req), b = await readJson(req);
    const ru = str(b.ru, 140), uz = str(b.uz, 140) || ru, cat = String(b.cat || ""), sub = String(b.sub || "");
    const c = ref.cats.find(x => x.id === cat);
    if (ru.length < 3) throw bad("bad_name", "Product name is required");
    if (!c || !c.subs.some(x => x[0] === sub)) throw bad("bad_category", "Choose a category and subcategory");
    const unit = ref.units[b.unit] ? b.unit : "pcs";
    const price = int(b.price, 100, 1e10), stock = int(b.stock ?? 0, 0, 1e7), kg = Number(b.kg);
    if (!price) throw bad("bad_price", "Price must be at least 100 so'm");
    if (stock === null) throw bad("bad_stock", "Stock must be 0 or more");
    if (!(kg > 0 && kg <= 5000)) throw bad("bad_weight", "Weight per unit (kg) is needed for delivery");
    const id = db.tx(() => {
      const nid = Math.max(10000, (db.get("SELECT MAX(id) m FROM products")?.m || 0) + 1);
      db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,hit,is_new,rating,reviews,country,warranty,descr,store_id,active,created_at)
        VALUES(?,?,?,?,?,?,?,?,'',0,1,0,0,?,?,?,?,1,?)`, nid, cat, sub, c.icon, ru, uz, unit, kg, JSON.stringify(["Узбекистан", "O‘zbekiston"]), int(b.warranty, 0, 120) || 0, str(b.desc, 1000), s.id, Date.now());
      db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", nid, s.id, price, stock, Date.now());
      return nid;
    });
    bumpCatalog();
    return { product: { id, ru, uz, cat, sub, unit, kg, price, stock } };
  });
  r.post("/api/seller/products/:pid/photo", async (req, res, p) => {
    const { s } = needSeller(req);
    const prod = db.get("SELECT * FROM products WHERE id=?", Number(p.pid));
    if (!prod || prod.store_id !== s.id) throw new HttpError(403, "forbidden", "You can change photos only of your own products");
    const buf = await readBody(req, 5 * 1024 * 1024);
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? ".jpg" : buf.slice(0, 4).toString("hex") === "89504e47" ? ".png" : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? ".webp" : null;
    if (!ext) throw bad("bad_image", "Upload a JPEG, PNG or WEBP image up to 5 MB");
    const name = `p${prod.id}-${randomBytes(4).toString("hex")}${ext}`;
    writeFileSync(join(cfg.uploadsDir, name), buf);
    db.run("UPDATE products SET img=? WHERE id=?", "/uploads/" + name, prod.id);
    bumpCatalog();
    return { img: mediaUrl("/uploads/" + name) };
  });
  r.patch("/api/seller/shipments/:id", async (req, res, p) => {
    const { u, s } = needSeller(req), b = await readJson(req);
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(p.id));
    if (!sh || (sh.store_id !== s.id && !isAdmin(u))) throw new HttpError(404, "not_found", "Shipment not found");
    if (!(SELLER_MOVES[sh.status] || []).includes(b.status) || (b.status === "ready" && sh.tariff) || (b.status === "searching" && !sh.tariff)) throw bad("bad_status", `Cannot move from ${sh.status} to ${b.status}`);
    db.tx(() => {
      if (b.status === "cancelled") for (const l of JSON.parse(sh.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, sh.store_id);
      setShipStatus(sh, b.status);
    });
    return { ok: true, status: b.status };
  });

  /* ---------- admin ---------- */
  r.get("/api/admin/stores", req => { needAdmin(req); return { stores: db.all("SELECT s.*, u.name owner_name, u.phone owner_phone FROM stores s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.status='pending' DESC, s.created_at DESC").map(s => ({ ...publicStore(s), owner_name: s.owner_name, owner_phone: s.owner_phone, loc_src: s.loc_src, created: s.created_at, note: s.review_note })) }; });
  r.patch("/api/admin/stores/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const s = db.get("SELECT * FROM stores WHERE id=?", p.id); if (!s) throw new HttpError(404, "not_found", "Store not found");
    if (b.status && !["active", "pending", "rejected", "blocked"].includes(b.status)) throw bad("bad_status", "Unknown status");
    db.run("UPDATE stores SET status=COALESCE(?,status), review_note=COALESCE(?,review_note) WHERE id=?", b.status || null, b.note != null ? str(b.note, 300) : null, s.id);
    if (b.owner_phone) {
      const ph = parsePhone(b.owner_phone), ou = db.get("SELECT * FROM users WHERE phone=?", ph);
      if (!ou) throw new HttpError(404, "user_not_found", "The owner must sign in once first");
      db.run("UPDATE stores SET owner_id=? WHERE id=?", ou.id, s.id); db.run("UPDATE users SET role='seller', store_id=? WHERE id=?", s.id, ou.id);
    }
    bumpCatalog();
    return { store: publicStore(db.get("SELECT * FROM stores WHERE id=?", s.id)) };
  });
  r.patch("/api/admin/shipments/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(p.id)); if (!sh) throw new HttpError(404, "not_found", "Shipment not found");
    const steps = STEPS[sh.tariff ? "yandex" : "pickup"];
    if (!steps.includes(b.status) && b.status !== "cancelled") throw bad("bad_status", "Unknown status");
    if (b.courier) db.run("UPDATE shipments SET courier=? WHERE id=?", str(b.courier, 80), sh.id);
    setShipStatus(sh, b.status);
    return { ok: true };
  });
  r.patch("/api/admin/orders/:num/pay", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    if (!["paid", "pending", "refunded", "on_delivery"].includes(b.pay_status)) throw bad("bad_status", "Unknown payment status");
    const o = db.get("SELECT id FROM orders WHERE num=?", p.num); if (!o) throw new HttpError(404, "not_found", "Order not found");
    db.run("UPDATE orders SET pay_status=? WHERE id=?", b.pay_status, o.id);
    return { ok: true };
  });

  /* ---------- HTTP server ---------- */
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://x");
    req.ip = clientIp(req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    cors(req, res, cfg.origins);
    try {
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.method === "GET" && url.pathname.startsWith("/uploads/")) return serveUpload(url.pathname.slice(9), res);
      const m = r.match(req.method, url.pathname);
      if (m === "method") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      if (!m) throw new HttpError(404, "not_found", "Not found");
      lim.hit("ip:" + req.ip, 600, 60_000);
      req.user = userFrom(req);
      const out = await m.route.handler(req, res, m.params, url);
      if (!res.headersSent && out !== undefined) send(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error("[error]", req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.code : "server_error", message: e instanceof HttpError ? e.message : "Something went wrong", ...(e.extra || {}) });
      else res.end();
    } finally {
      if (!url.pathname.startsWith("/uploads/")) log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });

  function serveUpload(name, res) {
    if (!/^[\w.-]+$/.test(name) || !MIME[extname(name)]) throw new HttpError(404, "not_found", "Not found");
    const path = join(cfg.uploadsDir, name);
    let size; try { size = statSync(path).size; } catch { throw new HttpError(404, "not_found", "Not found"); }
    res.writeHead(200, { "Content-Type": MIME[extname(name)], "Content-Length": size, "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "cross-origin" });
    createReadStream(path).pipe(res);
  }

  server.db = db;
  return server;
}
