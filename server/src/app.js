import { createServer } from "node:http";
import { createReadStream, mkdirSync, writeFileSync, statSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { openDb } from "./db.js";
import { Router, HttpError, bad, readJson, readBody, send, cors, Limiter, clientIp, int, str } from "./http.js";
import { signJwt, verifyJwt, parsePhone, issueOtp, checkOtp, verifyIdToken, newUserId, publicUser } from "./auth.js";
import { createSms } from "./sms.js";
import { loadLines, quote, assertNoProblems } from "./pricing.js";
import { yandexPrices } from "./delivery.js";
import { buildRequest, streamChat } from "./ai.js";
import { createTelegram } from "./telegram.js";
import { createPush } from "./push.js";
import { createNotify } from "./notify.js";
import { newSecret, checkTotp, otpauthUrl } from "./totp.js";
import { registerMasters } from "./masters.js";
import { registerBot } from "./bot.js";
import { createBonus } from "./bonus.js";
import { registerStats } from "./stats.js";
import { createPayments } from "./payments.js";
import { createChannel } from "./channel.js";
import { registerDisputes } from "./disputes.js";
import { registerQuestions } from "./questions.js";
import { registerCatalogExtras } from "./catalogx.js";
import { registerTeams } from "./teams.js";
import { registerDashboard } from "./dashboard.js";

export const STEPS = {
  yandex: ["new", "assembling", "searching", "to_store", "on_way", "delivered"],
  pickup: ["new", "assembling", "ready", "picked"]
};
const SELLER_MOVES = { new: ["assembling", "cancelled"], assembling: ["searching", "ready", "cancelled"], ready: ["picked"], searching: ["to_store"], to_store: ["on_way"], on_way: ["delivered"] };
const FAIL_REASONS = ["not_accepted", "out_of_stock", "not_shipped"];
const SESSION_TTL = 60 * 86400;
const MIME = { ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png" };

export function createApp(cfg, log = console) {
  const db = openDb(cfg.dbPath, cfg.catalogPath, { demoStores: cfg.demoStores });
  const ref = db.ref;
  const subIcon = (cat, sub) => { const m = new Map(); for (const p of ref.products) if (p.cat === cat && p.sub === sub && p.icon) m.set(p.icon, (m.get(p.icon) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1])[0]?.[0] || ref.cats.find(c => c.id === cat)?.icon || "box"; };
  const subUnit = (cat, sub, want) => { if (want && ref.units[want]) return want; const m = new Map(); for (const p of ref.products) if (p.cat === cat && p.sub === sub) m.set(p.unit, (m.get(p.unit) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1])[0]?.[0] || "pcs"; };
  const sms = createSms(cfg.sms, log);
  const lim = new Limiter();
  const r = new Router();
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const CATS = new Set(ref.cats.map(c => c.id));
  mkdirSync(cfg.uploadsDir, { recursive: true });
  const bumpCatalog = () => db.setMeta("catalog_rev", Date.now());
  const tg = createTelegram(cfg.telegram, log);
  const push = createPush(db, cfg.pushSubject, log);
  const notify = createNotify({ db, cfg, tg, push, sms, ref, log });
  const bonus = createBonus({ db, cfg, log });
  let bot = { callback: async () => false };
  const channel = createChannel({ db, cfg, tg, log });
  const PCAT = new Map(db.all("SELECT id, cat FROM products").map(p => [p.id, p.cat]));
  const rateOf = cat => cfg.commission[cat] ?? cfg.commission["*"] ?? 0;
  const audit = (req, action, target, details) => db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", req?.user?.id || null, action, target == null ? null : String(target), details ? JSON.stringify(details) : null, req?.ip || null, Date.now());

  /* Store hours are Tashkent time (UTC+5). Orders placed at night wait for the opening, so the accept timer starts then. */
  function storeStartAt(store, ts) {
    const m = String(store?.hours || "").match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/);
    if (!m) return ts;
    const o = +m[1] * 60 + +m[2], c = +m[3] * 60 + +m[4];
    if (c <= o) return ts;
    const local = new Date(ts + 5 * 3600000), mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (mins >= o && mins < c - 15) return ts;
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 5 * 3600000;
    return mins < o ? day + o * 60000 : day + 86400000 + o * 60000;
  }
  /* Reliability and reviews of every store, shown to buyers */
  function storeStats() {
    const since = Date.now() - 90 * 86400000, out = {};
    for (const r of db.all(`SELECT store_id, SUM(status IN ('delivered','picked')) done, SUM(status='cancelled' AND cancel_reason IN ('not_accepted','out_of_stock','not_shipped')) fail,
        AVG(CASE WHEN accepted_at IS NOT NULL AND start_at IS NOT NULL AND accepted_at>=start_at THEN (accepted_at-start_at)/60000.0 END) acc
        FROM shipments WHERE status_at>=? GROUP BY store_id`, since)) out[r.store_id] = { done: r.done || 0, fail: r.fail || 0, accept_min: r.acc == null ? null : Math.max(1, Math.round(r.acc)) };
    for (const r of db.all("SELECT store_id, AVG(stars) a, COUNT(*) n FROM reviews GROUP BY store_id")) (out[r.store_id] ||= { done: 0, fail: 0, accept_min: null }).stars = Math.round(r.a * 10) / 10, out[r.store_id].reviews = r.n;
    for (const k in out) { const x = out[k]; x.reliability = x.done + x.fail >= 3 ? Math.round(x.done * 100 / (x.done + x.fail)) : null; x.reviews ||= 0; x.stars ??= null; }
    return out;
  }

  /* ---------- helpers ---------- */
  const userFrom = req => {
    const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
    const p = m && verifyJwt(m[1], cfg.jwtSecret);
    if (!p || p.typ !== "session") return null;
    const u = db.get("SELECT * FROM users WHERE id=?", p.sub);
    if (!u || (p.v || 0) !== u.token_ver) return null;
    req.mfa = p.mfa === true;
    return u;
  };
  const need = req => { if (!req.user) throw new HttpError(401, "auth_required", "Sign in first"); return req.user; };
  const isAdmin = u => !!u?.phone && cfg.admins.includes(u.phone);
  const adminOk = req => { try { needAdmin(req); return true; } catch { return false; } };
  const needAdmin = (req, { mfa = true } = {}) => {
    const u = need(req); if (!isAdmin(u)) throw new HttpError(403, "forbidden", "Admins only");
    if (mfa && cfg.adminMfa) {
      if (!u.totp_on) throw new HttpError(403, "mfa_setup_required", "Turn on two-step verification for the admin account");
      if (!req.mfa) throw new HttpError(403, "mfa_required", "Enter the code from your authenticator app");
    }
    return u;
  };
  const needSeller = req => {
    const u = need(req);
    const s = u.store_id && db.get("SELECT * FROM stores WHERE id=?", u.store_id);
    if (!s) throw new HttpError(403, "no_store", "Register your store first");
    // A pending store may prepare its goods (they stay hidden until approval); a blocked or rejected one only sees its own page
    if ((s.status === "blocked" || s.status === "rejected") && !/^\/api\/seller\/(store|summary)(\?|$)/.test(req.url) && !isAdmin(u)) throw new HttpError(403, "store_" + s.status, "The store is " + s.status + "; contact Imorat Go support");
    return { u, s };
  };
  const session = (u, extra = {}) => ({ token: signJwt({ sub: u.id, typ: "session", v: u.token_ver || 0, ...extra }, cfg.jwtSecret, extra.mfa ? 12 * 3600 : SESSION_TTL), user: { ...publicUser(u, cfg.admins), telegram: !!u.tg_chat, mfa: !!u.totp_on } });
  const mediaUrl = p => (p && p.startsWith("/uploads/") ? cfg.publicUrl + p : p);
  /* Saves an uploaded JPEG/PNG/WEBP (checked by its first bytes) and returns its /uploads path */
  const saveImage = (buf, prefix) => {
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? ".jpg" : buf.slice(0, 4).toString("hex") === "89504e47" ? ".png" : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? ".webp" : null;
    if (!ext) throw bad("bad_image", "Upload a JPEG, PNG or WEBP image up to 5 MB");
    const name = `${prefix}-${randomBytes(5).toString("hex")}${ext}`;
    writeFileSync(join(cfg.uploadsDir, name), buf);
    return "/uploads/" + name;
  };
  const publicStore = s => ({
    id: s.id, name: s.name, d: s.district, addr: s.addr, addrUz: s.addr_uz || s.addr, hours: s.hours, ru: s.ru || s.descr.slice(0, 80), uz: s.uz || s.ru || s.descr.slice(0, 80),
    descr: s.descr, cats: JSON.parse(s.cats || "[]"), phone: s.phone, telegram: s.telegram, verified: !!s.verified, landmark: s.landmark, la: s.la, lo: s.lo, status: s.status, loc_src: s.loc_src, note: s.review_note, created: s.created_at
  });

  /* ---------- meta ---------- */
  r.get("/api/health", () => ({ ok: true, time: Date.now() }));
  r.get("/api/config", () => ({
    sms: sms.mode, google_client_id: cfg.google.clientId || null, apple_client_id: cfg.apple.clientId || null,
    apple_redirect_uri: cfg.apple.redirectUri || null, ai: !!cfg.ai.key, yandex: !!cfg.yandex.token, vip_free: cfg.vipFree,
    payments: cfg.paymentsOnline, telegram_bot: tg.enabled ? tg.username || null : null, telegram_channel: /^@/.test(cfg.channel?.chat || "") ? cfg.channel.chat : null, push_key: push.publicKey,
    timers: cfg.timers, commission: cfg.commission, demo: cfg.demoStores
  }));

  /* ---------- auth ---------- */
  r.post("/api/auth/otp/send", async req => {
    const b = await readJson(req);
    const phone = parsePhone(b.phone);
    lim.hit("otp-ip:" + req.ip, cfg.otpPerIpHour, 3600_000);
    const code = issueOtp(db, cfg.jwtSecret, phone);
    const out = await sms.sendCode(phone, code);
    return { sent: true, retry_in: 60, ...(out.dev ? { dev_code: code } : {}) };
  });

  r.post("/api/auth/otp/verify", async req => {
    const b = await readJson(req);
    const phone = parsePhone(b.phone);
    lim.hit("otpv-ip:" + req.ip, cfg.otpPerIpHour * 3, 3600_000);
    lim.hit("otpv-ph:" + phone, 15, 3600_000);
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
    // Only the provider's own subject identifies an account: an e-mail can be typed into any profile, so it never links accounts.
    const u = db.get(`SELECT * FROM users WHERE ${col}=?`, c.sub);
    if (u) return { ...session(u), is_new: !u.name };
    const name = str(nameHint, 80) || str(c.name, 80);
    // A phone number is required for every account (couriers and stores call the customer).
    return { need_phone: true, ticket: signJwt({ typ: "link", prov, sub: c.sub, email: emailOk ? c.email : "", name }, cfg.jwtSecret, 900), name, email: emailOk ? c.email : "" };
  }
  r.post("/api/auth/google", async req => { const b = await readJson(req); return social(req, "google", b.credential, b.name); });
  r.post("/api/auth/apple", async req => { const b = await readJson(req); return social(req, "apple", b.id_token, b.name); });

  r.get("/api/me", req => ({ user: { ...publicUser(need(req), cfg.admins), telegram: !!req.user.tg_chat, mfa: !!req.user.totp_on }, store: req.user.store_id ? publicStore(db.get("SELECT * FROM stores WHERE id=?", req.user.store_id)) : null }));
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
  /* The catalog is built once and kept in memory (raw + gzip). It is rebuilt when products/prices change
     (catalog_rev) or, for store ratings, at most every 60 s — so thousands of visitors cost almost nothing. */
  let catCache = null;
  function catalogBody() {
    const rev = db.meta("catalog_rev"), now = Date.now();
    if (catCache && catCache.rev === rev && now - catCache.at < 60_000) return catCache;
    const stats = storeStats();
    const stores = db.all("SELECT * FROM stores WHERE status='active' ORDER BY created_at, id").map(s => ({ ...publicStore(s), note: undefined, loc_src: undefined, rating: stats[s.id] || { done: 0, fail: 0, reliability: null, stars: null, reviews: 0, accept_min: null } }));
    const offers = db.all("SELECT o.product_id, o.store_id, o.price, o.stock FROM offers o JOIN stores s ON s.id=o.store_id AND s.status='active' ORDER BY o.product_id, o.price");
    const by = new Map();
    for (const o of offers) { const a = by.get(o.product_id) || []; a.push({ store: o.store_id, price: o.price, stock: o.stock }); by.set(o.product_id, a); }
    const products = db.all("SELECT * FROM products WHERE active=1 ORDER BY id").filter(p => by.has(p.id)).map(p => ({
      id: p.id, cat: p.cat, sub: p.sub, icon: p.icon, ru: p.ru, uz: p.uz, unit: p.unit, kg: p.kg, img: mediaUrl(p.img), group: p.grp, hit: !!p.hit, isNew: !!p.is_new,
      key: p.key, rating: p.rating, reviews: p.reviews, country: JSON.parse(p.country), warranty: p.warranty, desc: p.descr, offers: by.get(p.id)
    }));
    const json = JSON.stringify({ stores, products }), hash = createHash("sha1").update(json).digest("base64url").slice(0, 16);
    if (catCache && catCache.hash === hash) { catCache.rev = rev; catCache.at = now; return catCache; }
    const raw = Buffer.from(JSON.stringify({ rev: hash, stores, products }));
    catCache = { rev, at: now, hash, etag: `"c${hash}"`, raw, gz: gzipSync(raw) };
    return catCache;
  }
  r.get("/api/catalog", (req, res) => {
    const c = catalogBody();
    if (req.headers["if-none-match"] === c.etag) { res.writeHead(304, { ETag: c.etag }); res.end(); return; }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || ""), out = gz ? c.gz : c.raw;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ETag: c.etag, "Cache-Control": "no-cache", "Content-Length": out.length, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding, Origin" } : {}) });
    res.end(out);
  });

  /* ---------- quote & orders ---------- */
  const cleanForm = f => ({
    name: str(f?.name, 80), phone: str(f?.phone, 30), district: D[f?.district] ? f.district : "mirob", street: str(f?.street, 160), flat: str(f?.flat, 30),
    floor: String(int(f?.floor, 1, 60) || 1), lift: !!f?.lift, mode: f?.mode === "pickup" ? "pickup" : "yandex",
    when: ["asap", "slot", "vip"].includes(f?.when) ? f.when : "asap", hour: String(int(f?.hour, 8, 20) ?? 9).padStart(2, "0"),
    pay: ["click", "payme", "uzum", "nasiya", "cash", "store"].includes(f?.pay) ? f.pay : "store", comment: str(f?.comment, 300),
    la: Number.isFinite(Number(f?.la)) && f?.la !== null && f?.la !== "" ? Number(f.la) : null, lo: Number.isFinite(Number(f?.lo)) && f?.lo !== null && f?.lo !== "" ? Number(f.lo) : null
  });
  async function computeQuote(req, b) {
    const user = req.user;
    const form = cleanForm(b.form || {});
    const { lines, problems } = loadLines(db, ref, b.lines, user);
    const yp = await yandexPrices(db, ref, cfg.yandex, lines, form, log);
    const q = quote(db, ref, { lines, services: b.services || [], bundles: b.bundles || [], form, promo: b.promo, user, yandexPrices: yp, points: b.points, maxShare: cfg.bonus.maxShare });
    return { q, form, lines, problems };
  }
  r.post("/api/quote", async req => { lim.hit("quote-ip:" + req.ip, 120, 60_000); const b = await readJson(req); const { q, problems } = await computeQuote(req, b); return { quote: q, problems }; });

  r.post("/api/orders", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("order:" + u.id, 30, 3600_000);
    const { q, form, lines, problems } = await computeQuote(req, b);
    assertNoProblems(problems);
    const phone = form.phone.replace(/\D/g, "");
    if (!/^998\d{9}$/.test(phone)) throw bad("bad_phone", "Recipient phone must be +998 XX XXX XX XX");
    if (form.mode !== "pickup" && form.street.length < 4) throw bad("bad_address", "Street and house are required for delivery");
    if (!["store", "cash"].includes(form.pay) && !cfg.paymentsOnline.includes(form.pay)) throw bad("payment_unavailable", "Online payment is not connected yet; pay the store directly");
    // Delivery is paid by card on the site (the courier takes no money); cash only when the buyer collects the order at the store
    if (["store", "cash"].includes(form.pay) && form.mode !== "pickup" && cfg.paymentsOnline.length) throw bad("card_required", "Delivery orders are paid by card on the site; cash is for pickup only");
    if (b.expected_total != null && Number(b.expected_total) !== q.total) throw new HttpError(409, "total_changed", "Prices or delivery changed, check the new total", { quote: q });
    const now = Date.now(), online = !["store", "cash"].includes(form.pay);
    const order = db.tx(() => {
      for (const l of lines) {
        const res = db.run("UPDATE offers SET stock=stock-?, updated_at=? WHERE product_id=? AND store_id=? AND stock>=?", l.q, now, l.p.id, l.store, l.q);
        if (!res.changes) throw new HttpError(409, "cart_changed", "Some items just went out of stock", { problems: [{ id: l.p.id, store: l.store, reason: "stock" }] });
      }
      if (q.pts && !db.run("UPDATE users SET points=points-? WHERE id=? AND points>=?", q.pts, u.id, q.pts).changes) throw new HttpError(409, "total_changed", "Bonus balance changed, check the new total", { quote: { ...q, pts: 0, total: q.total + q.pts } });
      const ins = db.run(`INSERT INTO orders(num,user_id,created_at,status,pay,pay_status,form,goods,del,svc,disc,promo_disc,total,cash,promo,services,points_used)
        VALUES(?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        "tmp-" + randomBytes(6).toString("hex"), u.id, now, form.pay, ["cash", "store"].includes(form.pay) ? "to_store" : "pending", JSON.stringify({ ...form, lang: String(b.lang || "ru").slice(0, 2) }),
        q.goods, q.del, q.svc, q.disc, q.pd, q.total, q.cash, q.promo, JSON.stringify(q.services), q.pts || 0);
      const id = Number(ins.lastInsertRowid), num = "IM-" + (100000 + id);
      if (q.pts) db.run("INSERT INTO points_log(user_id,delta,reason,ref,created_at) VALUES(?,?,?,?,?)", u.id, -q.pts, "spent", "order:" + id, now);
      db.run("UPDATE orders SET num=? WHERE id=?", num, id);
      for (const s of q.ships) {
        const goods = s.lines.reduce((a, l) => a + l.price * l.q, 0);
        const commission = s.lines.reduce((a, l) => a + Math.round(l.price * l.q * rateOf(PCAT.get(l.id) || db.get("SELECT cat FROM products WHERE id=?", l.id)?.cat)), 0);
        const start = storeStartAt(db.get("SELECT hours FROM stores WHERE id=?", s.store), now);
        const st0 = online ? "unpaid" : "new";
        db.run("INSERT INTO shipments(order_id,store_id,tariff,price,kg,dist,lines,status,status_at,history,goods,commission,start_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id, s.store, s.tariff, s.price, s.kg, s.dist, JSON.stringify(s.lines), st0, now, JSON.stringify([{ s: st0, t: now }]), goods, commission, start);
      }
      if (q.promo) db.run("INSERT OR IGNORE INTO promo_uses(user_id,code,order_id) VALUES(?,?,?)", u.id, q.promo, id);
      return num;
    });
    bumpCatalog();
    log.info(`[order] ${order} by ${u.id}: ${q.total} so'm, ${q.ships.length} shipment(s)`);
    if (!online) for (const sh of db.all("SELECT id FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", order)) notify.shipmentNew(sh.id);
    return { order: orderOut(db.get("SELECT * FROM orders WHERE num=?", order)) };
  });
  /* a fresh checkout link for an order that is still waiting for its card payment */
  r.get("/api/orders/:num/pay", (req, res, p) => {
    const u = need(req), o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    if (o.pay_status !== "pending" || ["store", "cash"].includes(o.pay) || o.status === "cancelled") throw new HttpError(409, "not_payable", "This order does not wait for a payment");
    return { pay_url: payments.payUrl(o) };
  });

  function orderOut(o, { forStore = null } = {}) {
    const ships = db.all("SELECT * FROM shipments WHERE order_id=? ORDER BY id", o.id).filter(s => !forStore || s.store_id === forStore);
    return {
      num: o.num, t: o.created_at, status: o.status, pay: o.pay, pay_status: o.pay_status, d: JSON.parse(o.form),
      goods: o.goods, del: o.del, svc: o.svc, disc: o.disc + o.promo_disc, bdisc: o.disc, pd: o.promo_disc, pts: o.points_used || 0, total: o.total, cash: o.cash, promo: o.promo,
      paid_at: o.paid_at || null, pay_url: o.pay_status === "pending" && !["store", "cash"].includes(o.pay) && o.status !== "cancelled" ? payments.payUrl(o) : null,
      pay_deadline: o.pay_status === "pending" && !["store", "cash"].includes(o.pay) ? o.created_at + cfg.payTimeoutMin * 60000 : null,
      ships: ships.map(s => ({ id: s.id, store: s.store_id, tariff: s.tariff, price: s.price, kg: s.kg, dist: s.dist, status: s.status, status_at: s.status_at,
        step: (STEPS[s.tariff ? "yandex" : "pickup"].indexOf(s.status)), history: JSON.parse(s.history), lines: JSON.parse(s.lines), courier: s.courier,
        cancel_reason: s.cancel_reason, accept_by: s.status === "new" ? (s.start_at || s.status_at) + cfg.timers.cancel * 60000 : null,
        review: db.get("SELECT stars, text, reply FROM reviews WHERE ship_id=?", s.id) || null }))
    };
  }
  r.get("/api/orders", req => {
    const u = need(req);
    return { orders: db.all("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50", u.id).map(o => orderOut(o)) };
  });
  r.get("/api/orders/:num", (req, res, p) => {
    const u = need(req);
    const o = db.get("SELECT * FROM orders WHERE num=?", p.num);
    if (!o || (o.user_id !== u.id && !adminOk(req))) throw new HttpError(404, "not_found", "Order not found");
    return { order: orderOut(o) };
  });
  r.post("/api/orders/:num/cancel", (req, res, p) => {
    const u = need(req);
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    if (!cancelOrder(o, "buyer")) throw new HttpError(409, "too_late", "The order is already on its way");
    return { order: orderOut(db.get("SELECT * FROM orders WHERE id=?", o.id)) };
  });
  /* Cancels a whole order while nothing has left the stores: stock back, points back (via setShipStatus), promo freed. False once a shipment is on its way. */
  function cancelOrder(o, reason) {
    const ships = db.all("SELECT * FROM shipments WHERE order_id=?", o.id);
    if (ships.some(s => !["unpaid", "new", "assembling", "cancelled"].includes(s.status))) return false;
    db.tx(() => {
      for (const s of ships) {
        if (s.status === "cancelled") continue;
        for (const l of JSON.parse(s.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, s.store_id);
        setShipStatus(s, "cancelled", reason);
      }
      db.run("UPDATE orders SET status='cancelled' WHERE id=?", o.id);
      if (o.promo) db.run("DELETE FROM promo_uses WHERE user_id=? AND code=?", o.user_id, o.promo);
    });
    bumpCatalog();
    return true;
  }
  /* the card payment arrived: the stores get the order now, as if it had just been placed */
  function orderPaid(orderId) {
    const now = Date.now(), ids = [];
    db.tx(() => {
      for (const s of db.all("SELECT * FROM shipments WHERE order_id=? AND status='unpaid'", orderId)) {
        const h = JSON.parse(s.history); h.push({ s: "new", t: now });
        db.run("UPDATE shipments SET status='new', status_at=?, history=?, start_at=? WHERE id=?", now, JSON.stringify(h), storeStartAt(db.get("SELECT hours FROM stores WHERE id=?", s.store_id), now), s.id);
        ids.push(s.id);
      }
    });
    for (const id of ids) { notify.shipmentNew(id); notify.paid(id); }
  }
  const payments = createPayments({ db, cfg, log, onPaid: orderPaid, cancelOrder });
  payments.routes(r);

  function setShipStatus(s, status, reason = null) {
    const now = Date.now(), h = JSON.parse(s.history); h.push({ s: status, t: now, ...(reason ? { r: reason } : {}) });
    db.run("UPDATE shipments SET status=?, status_at=?, history=?, accepted_at=CASE WHEN ?='assembling' AND accepted_at IS NULL THEN ? ELSE accepted_at END, cancel_reason=COALESCE(?, cancel_reason) WHERE id=?",
      status, now, JSON.stringify(h), status, now, reason, s.id);
    setImmediate(() => notify.status(s.id));
    const all = db.all("SELECT status FROM shipments WHERE order_id=?", s.order_id).map(x => x.status);
    const st = all.every(x => x === "cancelled") ? "cancelled" : all.every(x => ["delivered", "picked", "cancelled"].includes(x)) ? "done" : "active";
    db.run("UPDATE orders SET status=? WHERE id=?", st, s.order_id);
    if (status === "delivered" || status === "picked") bonus.shipDone({ ...s, status });
    if (st === "cancelled") bonus.orderCancelled(s.order_id);
    // a card-paid shipment the store failed (or the buyer cancelled in time): the money must go back — flagged for the admin until refunds are automated
    if (status === "cancelled" && reason !== "refund") {
      const o = db.get("SELECT * FROM orders WHERE id=?", s.order_id);
      if (o && o.pay_status === "paid" && !["store", "cash"].includes(o.pay)) {
        const part = JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0) + (s.price || 0);
        db.run("UPDATE orders SET pay_status='refund_due' WHERE id=?", o.id);
        notify.admins(`💳 Возврат по заказу ${o.num}: ${part.toLocaleString("ru-RU")} сум (${o.pay}) — отправление отменено (${reason || "—"}). Сделайте возврат в кабинете ${o.pay === "payme" ? "Payme" : "Click"}.`);
      }
    }
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
    notify.admins(`🏪 Новый магазин на проверке: <b>${s.name.replace(/[<>&]/g, "")}</b>\n${s.descr.slice(0, 200).replace(/[<>&]/g, "")}\nТел.: +${s.phone}\nОдобрить: ${cfg.siteUrl}#seller`);
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
    const ships = db.all("SELECT sh.*, o.num, o.form, o.created_at oc, o.pay, o.pay_status FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND sh.status<>'unpaid' ORDER BY sh.id DESC LIMIT 100", s.id);
    const revenue = ships.filter(x => x.oc >= since && x.status !== "cancelled").reduce((a, x) => a + JSON.parse(x.lines).reduce((b, l) => b + l.price * l.q, 0), 0);
    const products = db.all(`SELECT p.id,p.ru,p.uz,p.cat,p.sub,p.unit,p.kg,p.img,p.active,p.store_id, o.price,o.stock FROM offers o JOIN products p ON p.id=o.product_id WHERE o.store_id=? ORDER BY p.id`, s.id)
      .map(p => ({ ...p, img: mediaUrl(p.img), own: p.store_id === s.id }));
    return {
      store: publicStore(s),
      kpi: { revenue30: revenue, orders30: ships.filter(x => x.oc >= since).length, open: ships.filter(x => !["delivered", "picked", "cancelled"].includes(x.status)).length, products: products.length, out_of_stock: products.filter(p => p.stock <= 0).length },
      finance: storeFinance(s.id),
      rates: cfg.commission,
      telegram: !!req.user.tg_chat, bot: tg.enabled ? tg.username : null,
      rating: storeStats()[s.id] || null,
      reviews: db.all("SELECT r.ship_id, r.stars, r.text, r.reply, r.created_at, u.name FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.store_id=? ORDER BY r.created_at DESC LIMIT 20", s.id).map(x => ({ ...x, name: (x.name || "").split(" ")[0] })),
      orders: ships.map(x => {
        const f = JSON.parse(x.form);
        return { ship_id: x.id, num: x.num, t: x.oc, status: x.status, tariff: x.tariff, price: x.price, kg: x.kg, pay: x.pay, pay_status: x.pay_status,
          buyer: f.name, phone: f.phone, district: f.district, street: f.mode === "pickup" ? "" : f.street, when: f.when, hour: f.hour, comment: f.comment, lines: JSON.parse(x.lines),
          cancel_reason: x.cancel_reason, accept_by: x.status === "new" ? (x.start_at || x.status_at) + cfg.timers.cancel * 60000 : null, commission: x.commission,
          next: SELLER_MOVES[x.status]?.filter(n => (x.tariff ? n !== "ready" : !["searching"].includes(n))) || [] };
      }),
      products
    };
  });
  r.patch("/api/seller/offers/:pid", async (req, res, p) => {
    const { s } = needSeller(req), b = await readJson(req);
    const o = db.get("SELECT * FROM offers WHERE product_id=? AND store_id=?", Number(p.pid), s.id);
    if (!o) throw new HttpError(404, "not_found", "This store does not sell the product");
    const price = b.price !== undefined ? int(b.price, 100, 1e8) : o.price, stock = b.stock !== undefined ? int(b.stock, 0, 1e7) : o.stock;
    if (price === null || stock === null) throw bad("bad_offer", "Price must be ≥ 100 so'm, stock ≥ 0");
    db.run("UPDATE offers SET price=?, stock=?, updated_at=? WHERE product_id=? AND store_id=?", price, stock, Date.now(), o.product_id, s.id);
    bumpCatalog();
    return { offer: { product_id: o.product_id, store: s.id, price, stock } };
  });
  r.post("/api/seller/offers", async req => {
    // Start selling an existing catalog product (e.g. the same cement another store has)
    const { s } = needSeller(req), b = await readJson(req);
    const pid = int(b.product_id, 1, 1e9), price = int(b.price, 100, 1e8), stock = int(b.stock ?? 0, 0, 1e7);
    if (!pid || !price || stock === null) throw bad("bad_offer", "product_id, price and stock are required");
    if (!db.get("SELECT 1 FROM products WHERE id=? AND active=1", pid)) throw new HttpError(404, "not_found", "Product not found");
    db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id,store_id) DO UPDATE SET price=excluded.price, stock=excluded.stock, updated_at=excluded.updated_at", pid, s.id, price, stock, Date.now());
    bumpCatalog();
    return { offer: { product_id: pid, store: s.id, price, stock } };
  });
  r.post("/api/seller/import", async req => {
    // Price list import: many offers at once (matched in the browser) and new own products
    const { s } = needSeller(req), b = await readJson(req, 1024 * 1024);
    lim.hit("import:" + s.id, 20, 86400_000);
    const rows = Array.isArray(b.offers) ? b.offers.slice(0, 2000) : [], create = Array.isArray(b.create) ? b.create.slice(0, 300) : [];
    if (create.length) lim.hit("prod-new:" + s.id, 500, 86400_000, create.length);
    const bad1 = [];
    const ok = rows.map((x, i) => ({ i, pid: int(x.product_id, 1, 1e9), price: int(x.price, 100, 1e8), stock: x.stock === undefined || x.stock === null || x.stock === "" ? null : int(x.stock, 0, 1e7) }))
      .filter(x => { const good = x.pid && x.price && db.get("SELECT 1 FROM products WHERE id=? AND active=1", x.pid); if (!good) bad1.push(x.i); return good; });
    const mk = create.map((x, i) => {
      const ru = str(x.ru, 140), c = ref.cats.find(k => k.id === x.cat), price = int(x.price, 100, 1e8), kg = Number(x.kg) > 0 && Number(x.kg) <= 5000 ? Number(x.kg) : 1;
      return ru.length >= 3 && c && c.subs.some(k => k[0] === x.sub) && price ? { ru, uz: str(x.uz, 140) || ru, c, sub: x.sub, unit: subUnit(c.id, x.sub, x.unit), price, kg, stock: int(x.stock ?? 0, 0, 1e7) ?? 0 } : (bad1.push("n" + i), null);
    }).filter(Boolean);
    let updated = 0, added = 0, created = 0;
    db.tx(() => {
      const now = Date.now();
      for (const x of ok) {
        const had = db.get("SELECT stock FROM offers WHERE product_id=? AND store_id=?", x.pid, s.id);
        if (had) { db.run("UPDATE offers SET price=?, stock=?, updated_at=? WHERE product_id=? AND store_id=?", x.price, x.stock ?? had.stock, now, x.pid, s.id); updated++; }
        else { db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", x.pid, s.id, x.price, x.stock ?? 10, now); added++; }
      }
      for (const x of mk) {
        const nid = Math.max(10000, (db.get("SELECT MAX(id) m FROM products")?.m || 0) + 1);
        db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,hit,is_new,rating,reviews,country,warranty,descr,store_id,active,created_at)
          VALUES(?,?,?,?,?,?,?,?,'',0,1,0,0,?,0,'',?,1,?)`, nid, x.c.id, x.sub, subIcon(x.c.id, x.sub), x.ru, x.uz, x.unit, x.kg, JSON.stringify(["Узбекистан", "O‘zbekiston"]), s.id, now);
        db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", nid, s.id, x.price, x.stock, now);
        created++;
      }
    });
    if (updated + added + created) bumpCatalog();
    audit(req, "seller.import", s.id, { updated, added, created, skipped: bad1.length });
    return { updated, added, created, skipped: bad1.length };
  });
  r.post("/api/seller/products", async req => {
    const { s } = needSeller(req), b = await readJson(req);
    lim.hit("prod-new:" + s.id, 500, 86400_000);
    const ru = str(b.ru, 140), uz = str(b.uz, 140) || ru, cat = String(b.cat || ""), sub = String(b.sub || "");
    const c = ref.cats.find(x => x.id === cat);
    if (ru.length < 3) throw bad("bad_name", "Product name is required");
    if (!c || !c.subs.some(x => x[0] === sub)) throw bad("bad_category", "Choose a category and subcategory");
    const unit = subUnit(cat, sub, b.unit);
    const price = int(b.price, 100, 1e8), stock = int(b.stock ?? 0, 0, 1e7), kg = Number(b.kg);
    if (!price) throw bad("bad_price", "Price must be at least 100 so'm");
    if (stock === null) throw bad("bad_stock", "Stock must be 0 or more");
    if (!(kg > 0 && kg <= 5000)) throw bad("bad_weight", "Weight per unit (kg) is needed for delivery");
    const id = db.tx(() => {
      const nid = Math.max(10000, (db.get("SELECT MAX(id) m FROM products")?.m || 0) + 1);
      db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,hit,is_new,rating,reviews,country,warranty,descr,store_id,active,created_at)
        VALUES(?,?,?,?,?,?,?,?,'',0,1,0,0,?,?,?,?,1,?)`, nid, cat, sub, subIcon(cat, sub), ru, uz, unit, kg, JSON.stringify(["Узбекистан", "O‘zbekiston"]), int(b.warranty, 0, 120) || 0, str(b.desc, 1000), s.id, Date.now());
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
    lim.hit("photo:" + s.id, 100, 86400_000);
    const buf = await readBody(req, 5 * 1024 * 1024);
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? ".jpg" : buf.slice(0, 4).toString("hex") === "89504e47" ? ".png" : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? ".webp" : null;
    if (!ext) throw bad("bad_image", "Upload a JPEG, PNG or WEBP image up to 5 MB");
    const name = `p${prod.id}-${randomBytes(4).toString("hex")}${ext}`;
    writeFileSync(join(cfg.uploadsDir, name), buf);
    if (prod.img && prod.img.startsWith("/uploads/")) { try { unlinkSync(join(cfg.uploadsDir, prod.img.slice("/uploads/".length).replace(/[^\w.-]/g, ""))); } catch {} }
    db.run("UPDATE products SET img=? WHERE id=?", "/uploads/" + name, prod.id);
    bumpCatalog();
    return { img: mediaUrl("/uploads/" + name) };
  });
  r.patch("/api/seller/shipments/:id", async (req, res, p) => {
    const { u, s } = needSeller(req), b = await readJson(req);
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(p.id));
    if (!sh || (sh.store_id !== s.id && !adminOk(req))) throw new HttpError(404, "not_found", "Shipment not found");
    if (!(SELLER_MOVES[sh.status] || []).includes(b.status) || (b.status === "ready" && sh.tariff) || (b.status === "searching" && !sh.tariff)) throw bad("bad_status", `Cannot move from ${sh.status} to ${b.status}`);
    moveShipment(sh, b.status, req);
    return { ok: true, status: b.status };
  });

  /* One place for seller moves (cabinet, Telegram buttons): "cancelled" by the store means out of stock */
  function moveShipment(sh, status, req) {
    db.tx(() => {
      if (status === "cancelled") {
        for (const l of JSON.parse(sh.lines)) db.run("UPDATE offers SET stock=0, updated_at=? WHERE product_id=? AND store_id=?", Date.now(), l.id, sh.store_id);
        setShipStatus(sh, "cancelled", "out_of_stock");
      } else setShipStatus(sh, status);
    });
    if (status === "cancelled") bumpCatalog();
    audit(req, "ship." + status, sh.id);
  }

  /* ---------- reviews ---------- */
  r.post("/api/orders/:num/review", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const sh = db.get("SELECT * FROM shipments WHERE id=? AND order_id=?", int(b.ship_id, 1, 1e12), o.id);
    if (!sh) throw new HttpError(404, "not_found", "Shipment not found");
    if (!["delivered", "picked"].includes(sh.status)) throw bad("too_early", "You can rate the store after you receive the order");
    const stars = int(b.stars, 1, 5); if (!stars) throw bad("bad_stars", "Rate from 1 to 5 stars");
    try { db.run("INSERT INTO reviews(ship_id,order_id,store_id,user_id,stars,text,created_at) VALUES(?,?,?,?,?,?,?)", sh.id, o.id, sh.store_id, u.id, stars, str(b.text, 500), Date.now()); }
    catch { throw new HttpError(409, "already_rated", "You have already rated this order"); }
    const st = db.get("SELECT owner_id FROM stores WHERE id=?", sh.store_id), ow = st?.owner_id && db.get("SELECT tg_chat FROM users WHERE id=?", st.owner_id);
    if (ow?.tg_chat) tg.send(ow.tg_chat, `${"⭐".repeat(stars)} Новый отзыв к заказу ${o.num}${b.text ? `:\n«${str(b.text, 500).replace(/[<>&]/g, "")}»` : ""}`);
    return { ok: true };
  });
  r.get("/api/stores/:id/reviews", (req, res, p) => {
    const rows = db.all("SELECT r.stars, r.text, r.reply, r.created_at, u.name FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.store_id=? ORDER BY r.created_at DESC LIMIT 30", p.id);
    return { reviews: rows.map(x => ({ stars: x.stars, text: x.text, reply: x.reply, t: x.created_at, name: (x.name || "").split(" ")[0] || "Покупатель" })), rating: storeStats()[p.id] || null };
  });
  r.post("/api/seller/reviews/:ship/reply", async (req, res, p) => {
    const { s } = needSeller(req), b = await readJson(req);
    const rv = db.get("SELECT * FROM reviews WHERE ship_id=? AND store_id=?", int(p.ship, 1, 1e12), s.id);
    if (!rv) throw new HttpError(404, "not_found", "Review not found");
    db.run("UPDATE reviews SET reply=? WHERE id=?", str(b.reply, 500), rv.id);
    return { ok: true };
  });

  /* ---------- Telegram & push ---------- */
  r.post("/api/me/telegram", req => {
    const u = need(req);
    if (!tg.enabled || !tg.username) throw new HttpError(503, "telegram_not_configured", "Telegram bot is not connected on the server yet");
    const token = randomBytes(12).toString("hex");
    db.run("INSERT INTO tg_links(token,user_id,expires_at) VALUES(?,?,?)", token, u.id, Date.now() + 30 * 60000);
    return { url: `https://t.me/${tg.username}?start=${token}` };
  });
  r.del("/api/me/telegram", req => { const u = need(req); db.run("UPDATE users SET tg_chat=NULL WHERE id=?", u.id); return { ok: true }; });
  r.post("/api/push/subscribe", async req => {
    const u = need(req), b = await readJson(req);
    const ep = str(b.endpoint, 1000), p256 = str(b.keys?.p256dh, 200), au = str(b.keys?.auth, 100);
    if (!/^https:\/\//.test(ep) || !p256 || !au) throw bad("bad_subscription", "Invalid push subscription");
    db.run("INSERT INTO push_subs(endpoint,user_id,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth", ep, u.id, p256, au, Date.now());
    return { ok: true };
  });
  r.post("/api/push/unsubscribe", async req => { const u = need(req), b = await readJson(req); db.run("DELETE FROM push_subs WHERE endpoint=? AND user_id=?", str(b.endpoint, 1000), u.id); return { ok: true }; });
  r.post("/api/push/test", async req => { const u = need(req); const n = await push.toUser(u.id, { title: "Imorat Go", body: "Уведомления работают ✅", url: cfg.siteUrl }); return { sent: n }; });
  r.post("/api/me/logout-all", req => {
    const u = need(req);
    db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", u.id); db.run("DELETE FROM push_subs WHERE user_id=?", u.id);
    audit(req, "logout_all", u.id);
    return { ok: true };
  });

  tg.on("callback", async q => {
    if (await bot.callback(q)) return; // people's and masters' buttons
    const [act, idS] = String(q.data || "").split(":");
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(idS));
    const st = sh && db.get("SELECT * FROM stores WHERE id=?", sh.store_id);
    const ow = st?.owner_id && db.get("SELECT * FROM users WHERE id=?", st.owner_id);
    if (!sh || !ow || ow.tg_chat !== String(q.message?.chat?.id)) return tg.answer(q.id, "Нет доступа к этому заказу");
    const target = { acc: "assembling", oos: "cancelled", rdy: sh.tariff ? "searching" : "ready", pick: "picked" }[act];
    if (!target || !(SELLER_MOVES[sh.status] || []).includes(target)) { await tg.answer(q.id, "Статус уже изменён"); return notify.sellerRefresh(sh.id); }
    moveShipment(sh, target, { user: ow, ip: "telegram" });
    await tg.answer(q.id, { assembling: "Принято! Соберите заказ", cancelled: "Заказ отменён, товар скрыт из наличия", searching: "Вызываем курьера", ready: "Покупатель получит уведомление", picked: "Готово" }[target]);
  });

  /* ---------- finance: commission ledger and settlements ---------- */
  const monthRange = m => { const [y, mo] = (/^\d{4}-\d{2}$/.test(m || "") ? m : new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7)).split("-").map(Number); return [Date.UTC(y, mo - 1, 1) - 5 * 3600000, Date.UTC(y, mo, 1) - 5 * 3600000, `${y}-${String(mo).padStart(2, "0")}`]; };
  function storeFinance(storeId, m) {
    const [a, b, month] = monthRange(m);
    const mon = db.get("SELECT COALESCE(SUM(goods),0) goods, COALESCE(SUM(commission),0) commission, COUNT(*) n FROM shipments WHERE store_id=? AND status IN ('delivered','picked') AND status_at>=? AND status_at<?", storeId, a, b);
    const all = db.get("SELECT COALESCE(SUM(commission),0) c FROM shipments WHERE store_id=? AND status IN ('delivered','picked')", storeId).c;
    // Money that crossed sides: for orders paid to the store the buyer also handed it the delivery fee that Imorat Go paid to Yandex;
    // for orders paid by card online Imorat Go holds the goods money and owes the store its share (goods minus commission).
    const flow = db.get(`SELECT COALESCE(SUM(CASE WHEN o.pay IN ('store','cash') AND sh.tariff IS NOT NULL THEN sh.price ELSE 0 END),0) delivery_due,
        COALESCE(SUM(CASE WHEN o.pay NOT IN ('store','cash') AND o.pay_status='paid' THEN sh.goods - sh.commission ELSE 0 END),0) payout_due,
        COALESCE(SUM(CASE WHEN o.pay NOT IN ('store','cash') AND o.pay_status='paid' AND sh.status_at>=? AND sh.status_at<? THEN sh.goods ELSE 0 END),0) online_month
        FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND sh.status IN ('delivered','picked')`, a, b, storeId);
    const paid = db.get("SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE store_id=?", storeId).s;
    return { month, goods: mon.goods, commission: mon.commission, orders: mon.n, online_month: flow.online_month, commission_total: all, delivery_due: flow.delivery_due, payout_due: flow.payout_due, settled: paid, balance: all + flow.delivery_due - flow.payout_due - paid };
  }

  /* ---------- admin ---------- */
  r.get("/api/admin/mfa", req => { const u = needAdmin(req, { mfa: false }); return { on: !!u.totp_on, verified: req.mfa, required: cfg.adminMfa }; });
  r.post("/api/admin/mfa/setup", req => {
    const u = needAdmin(req, { mfa: false });
    if (u.totp_on) throw new HttpError(409, "mfa_already_on", "Two-step verification is already on");
    const secret = newSecret(); db.run("UPDATE users SET totp_secret=? WHERE id=?", secret, u.id);
    return { secret, url: otpauthUrl(secret, u.phone ? "+" + u.phone : u.id) };
  });
  r.post("/api/admin/mfa/verify", async req => {
    const u = needAdmin(req, { mfa: false }), b = await readJson(req);
    lim.hit("mfa:" + u.id, 10, 15 * 60000);
    if (!u.totp_secret || !checkTotp(u.totp_secret, b.code)) { audit(req, "mfa.fail", u.id); throw bad("mfa_wrong", "Wrong code"); }
    const step = String(Math.floor(Date.now() / 30000)) + ":" + String(b.code).replace(/\D/g, "");
    if (!db.run("UPDATE users SET totp_last=? WHERE id=? AND (totp_last IS NULL OR totp_last<>?)", step, u.id, step).changes) throw bad("mfa_reused", "This code was already used, wait for the next one");
    if (!u.totp_on) { db.run("UPDATE users SET totp_on=1 WHERE id=?", u.id); audit(req, "mfa.enabled", u.id); }
    return session(db.get("SELECT * FROM users WHERE id=?", u.id), { mfa: true });
  });
  r.get("/api/admin/finance", (req, res, p, url) => {
    needAdmin(req);
    const m = url.searchParams.get("month");
    const rows = db.all("SELECT id, name, status FROM stores ORDER BY name").map(s => ({ id: s.id, name: s.name, status: s.status, ...storeFinance(s.id, m) })).filter(x => x.orders || x.balance || x.commission_total);
    const t = rows.reduce((a, x) => ({ goods: a.goods + x.goods, commission: a.commission + x.commission, balance: a.balance + x.balance }), { goods: 0, commission: 0, balance: 0 });
    return { month: monthRange(m)[2], rates: cfg.commission, stores: rows, totals: t, settlements: db.all("SELECT st.*, s.name FROM settlements st LEFT JOIN stores s ON s.id=st.store_id ORDER BY st.created_at DESC LIMIT 30") };
  });
  r.post("/api/admin/settlements", async req => {
    const u = needAdmin(req), b = await readJson(req);
    const s = db.get("SELECT id FROM stores WHERE id=?", String(b.store_id || "")); if (!s) throw new HttpError(404, "not_found", "Store not found");
    const amount = int(b.amount, -1e12, 1e12); if (!amount) throw bad("bad_amount", "Amount is required");
    db.run("INSERT INTO settlements(store_id,amount,note,admin_id,created_at) VALUES(?,?,?,?,?)", s.id, amount, str(b.note, 200), u.id, Date.now());
    audit(req, "settlement", s.id, { amount, note: str(b.note, 200) });
    return { ok: true, finance: storeFinance(s.id) };
  });
  r.get("/api/admin/audit", req => { needAdmin(req); return { log: db.all("SELECT a.*, u.name, u.phone FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100") }; });
  r.get("/api/admin/stores", req => { needAdmin(req); return { stores: db.all("SELECT s.*, u.name owner_name, u.phone owner_phone FROM stores s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.status='pending' DESC, s.created_at DESC").map(s => ({ ...publicStore(s), owner_name: s.owner_name, owner_phone: s.owner_phone, loc_src: s.loc_src, created: s.created_at, note: s.review_note })) }; });
  r.patch("/api/admin/stores/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const s = db.get("SELECT * FROM stores WHERE id=?", p.id); if (!s) throw new HttpError(404, "not_found", "Store not found");
    if (b.status && !["active", "pending", "rejected", "blocked"].includes(b.status)) throw bad("bad_status", "Unknown status");
    db.run("UPDATE stores SET status=COALESCE(?,status), review_note=COALESCE(?,review_note), verified=COALESCE(?,verified) WHERE id=?", b.status || null, b.note != null ? str(b.note, 300) : null, b.verified == null ? null : b.verified ? 1 : 0, s.id);
    audit(req, "store." + (b.status || "edit"), s.id, { note: str(b.note, 300), owner_phone: str(b.owner_phone, 20) });
    if (b.status === "active" && s.status !== "active") channel.storeApproved(s).catch(e => log.warn("[channel]", e.message));
    if (b.status && s.owner_id) { const ow = db.get("SELECT tg_chat FROM users WHERE id=?", s.owner_id); if (ow?.tg_chat) tg.send(ow.tg_chat, b.status === "active" ? `🎉 Магазин «${s.name.replace(/[<>&]/g, "")}» одобрен и виден покупателям на Imorat Go.` : `Статус магазина «${s.name.replace(/[<>&]/g, "")}»: ${b.status}.${b.note ? " " + str(b.note, 300).replace(/[<>&]/g, "") : ""}`); }
    if (b.owner_phone) {
      const ph = parsePhone(b.owner_phone), ou = db.get("SELECT * FROM users WHERE phone=?", ph);
      if (!ou) throw new HttpError(404, "user_not_found", "The owner must sign in once first");
      db.run("UPDATE stores SET owner_id=? WHERE id=?", ou.id, s.id); db.run("UPDATE users SET role='seller', store_id=? WHERE id=?", s.id, ou.id);
      db.run("UPDATE users SET store_id=NULL, role='buyer' WHERE store_id=? AND id<>?", s.id, ou.id);
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
    setShipStatus(sh, b.status, b.status === "cancelled" ? "admin" : null);
    audit(req, "admin.ship." + b.status, sh.id);
    return { ok: true };
  });
  r.patch("/api/admin/orders/:num/pay", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    if (!["paid", "pending", "refunded", "refund_due", "on_delivery"].includes(b.pay_status)) throw bad("bad_status", "Unknown payment status");
    const o = db.get("SELECT id FROM orders WHERE num=?", p.num); if (!o) throw new HttpError(404, "not_found", "Order not found");
    db.run("UPDATE orders SET pay_status=? WHERE id=?", b.pay_status, o.id);
    audit(req, "order.pay." + b.pay_status, p.num);
    return { ok: true };
  });

  const mastersApi = registerMasters({ r, db, cfg, ref, need, needAdmin, audit, lim, tg, push, sms, log });
  bot = registerBot({ db, cfg, ref, tg, bonus, masters: mastersApi, log });
  bonus.routes(r, need, lim);
  registerStats({ r, db, lim, needSeller });
  channel.routes(r, needAdmin);
  registerQuestions({ r, db, cfg, need, needSeller, lim, tg, push, log });
  registerTeams({ r, db, cfg, need, lim, tg, log });
  registerDashboard({ r, db, needAdmin });
  const cx = registerCatalogExtras({ r, db, cfg, need, lim, tg, push, saveImage, mediaUrl, log });
  registerDisputes({ r, db, cfg, need, needSeller, needAdmin, isAdmin, audit, lim, tg, push, saveImage, mediaUrl, log });

  /* ---------- HTTP server ---------- */
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://x");
    req.ip = clientIp(req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'");
    cors(req, res, cfg.origins);
    try {
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.method === "GET" && url.pathname.startsWith("/uploads/")) return serveUpload(url.pathname.slice(9), res);
      const m = r.match(req.method, url.pathname);
      if (m === "method") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      if (!m) throw new HttpError(404, "not_found", "Not found");
      lim.hit("ip:" + req.ip, cfg.ratePerIpMin, 60_000);
      req.user = userFrom(req);
      const out = await m.route.handler(req, res, m.params, url);
      if (!res.headersSent && out !== undefined) send(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) { log.error("[error]", req.method, url.pathname, e); if (Date.now() - (server.lastAlert || 0) > 600000) { server.lastAlert = Date.now(); notify.admins(`⚠️ Ошибка сервера: ${req.method} ${url.pathname}\n${String(e.message).slice(0, 200).replace(/[<>&]/g, "")}`); } }
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

  /* ---------- background jobs: seller deadlines and daily backups ---------- */
  function sweep(now = Date.now()) {
    const T = cfg.timers;
    for (const s of db.all("SELECT * FROM shipments WHERE status='new'")) {
      const age = (now - (s.start_at || s.status_at)) / 60000;
      if (age >= T.cancel) {
        db.tx(() => { for (const l of JSON.parse(s.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, s.store_id); setShipStatus(s, "cancelled", "not_accepted"); });
        bumpCatalog(); log.info(`[timer] shipment ${s.id} cancelled: not accepted in ${T.cancel} min`);
      } else if (age >= T.sms && !s.sms_sent) { db.run("UPDATE shipments SET sms_sent=1, reminded=1 WHERE id=?", s.id); notify.smsSeller(s.id); notify.remind(s.id); }
      else if (age >= T.remind && !s.reminded) { db.run("UPDATE shipments SET reminded=1 WHERE id=?", s.id); notify.remind(s.id); }
    }
    for (const s of db.all("SELECT sh.*, o.form FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.status='assembling'")) {
      const limit = (JSON.parse(s.form).when === "asap" ? T.handover : 30) * 3600000;
      if (now - (s.accepted_at || s.status_at) > limit) {
        db.tx(() => { for (const l of JSON.parse(s.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, s.store_id); setShipStatus(s, "cancelled", "not_shipped"); });
        bumpCatalog(); log.info(`[timer] shipment ${s.id} cancelled: not handed over`);
      }
    }
    db.run("DELETE FROM tg_links WHERE expires_at<?", now);
    payments.sweep(now);
  }
  function backup() {
    if (!cfg.backupDir || cfg.dbPath === ":memory:") return;
    try {
      mkdirSync(cfg.backupDir, { recursive: true });
      const day = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10), file = join(cfg.backupDir, `imorat-${day}.db`);
      if (!existsSync(file)) { db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); log.info("[backup] saved", file); }
      readdirSync(cfg.backupDir).filter(f => /^imorat-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14).forEach(f => unlinkSync(join(cfg.backupDir, f)));
    } catch (e) { log.error("[backup] failed", e.message); notify.admins("⚠️ Резервная копия базы не сохранилась: " + String(e.message).slice(0, 150)); }
  }
  const timers = [setInterval(() => { try { sweep(); } catch (e) { log.error("[sweep]", e); } if (channel.enabled()) channel.daily().catch(e => log.error("[channel]", e)); try { cx.stockSweep(); } catch (e) { log.error("[stock]", e); } }, 30000), setInterval(backup, 3600000)];
  server.on("listening", () => { tg.start(); backup(); });
  server.stopJobs = () => { timers.forEach(clearInterval); tg.stop(); };
  server.on("close", server.stopJobs);
  server.sweep = sweep;
  server.backup = backup;
  server.channel = channel;
  server.stockSweep = () => cx.stockSweep();
  server.db = db;
  return server;
}
