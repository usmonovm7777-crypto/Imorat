import { createServer } from "node:http";
import { createReadStream, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { openDb } from "./db.js";
import { Router, HttpError, bad, readJson, readBody, send, cors, Limiter, clientIp, int, str } from "./http.js";
import { signJwt, verifyJwt, parsePhone, issueOtp, checkOtp, verifyIdToken, newUserId, publicUser, hashPassword, verifyPassword, tempPassword, assertStrongPassword } from "./auth.js";
import { createSms } from "./sms.js";
import { loadLines, quote, assertNoProblems, dimsOf } from "./pricing.js";
import { yandexPrices } from "./delivery.js";
import { createCourier } from "./courier.js";
import { createGeo } from "./geo.js";
import { buildRequest, streamChat } from "./ai.js";
import { createTelegram } from "./telegram.js";
import { createPush } from "./push.js";
import { createNativePush } from "./push_native.js";
import { createNotify } from "./notify.js";
import { newSecret, checkTotp, otpauthUrl } from "./totp.js";
import { registerMasters } from "./masters.js";

/* API contract: the site and the app declare the same number (API_CONTRACT in index.html). It goes up only when a change
   breaks older clients; MIN_CLIENT is the oldest client contract this server still serves. The app's release build checks
   /api/health against its own number before it is allowed to ship, and the running app shows "update the app" on a mismatch. */
export const API_CONTRACT = 1, MIN_CLIENT = 1;
/* t + n months, date to date: 15 Jan → 15 Apr. A day the target month lacks lands on its last day (31 Jan + 3 → 30 Apr,
   30 Nov + 3 → 28/29 Feb) instead of spilling into the next month as Date.setMonth would. */
export function addMonthsClamped(t, n) {
  const d = new Date(t), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0"; } catch { return "0"; } })();
import { registerBot } from "./bot.js";
import { createBonus } from "./bonus.js";
import { registerStats } from "./stats.js";
import { createPayments } from "./payments.js";
import { createChannel } from "./channel.js";
import { registerDisputes } from "./disputes.js";
import { registerQuestions } from "./questions.js";
import { registerSupport } from "./support.js";
import { registerModeration } from "./moderation.js";
import { registerModel3d } from "./model3d.js";
import { registerCatalogExtras } from "./catalogx.js";
import { registerTeams } from "./teams.js";
import { registerDashboard } from "./dashboard.js";

export const STEPS = {
  yandex: ["new", "assembling", "searching", "to_store", "on_way", "delivered"],
  store: ["new", "assembling", "on_way", "delivered"], // the store's own courier: no search, no "driving to the store"
  pickup: ["new", "assembling", "ready", "picked"]
};
const SELLER_MOVES = { new: ["assembling", "cancelled"], assembling: ["searching", "ready", "on_way", "cancelled"], ready: ["picked"], searching: ["to_store"], to_store: ["on_way"], on_way: ["delivered"] };
const flowOf = (sh, f) => sh.tariff ? (f?.delivery_by === "store" ? "store" : "yandex") : "pickup";
const FAIL_REASONS = ["not_accepted", "out_of_stock", "not_shipped"];
const SESSION_TTL = 60 * 86400, STAFF_TTL = 14 * 86400; // a password session of the owner / a helper is shorter than a buyer's
const MIME = { ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".glb": "model/gltf-binary" };

export function createApp(cfg, log = console) {
  const db = openDb(cfg.dbPath, cfg.catalogPath, { demoStores: cfg.demoStores });
  const ref = db.ref;
  const subIcon = (cat, sub) => { const m = new Map(); for (const p of ref.products) if (p.cat === cat && p.sub === sub && p.icon) m.set(p.icon, (m.get(p.icon) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1])[0]?.[0] || ref.cats.find(c => c.id === cat)?.icon || "box"; };
  const subUnit = (cat, sub, want) => { if (want && typeof want === "string" && Object.hasOwn(ref.units, want)) return want; const m = new Map(); for (const p of ref.products) if (p.cat === cat && p.sub === sub) m.set(p.unit, (m.get(p.unit) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1])[0]?.[0] || "pcs"; };
  const sms = createSms(cfg.sms, log);
  const lim = new Limiter();
  const r = new Router();
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const isDistrict = x => typeof x === "string" && Object.hasOwn(D, x); // never "constructor" / "__proto__" from a client
  const CATS = new Set(ref.cats.map(c => c.id));
  mkdirSync(cfg.uploadsDir, { recursive: true });
  const bumpCatalog = () => db.setMeta("catalog_rev", Date.now());
  const tg = createTelegram(cfg.telegram, log);
  const webPush = createPush(db, cfg.pushSubject, log), nativePush = createNativePush({ db, cfg, log });
  // one door for notifications: the installed site (Web Push) and the app (FCM / APNs) both hang on push.toUser
  const push = { publicKey: webPush.publicKey, native: nativePush.enabled, async toUser(uid, data) { const [a, b] = await Promise.all([webPush.toUser(uid, data), nativePush.toUser(uid, data)]); return a + b; } };
  const notify = createNotify({ db, cfg, tg, push, sms, ref, log });
  const bonus = createBonus({ db, cfg, log });
  const courier = createCourier({ db, cfg, ref, log });
  const geo = createGeo({ cfg, log });
  let bot = { callback: async () => false };
  const channel = createChannel({ db, cfg, tg, log });
  const PCAT = new Map(db.all("SELECT id, cat FROM products").map(p => [p.id, p.cat]));
  const rateOf = cat => cfg.commission[cat] ?? cfg.commission["*"] ?? 0;
  /* What a store pays from a card-paid order: Quriliş Go's commission (0% during the store's first free months) and the bank's
     acquiring fee — two separate lines in the cabinet. The end of the free months is set when a store is approved. */
  const addMonths = addMonthsClamped;
  const inPromo = (s, at = Date.now()) => !!(s?.free_until && s.free_until > at);
  /* a delivery price typed by a store: a number, or a string of digits with spaces ("25 000"); anything else (null, true, [], "") is refused */
  const deliveryPriceOf = v => { const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d[\d ]{0,9}\s*$/.test(v) ? Number(v.replace(/ /g, "")) : NaN; return Number.isInteger(n) && n >= 0 && n <= 5_000_000 ? n : null; };
  /* how long ago the seller last confirmed or edited prices: the newest offer change or the store-wide confirmation */
  const pricesFreshness = s => { const last = Math.max(s.prices_confirmed_at || 0, db.get("SELECT COALESCE(MAX(updated_at),0) m FROM offers WHERE store_id=?", s.id).m || 0); return { confirmed_at: last || null, days: last ? Math.floor((Date.now() - last) / 86400000) : null, stale: !last || Date.now() - last > 7 * 86400000 }; };
  const storeRates = s => ({ platform: cfg.commission, acquiring: cfg.acquiring, acquiring_by: cfg.acquiringBy, promo_months: cfg.promoMonths, free_until: s?.free_until || null, promo: inPromo(s) });
  // stores that were active before this rule arrived get their free months from the day they were created
  for (const s of db.all("SELECT id, created_at FROM stores WHERE free_until IS NULL AND status='active'")) db.run("UPDATE stores SET free_until=? WHERE id=?", addMonths(s.created_at, cfg.promoMonths), s.id);
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
    for (const r of db.all("SELECT store_id, AVG(stars) a, COUNT(*) n FROM reviews WHERE mod IS NULL OR mod<>'rejected' GROUP BY store_id")) (out[r.store_id] ||= { done: 0, fail: 0, accept_min: null }).stars = Math.round(r.a * 10) / 10, out[r.store_id].reviews = r.n;
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
  /* Who runs the place. "owner": the phone numbers in ADMIN_PHONES and the login from OWNER_LOGIN — everything, including money and
     analytics. "admin": a helper the owner added from the panel — moderation, orders and complaints, nothing about money. */
  const staffOf = u => (u ? db.get("SELECT * FROM staff WHERE user_id=?", u.id) : null) || null; // the staff table is the truth; users.role is only a hint
  const roleOf = u => { if (!u) return null; if (u.phone && cfg.admins.includes(u.phone)) return "owner"; const st = staffOf(u); return st && !st.disabled ? st.role : null; };
  const isAdmin = u => !!roleOf(u);
  const isOwner = u => roleOf(u) === "owner";
  const adminOk = req => { try { needAdmin(req); return true; } catch { return false; } };
  const needAdmin = (req, { mfa = true } = {}) => {
    const u = need(req); if (!isAdmin(u)) throw new HttpError(403, "forbidden", "Admins only");
    if (staffOf(u)?.must_change) throw new HttpError(403, "password_change_required", "Change the temporary password first");
    if (mfa && cfg.adminMfa) {
      if (!u.totp_on) throw new HttpError(403, "mfa_setup_required", "Turn on two-step verification for the admin account");
      if (!req.mfa) throw new HttpError(403, "mfa_required", "Enter the code from your authenticator app");
    }
    return u;
  };
  const needOwner = (req, opts) => { const u = needAdmin(req, opts); if (!isOwner(u)) throw new HttpError(403, "owner_only", "Only the owner of Quriliş Go can do this"); return u; };
  /* the owner's login/password from .env becomes (or refreshes) the owner's staff row: the hash in .env always wins */
  function ensureOwner() {
    const endSessions = id => db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", id);
    if (!cfg.owner.login) { for (const x of db.all("SELECT user_id FROM staff WHERE from_env=1 AND disabled=0")) { db.run("UPDATE staff SET disabled=1 WHERE user_id=?", x.user_id); endSessions(x.user_id); } return; }
    const now = Date.now();
    const st = db.get("SELECT * FROM staff WHERE from_env=1");
    // a helper created earlier under the same login (any case) would collide with the UNIQUE index: it is renamed and disabled, the owner keeps the login
    const clash = db.get("SELECT user_id, login FROM staff WHERE lower(login)=lower(?) AND from_env=0", cfg.owner.login);
    if (clash) { db.run("UPDATE staff SET login=?, disabled=1 WHERE user_id=?", (clash.login + ".old-" + randomBytes(2).toString("hex")).slice(0, 64), clash.user_id); endSessions(clash.user_id); log.warn(`[owner] helper account "${clash.login}" used OWNER_LOGIN — it was renamed and disabled; give the helper a new login from the panel`); }
    if (!st) {
      const id = "owner_" + randomBytes(4).toString("hex");
      db.run("INSERT INTO users(id,phone,name,email,role,district,created_at) VALUES(?,NULL,?,'','staff','mirob',?)", id, "Владелец Quriliş Go", now);
      db.run("INSERT INTO staff(user_id,login,pass_hash,role,from_env,created_by,created_at) VALUES(?,?,?,'owner',1,'env',?)", id, cfg.owner.login, cfg.owner.hash, now);
      return;
    }
    if (st.pass_hash !== cfg.owner.hash || st.login !== cfg.owner.login) endSessions(st.user_id); // a new password in .env signs the owner out everywhere (a stolen token dies with the old password)
    db.run("UPDATE staff SET login=?, pass_hash=?, role='owner', disabled=0 WHERE user_id=?", cfg.owner.login, cfg.owner.hash, st.user_id);
    db.run("UPDATE users SET role='staff' WHERE id=? AND role<>'staff'", st.user_id);
  }
  ensureOwner();
  const needSeller = req => {
    const u = need(req);
    const s = u.store_id && db.get("SELECT * FROM stores WHERE id=?", u.store_id);
    if (!s) throw new HttpError(403, "no_store", "Register your store first");
    // A pending store may prepare its goods (they stay hidden until approval); a blocked or rejected one only sees its own page
    if ((s.status === "blocked" || s.status === "rejected") && !/^\/api\/seller\/(store|summary)(\?|$)/.test(req.url) && !isAdmin(u)) throw new HttpError(403, "store_" + s.status, "The store is " + s.status + "; contact Quriliş Go support");
    return { u, s };
  };
  const session = (u, extra = {}) => { const st = staffOf(u); return { token: signJwt({ sub: u.id, typ: "session", v: u.token_ver || 0, ...extra }, cfg.jwtSecret, extra.mfa ? 12 * 3600 : st ? STAFF_TTL : SESSION_TTL), user: { ...publicUser(u, cfg.admins, st), telegram: !!u.tg_chat, mfa: !!u.totp_on } }; };
  const mediaUrl = p => (p && p.startsWith("/uploads/") ? cfg.publicUrl + p : p);
  const moderation = registerModeration({ r, db, cfg, needAdmin, tg, push, notify, bumpCatalog, mediaUrl, log, audit });
  const model3d = registerModel3d({ r, db, cfg, needSeller, lim, mediaUrl, bumpCatalog, log });
  /* Saves an uploaded JPEG/PNG/WEBP (checked by its first bytes) and returns its /uploads path */
  const saveImage = (buf, prefix) => {
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? ".jpg" : buf.slice(0, 4).toString("hex") === "89504e47" ? ".png" : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? ".webp" : null;
    if (!ext) throw bad("bad_image", "Upload a JPEG, PNG or WEBP image up to 5 MB");
    const name = `${prefix}-${randomBytes(5).toString("hex")}${ext}`;
    writeFileSync(join(cfg.uploadsDir, name), buf);
    return "/uploads/" + name;
  };
  /* delete a file this server saved earlier (a replaced photo); anything outside the uploads folder is ignored */
  const removeUpload = path => { if (typeof path === "string" && path.startsWith("/uploads/")) { try { unlinkSync(join(cfg.uploadsDir, path.slice("/uploads/".length).replace(/[^\w.-]/g, ""))); } catch {} } };
  /* the way to access for a new store: application → the admin checks it and sets a meeting → the contract is signed on paper → access opens */
  const contractView = s => ({ meet_at: s.meet_at || null, meet_place: s.meet_place || "", contract_no: s.contract_no || "", contract_at: s.contract_at || null });
  const publicStore = s => ({
    id: s.id, name: s.name, d: s.district, addr: s.addr, addrUz: s.addr_uz || s.addr, hours: s.hours, ru: s.ru || s.descr.slice(0, 80), uz: s.uz || s.ru || s.descr.slice(0, 80),
    descr: s.descr, cats: JSON.parse(s.cats || "[]"), phone: s.phone, telegram: s.telegram, verified: !!s.verified, landmark: s.landmark, la: s.la, lo: s.lo, status: s.status, loc_src: s.loc_src, note: s.review_note, created: s.created_at
  });
  const ownerStore = s => ({ ...publicStore(s), payout_to: s.payout_to || "", free_until: s.free_until || null, prices_confirmed_at: s.prices_confirmed_at || null, ...contractView(s) }); // the store's own view adds its payout details, free months, price confirmation

  /* ---------- meta ---------- */
  r.get("/api/health", () => ({ ok: true, time: Date.now(), name: "imorat-api", version: PKG_VERSION, contract: API_CONTRACT, min_client: MIN_CLIENT }));
  r.get("/api/config", () => ({
    sms: sms.mode, google_client_id: cfg.google.clientId || null, apple_client_id: cfg.apple.clientId || null,
    apple_redirect_uri: cfg.apple.redirectUri || null, ai: !!cfg.ai.key, yandex: !!cfg.yandex.token, pay_at_store: cfg.allowPayAtStore, discounts: cfg.discounts, model3d: !!cfg.model3d.workerToken, model3d_worker: model3d.workerOnline(),
    payments: cfg.paymentsOnline, telegram_bot: tg.enabled ? tg.username || null : null, telegram_channel: /^@/.test(cfg.channel?.chat || "") ? cfg.channel.chat : null, push_key: push.publicKey,
    timers: cfg.timers, commission: cfg.commission, acquiring: cfg.acquiring, acquiring_by: cfg.acquiringBy, promo_months: cfg.promoMonths, demo: cfg.demoStores,
    ymaps_key: cfg.maps.jsKey || null, geo: geo.provider, bonus: cfg.bonus.enabled, // the site draws a Yandex map with the key; address search goes through /api/geo
    site_url: cfg.siteUrl, // the public website (SITE_URL): legal pages for the app, the bank's return address — an explicit setting, never derived from the API host
    pay_on_receipt: cfg.payOnReceipt, delivery_by: cfg.deliveryBy // "stage 0": buyers pay the store on receipt; who delivers (yandex | store)
  }));
  /* ---------- address search for the checkout map ---------- */
  const langOf = url => (["ru", "uz", "en"].includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : "ru");
  r.get("/api/geo/suggest", async (req, res, p, url) => { lim.hit("geo-ip:" + req.ip, 90, 60_000); return { items: await geo.suggest(url.searchParams.get("q"), langOf(url)) }; });
  r.get("/api/geo/reverse", async (req, res, p, url) => { lim.hit("geo-ip:" + req.ip, 90, 60_000); return { item: await geo.reverse(url.searchParams.get("la"), url.searchParams.get("lo"), langOf(url)) }; });

  /* ---------- auth ---------- */
  r.post("/api/auth/otp/send", async req => {
    const b = await readJson(req);
    const phone = parsePhone(b.phone);
    // app-store reviewers' account: a fixed code from REVIEW_ACCOUNTS, nothing is sent (works in every SMS mode)
    if (cfg.reviewAccounts[phone]) { lim.hit("otp-ip:" + req.ip, cfg.otpPerIpHour, 3600_000); issueOtp(db, cfg.jwtSecret, phone, cfg.reviewAccounts[phone]); return { sent: true, retry_in: 60 }; }
    if (sms.mode === "telegram") throw new HttpError(503, "sms_off", "Sign in through the Telegram bot — SMS codes are not connected yet");
    lim.hit("otp-ip:" + req.ip, cfg.otpPerIpHour, 3600_000);
    lim.hit("sms-all-h", cfg.smsPerHour, 3600_000); lim.hit("sms-all-d", cfg.smsPerDay, 86400_000); // an SMS flood to many numbers stops at the budget
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
      // a short ticket that lets this person set (or reset) the password right after confirming the phone by SMS
      return { ...session(u), is_new: isNew || !u.name, has_password: !!u.pw_hash, pw_ticket: signJwt({ typ: "pwset", sub: u.id, pa: u.pw_at || 0 }, cfg.jwtSecret, 900) }; // pa: the ticket works until the password changes — once
    });
  });
  /* ---------- sign in by phone + password (buyers, masters, sellers). The password is set after the phone is confirmed by an SMS code
     (registration or "forgot password"); failures are limited per number and per address, and every answer to a wrong pair is the same ---------- */
  r.post("/api/auth/login", async req => {
    const b = await readJson(req);
    let phone = ""; try { phone = parsePhone(b.phone); } catch { throw new HttpError(401, "bad_login", "Wrong phone number or password"); }
    const password = typeof b.password === "string" ? b.password : "";
    const failKey = "pw-fail:" + phone + ":" + req.ip, phoneKey = "pw-fail-ph:" + phone;
    lim.hit("pw-ip:" + req.ip, 40, 15 * 60000);
    lim.hit(failKey, 8, 15 * 60000, 0); lim.hit(phoneKey, 40, 3600_000, 0); // weight 0: a check only — failures are counted below
    const u = db.get("SELECT * FROM users WHERE phone=? AND deleted_at IS NULL", phone);
    const ok = verifyPassword(password, u?.pw_hash) && !!u?.pw_hash; // an unknown number is checked against a dummy hash: same timing
    if (!ok) {
      try { lim.hit(failKey, 8, 15 * 60000); lim.hit(phoneKey, 40, 3600_000); } catch { /* this attempt still answers 401; the next one gets 429 */ }
      throw new HttpError(401, "bad_login", "Wrong phone number or password");
    }
    if (staffOf(u)) throw new HttpError(403, "staff_account", "Staff sign in with their login on the staff page");
    db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", u.id, "login.password", u.id, "{}", req.ip, Date.now());
    return { ...session(u), is_new: !u.name, has_password: true };
  });
  /* set or change the password: right after an SMS code (pw_ticket), with the current password, or the first time for an account
     that has none. Changing an existing password ends the other sessions. */
  r.post("/api/auth/password", async req => {
    const u = need(req), b = await readJson(req);
    if (staffOf(u)) throw new HttpError(403, "staff_account", "Staff change their password in the staff panel");
    assertStrongPassword(b.password, { min: 8, phone: u.phone, name: u.name }); // the same rules as the sign-up form; cheap, so before the attempt limit
    lim.hit("pwset:" + u.id, 10, 3600_000);
    const t = b.ticket ? verifyJwt(b.ticket, cfg.jwtSecret) : null;
    const byTicket = !!t && t.typ === "pwset" && t.sub === u.id && (t.pa || 0) === (u.pw_at || 0); // single use: a password set with it changes pw_at
    if (u.pw_hash && !byTicket && !verifyPassword(typeof b.current === "string" ? b.current : "", u.pw_hash)) throw new HttpError(403, "bad_current", "Enter your current password or confirm the phone by SMS");
    if (u.pw_hash && typeof b.password === "string" && verifyPassword(b.password, u.pw_hash)) throw bad("weak_password", "Choose a password you have not used here", { reason: "same_as_old" });
    const hash = hashPassword(b.password, 8);
    const had = !!u.pw_hash;
    db.run("UPDATE users SET pw_hash=?, pw_at=?, token_ver=token_ver+? WHERE id=?", hash, Date.now(), had ? 1 : 0, u.id);
    audit(req, had ? "password.change" : "password.set", u.id);
    const fresh = db.get("SELECT * FROM users WHERE id=?", u.id);
    return { ...session(fresh), has_password: true };
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
  /* ---------- sign in with Telegram: the site opens the bot with a one-time ticket, the bot binds the chat's account
     (asking for the phone number if the chat is new) and the site picks the session up by polling ---------- */
  r.post("/api/auth/tg/start", req => {
    lim.hit("tgstart-ip:" + req.ip, 30, 3600_000);
    if (!tg.enabled || !tg.username) throw new HttpError(503, "telegram_off", "Telegram sign-in is not connected on the server yet");
    const ticket = randomBytes(16).toString("hex");
    db.run("INSERT INTO tg_logins(ticket,user_id,created_at,expires_at,ip) VALUES(?,NULL,?,?,?)", ticket, Date.now(), Date.now() + 10 * 60000, String(req.ip || "").slice(0, 45));
    return { ticket, url: `https://t.me/${tg.username}?start=login_${ticket}`, bot: tg.username };
  });
  r.get("/api/auth/tg/poll", (req, res, p, url) => {
    lim.hit("tgpoll-ip:" + req.ip, 600, 3600_000);
    const row = db.get("SELECT * FROM tg_logins WHERE ticket=?", String(url.searchParams.get("ticket") || "").slice(0, 64));
    if (!row || row.expires_at < Date.now()) throw new HttpError(410, "ticket_expired", "Sign-in took too long, start again");
    if (!row.user_id) return { pending: true };
    const u = db.get("SELECT * FROM users WHERE id=?", row.user_id); db.run("DELETE FROM tg_logins WHERE ticket=?", row.ticket);
    if (!u) throw new HttpError(410, "ticket_expired", "Sign-in took too long, start again");
    db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", u.id, "login.telegram", u.id, "{}", req.ip, Date.now());
    return { ...session(u), is_new: !u.name };
  });
  /* ---------- staff sign-in: the owner (login from .env) and the helpers the owner added, by login + password ---------- */
  r.post("/api/auth/staff", async req => {
    const b = await readJson(req);
    const login = typeof b.login === "string" ? b.login.trim().slice(0, 64) : "", password = typeof b.password === "string" ? b.password : "";
    const lkey = login.toLowerCase();
    const failKey = "staff-fail:" + lkey + ":" + req.ip, loginKey = "staff-fail-login:" + lkey; // only FAILURES count, so a stranger guessing the owner's login cannot lock the owner out
    lim.hit("staff-ip:" + req.ip, 30, 15 * 60000);
    if (login) { lim.hit(failKey, 10, 15 * 60000, 0); lim.hit(loginKey, 300, 3600_000, 0); } // weight 0: a check — 10 failures per login+IP a quarter hour, 300 per login an hour from anywhere
    const st = login ? db.get("SELECT * FROM staff WHERE lower(login)=lower(?)", login) : null;
    const ok = verifyPassword(password, st?.pass_hash) && st && !st.disabled; // the dummy hash is checked when the login is unknown: same timing
    if (!ok) {
      if (login) { try { lim.hit(failKey, 10, 15 * 60000); lim.hit(loginKey, 300, 3600_000); } catch { /* this attempt still answers 401; the next one gets 429 */ } }
      db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", st?.user_id || null, "staff.login_fail", /^[A-Za-z0-9_.@-]{3,64}$/.test(login) ? login : "", "{}", req.ip, Date.now()); // the audit keeps real-looking logins only, not whatever was typed
      throw new HttpError(401, "bad_login", "Wrong login or password");
    }
    const u = db.get("SELECT * FROM users WHERE id=?", st.user_id);
    if (!u) throw new HttpError(401, "bad_login", "Wrong login or password");
    lim.forget(failKey);
    db.run("UPDATE staff SET last_login_at=? WHERE user_id=?", Date.now(), st.user_id);
    audit(req, "staff.login", u.id);
    return session(u);
  });
  /* a helper changes their own password (the owner's password is set on the server: `imorat owner`) */
  r.post("/api/me/password", async req => {
    const u = need(req), b = await readJson(req), st = staffOf(u);
    if (!st) throw new HttpError(409, "no_password", "This account signs in by phone or Telegram, it has no password");
    if (st.from_env) throw new HttpError(409, "owner_env", "The owner's password is set on the server with `imorat owner`");
    lim.hit("pwchange:" + u.id, 10, 3600_000);
    if (typeof b.old !== "string" || !verifyPassword(b.old, st.pass_hash)) throw bad("bad_login", "The current password is wrong");
    if (b.password === b.old) throw bad("weak_password", "Choose a password you have not used here", { reason: "same_as_old" });
    assertStrongPassword(b.password, { min: 10, phone: u.phone, name: u.name }); // staff: 10+ characters and the same rules as everyone
    const hash = hashPassword(b.password);
    db.run("UPDATE staff SET pass_hash=?, must_change=0 WHERE user_id=?", hash, u.id);
    db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", u.id); // every other session of this helper ends
    audit(req, "staff.password", u.id);
    return session(db.get("SELECT * FROM users WHERE id=?", u.id));
  });
  /* ---------- the owner manages helper accounts ---------- */
  const staffOut = st => { const u = db.get("SELECT name, totp_on FROM users WHERE id=?", st.user_id); return { id: st.user_id, login: st.login, name: u?.name || "", role: st.role, disabled: !!st.disabled, must_change: !!st.must_change, env: !!st.from_env, mfa: !!u?.totp_on, created_at: st.created_at, last_login_at: st.last_login_at, note: st.note }; };
  r.get("/api/admin/staff", req => { needOwner(req); return { staff: db.all("SELECT * FROM staff ORDER BY from_env DESC, created_at").map(staffOut), phone_admins: cfg.admins.length, owner_env: !!cfg.owner.login }; });
  r.post("/api/admin/staff", async req => {
    const o = needOwner(req), b = await readJson(req);
    const login = String(b.login || "").trim(), name = str(b.name, 80);
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(login)) throw bad("bad_login_name", "Login: 3–64 letters, digits, . _ - @");
    if (db.get("SELECT 1 FROM staff WHERE lower(login)=lower(?)", login)) throw new HttpError(409, "login_taken", "This login is already used");
    if (db.all("SELECT 1 FROM staff WHERE from_env=0 AND disabled=0").length >= 20) throw bad("too_many_staff", "Up to 20 helper accounts");
    const id = "st_" + randomBytes(4).toString("hex"), pw = tempPassword(), now = Date.now();
    db.tx(() => {
      db.run("INSERT INTO users(id,phone,name,email,role,district,created_at) VALUES(?,NULL,?,'','staff','mirob',?)", id, name || login, now);
      db.run("INSERT INTO staff(user_id,login,pass_hash,role,must_change,created_by,created_at,note) VALUES(?,?,?,'admin',1,?,?,?)", id, login, hashPassword(pw), o.id, now, str(b.note, 200));
    });
    audit(req, "staff.create", id, { login });
    // the temporary password is shown once, to the owner, who passes it on; the helper must change it at the first sign-in
    return { staff: staffOut(db.get("SELECT * FROM staff WHERE user_id=?", id)), password: pw };
  });
  r.patch("/api/admin/staff/:id", async (req, res, p) => {
    const o = needOwner(req), b = await readJson(req), st = db.get("SELECT * FROM staff WHERE user_id=?", p.id);
    if (!st) throw new HttpError(404, "not_found", "No such account");
    if (st.from_env) throw new HttpError(409, "owner_env", "The owner's account is managed on the server (OWNER_LOGIN / `imorat owner`)");
    const out = {};
    if (b.name !== undefined) db.run("UPDATE users SET name=? WHERE id=?", str(b.name, 80) || st.login, st.user_id);
    if (b.note !== undefined) db.run("UPDATE staff SET note=? WHERE user_id=?", str(b.note, 200), st.user_id);
    if (b.disabled !== undefined) { db.run("UPDATE staff SET disabled=? WHERE user_id=?", b.disabled ? 1 : 0, st.user_id); if (b.disabled) db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", st.user_id); audit(req, b.disabled ? "staff.disable" : "staff.enable", st.user_id); }
    if (b.reset_password) { const pw = tempPassword(); db.run("UPDATE staff SET pass_hash=?, must_change=1 WHERE user_id=?", hashPassword(pw), st.user_id); db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", st.user_id); out.password = pw; audit(req, "staff.reset_password", st.user_id); }
    if (b.reset_mfa) { db.run("UPDATE users SET totp_secret=NULL, totp_on=0, totp_last=NULL, token_ver=token_ver+1 WHERE id=?", st.user_id); audit(req, "staff.reset_mfa", st.user_id); }
    void o;
    return { staff: staffOut(db.get("SELECT * FROM staff WHERE user_id=?", st.user_id)), ...out };
  });
  r.post("/api/auth/google", async req => { const b = await readJson(req); return social(req, "google", b.credential, b.name); });
  r.post("/api/auth/apple", async req => { const b = await readJson(req); return social(req, "apple", b.id_token, b.name); });

  r.get("/api/me", req => ({ user: { ...publicUser(need(req), cfg.admins, staffOf(req.user)), telegram: !!req.user.tg_chat, mfa: !!req.user.totp_on }, store: req.user.store_id ? publicStore(db.get("SELECT * FROM stores WHERE id=?", req.user.store_id)) : null }));
  r.patch("/api/me", async req => {
    const u = need(req), b = await readJson(req);
    const name = b.name !== undefined ? str(b.name, 80) : u.name;
    if (b.name !== undefined && name.length < 2) throw bad("bad_name", "Name is too short");
    const district = b.district !== undefined ? (isDistrict(b.district) ? b.district : null) : u.district;
    if (!district) throw bad("bad_district", "Unknown district");
    let role = u.role;
    if (b.role !== undefined) {
      if (!["buyer", "pro"].includes(b.role)) throw bad("bad_role", "Role must be buyer or pro; stores register via /api/seller/store");
      if (staffOf(u)) throw new HttpError(409, "staff_account", "A staff account has no buyer or pro role — sign in by phone for shopping");
      if (u.role !== "seller") role = b.role;
    }
    const email = b.email !== undefined ? str(b.email, 120) : u.email;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("bad_email", "Invalid e-mail");
    db.run("UPDATE users SET name=?, district=?, role=?, email=? WHERE id=?", name, district, role, email, u.id);
    return { user: publicUser(db.get("SELECT * FROM users WHERE id=?", u.id), cfg.admins, staffOf(u)) };
  });
  /* The VIP plan was dropped (owner's decision): nobody can turn it on, and the quote gives no VIP benefits. Old app builds that still
     send "off" get a plain answer; users.vip stays in the schema but nothing reads it. */
  r.post("/api/me/vip", async req => {
    const u = need(req), b = await readJson(req);
    if (b.on) throw new HttpError(410, "vip_removed", "The VIP plan is no longer offered");
    db.run("UPDATE users SET vip=0 WHERE id=?", u.id);
    return { user: publicUser(db.get("SELECT * FROM users WHERE id=?", u.id), cfg.admins, staffOf(u)) };
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
    // upd = when the seller last touched this price/stock or confirmed the whole list ("prices are current"), whichever is later;
    // the site shows it to the buyer and warns when it is old. Seconds, so the ETag does not change on every millisecond.
    const offers = db.all("SELECT o.product_id, o.store_id, o.price, o.stock, MAX(COALESCE(o.updated_at,0), COALESCE(s.prices_confirmed_at,0)) upd FROM offers o JOIN stores s ON s.id=o.store_id AND s.status='active' ORDER BY o.product_id, o.price");
    const by = new Map();
    for (const o of offers) { const a = by.get(o.product_id) || []; a.push({ store: o.store_id, price: o.price, stock: o.stock, upd: o.upd ? Math.floor(o.upd / 1000) : 0 }); by.set(o.product_id, a); }
    const products = db.all("SELECT * FROM products WHERE active=1 AND (review IS NULL OR review='ok') ORDER BY id").filter(p => by.has(p.id)).map(p => ({
      id: p.id, cat: p.cat, sub: p.sub, icon: p.icon, ru: p.ru, uz: p.uz, unit: p.unit, kg: p.kg, img: mediaUrl(p.img), group: p.grp, hit: !!p.hit, isNew: !!p.is_new,
      key: p.key, rating: p.rating, reviews: p.reviews, country: JSON.parse(p.country), warranty: p.warranty, desc: p.descr, offers: by.get(p.id),
      dims: dimsOf(ref, p), // package size [l,w,h] m (the seller's or typical for the subcategory); long goods need a cargo van whatever they weigh
      m3d: model3d.catalogUrl(p) // the AI 3D model the seller chose to show (model3d.js)
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
    name: str(f?.name, 80), phone: str(f?.phone, 30), district: isDistrict(f?.district) ? f.district : "mirob", street: str(f?.street, 160), flat: str(f?.flat, 30),
    entrance: str(f?.entrance, 20), intercom: str(f?.intercom, 30), private: !!f?.private, // full address for the Yandex courier: porch, intercom code, or a private house
    floor: String(int(f?.floor, 1, 60) || 1), help: f?.help === "none" ? "none" : f?.help || f?.lift ? "one" : "none", lift: f?.help ? f.help !== "none" : !!f?.lift, mode: f?.mode === "pickup" ? "pickup" : "yandex",
    access: f?.access === "far" ? "far" : "door", elevator: f?.elevator === true || f?.elevator === "true" ? true : f?.elevator === false || f?.elevator === "false" ? false : null, // can the car reach the entrance; is there a lift (null = not asked)
    when: ["asap", "slot", "vip"].includes(f?.when) ? f.when : "asap", hour: String(int(f?.hour, 8, 20) ?? 9).padStart(2, "0"),
    pay: ["click", "payme", "uzum", "nasiya", "cash", "store"].includes(f?.pay) ? f.pay : "store", comment: str(f?.comment, 300),
    la: Number.isFinite(Number(f?.la)) && f?.la !== null && f?.la !== "" && Math.abs(Number(f.la)) <= 90 ? Number(f.la) : null, lo: Number.isFinite(Number(f?.lo)) && f?.lo !== null && f?.lo !== "" && Math.abs(Number(f.lo)) <= 180 ? Number(f.lo) : null
  });
  async function computeQuote(req, b) {
    const user = req.user;
    const form = cleanForm(b.form || {});
    const { lines, problems } = loadLines(db, ref, b.lines, user, { tiers: cfg.discounts });
    const yp = await yandexPrices(db, ref, cfg.yandex, lines, form, log);
    const q = quote(db, ref, { lines, services: b.services || [], bundles: b.bundles || [], form, promo: b.promo, user, yandexPrices: yp, points: cfg.bonus.enabled ? b.points : 0, maxShare: cfg.bonus.maxShare, bonusOn: cfg.bonus.enabled, discounts: cfg.discounts, storeDelivery: cfg.deliveryBy === "store" });
    return { q, form, lines, problems };
  }
  r.post("/api/quote", async req => { lim.hit("quote-ip:" + req.ip, 120, 60_000); const b = await readJson(req); const { q, problems } = await computeQuote(req, b); return { quote: q, problems }; });

  r.post("/api/orders", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("order:" + u.id, 30, 3600_000);
    // goods are held for an unpaid order: one account keeps at most 3 such orders open (no buying up a product's whole stock)
    if (db.get("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='active' AND pay_status='pending' AND created_at>?", u.id, Date.now() - 90 * 60000).n >= 3) throw new HttpError(429, "too_many_open", "Pay for or cancel your open orders first");
    const { q, form, lines, problems } = await computeQuote(req, b);
    assertNoProblems(problems);
    if (q.unknown) throw new HttpError(503, "delivery_price_unavailable", "The carrier did not return a delivery price for this address — try again in a minute or choose pickup", { quote: q });
    const phone = form.phone.replace(/\D/g, "");
    if (!/^998\d{9}$/.test(phone)) throw bad("bad_phone", "Recipient phone must be +998 XX XXX XX XX");
    if (form.mode !== "pickup" && form.street.length < 4) throw bad("bad_address", "Street and house are required for delivery");
    // Every order is paid by card on the site (one amount for goods and delivery; the courier and the store take no money).
    if (["store", "cash"].includes(form.pay)) {
      if (!cfg.allowPayAtStore) throw cfg.paymentsOnline.length ? bad("card_required", "Orders are paid by card on the site") : new HttpError(503, "payments_off", "Online payment is not connected yet — ordering opens in a few days");
      if (form.mode !== "pickup" && cfg.paymentsOnline.length) throw bad("card_required", "Delivery orders are paid by card on the site; cash is for pickup only");
    } else if (!cfg.paymentsOnline.includes(form.pay)) throw cfg.paymentsOnline.length ? bad("payment_unavailable", "This payment method is not available") : new HttpError(503, "payments_off", "Online payment is not connected yet — ordering opens in a few days");
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
        "tmp-" + randomBytes(6).toString("hex"), u.id, now, form.pay, ["cash", "store"].includes(form.pay) ? "to_store" : "pending", JSON.stringify({ ...form, lang: String(b.lang || "ru").slice(0, 2), ...(b.app === true ? { app: true } : {}), ...(q.delivery_by === "store" ? { delivery_by: "store" } : {}) }),
        q.goods, q.del ?? 0, q.svc, q.disc, q.pd, q.total, q.cash, q.promo, JSON.stringify(q.services), q.pts || 0);
      const id = Number(ins.lastInsertRowid), num = "QG-" + (100000 + id); // order numbers start with QG (Quriliş Go); older IM- numbers stay valid everywhere they are looked up
      if (q.pts) db.run("INSERT INTO points_log(user_id,delta,reason,ref,created_at) VALUES(?,?,?,?,?)", u.id, -q.pts, "spent", "order:" + id, now);
      db.run("UPDATE orders SET num=? WHERE id=?", num, id);
      for (const s of q.ships) {
        const goods = s.lines.reduce((a, l) => a + l.price * l.q, 0), st = db.get("SELECT hours, free_until FROM stores WHERE id=?", s.store);
        // commission and the acquiring fee only on orders paid through the platform; a reservation paid at the store is free for the store.
        // During a store's free months Quriliş Go's own commission is 0, the bank's fee on the card payment stays.
        const commission = online && !inPromo(st, now) ? s.lines.reduce((a, l) => a + Math.round(l.price * l.q * rateOf(PCAT.get(l.id) || db.get("SELECT cat FROM products WHERE id=?", l.id)?.cat)), 0) : 0;
        const acquiring = online ? Math.round(goods * cfg.acquiringOf(form.pay)) : 0; // the contract rate of the provider the buyer pays through
        const start = storeStartAt(st, now);
        const st0 = online ? "unpaid" : "new";
        db.run("INSERT INTO shipments(order_id,store_id,tariff,price,kg,dist,lines,status,status_at,history,goods,commission,acquiring,start_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id, s.store, s.tariff, s.price ?? 0, s.kg, s.dist, JSON.stringify(s.lines), st0, now, JSON.stringify([{ s: st0, t: now }]), goods, commission, acquiring, start); // price 0 = "agreed with the store" when the store delivers (form.delivery_by)
      }
      // the promo use is claimed inside the transaction: two orders racing with the same code cannot both get the discount
      if (q.promo && !db.run("INSERT OR IGNORE INTO promo_uses(user_id,code,order_id) VALUES(?,?,?)", u.id, q.promo, id).changes) throw new HttpError(409, "total_changed", "The promo code has just been used, check the new total", { quote: { ...q, pd: 0, promo: null, total: q.total + q.pd } });
      return num;
    });
    bumpCatalog();
    log.info(`[order] ${order} by ${u.id}: ${q.total} so'm, ${q.ships.length} shipment(s)`);
    if (!online) { for (const sh of db.all("SELECT id FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", order)) notify.shipmentNew(sh.id); setImmediate(() => notify.orderPlaced(db.get("SELECT id FROM orders WHERE num=?", order).id)); }
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
    const ships = db.all("SELECT sh.*, st.name store_name, st.addr store_addr, st.hours store_hours FROM shipments sh LEFT JOIN stores st ON st.id=sh.store_id WHERE sh.order_id=? ORDER BY sh.id", o.id).filter(s => !forStore || s.store_id === forStore);
    return {
      num: o.num, t: o.created_at, status: o.status, pay: o.pay, pay_status: o.pay_status, d: JSON.parse(o.form),
      goods: o.goods, del: o.del, svc: o.svc, disc: o.disc + o.promo_disc, bdisc: o.disc, pd: o.promo_disc, pts: o.points_used || 0, total: o.total, cash: o.cash, promo: o.promo,
      paid_at: o.paid_at || null, pay_url: o.pay_status === "pending" && !["store", "cash"].includes(o.pay) && o.status !== "cancelled" ? payments.payUrl(o) : null,
      pay_deadline: o.pay_status === "pending" && !["store", "cash"].includes(o.pay) ? o.created_at + cfg.payTimeoutMin * 60000 : null,
      // store delivery: the price the store named (null until it does) and what the buyer pays on receipt for the whole order
      del_store: ships.some(s => s.price_named_at) ? ships.reduce((a, s) => a + (s.price_named_at ? s.price : 0), 0) : null,
      ships: ships.map(s => ({ id: s.id, store: s.store_id, store_name: s.store_name, store_addr: s.store_addr, store_hours: s.store_hours, tariff: s.tariff, tracking_url: s.tracking_url || null, delivery_price: s.price_named_at ? s.price : null, live: !!(s.claim_id && !String(s.claim_id).startsWith("sim-")), price: s.price, kg: s.kg, dist: s.dist, status: s.status, status_at: s.status_at,
        step: (STEPS[flowOf(s, JSON.parse(o.form))].indexOf(s.status)), history: JSON.parse(s.history), lines: JSON.parse(s.lines), courier: s.courier,
        cancel_reason: s.cancel_reason, cancel_note: s.cancel_note || null, accept_by: s.status === "new" ? (s.start_at || s.status_at) + cfg.timers.cancel * 60000 : null,
        loaders_failed: !!s.loaders_failed, // the carrier refused the loader: the buyer meets the car at the entrance (see notify.loadersFailed)
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
  /* the buyer cancels while nothing has left the stores; the reason and a comment go to the store with the cancellation */
  const BUYER_WHY = { changed: "передумал", cheaper: "нашёл дешевле", wrong: "ошибся в заказе", long: "долго ждать", delivery: "не устраивает доставка", other: "другое" };
  r.post("/api/orders/:num/cancel", async (req, res, p) => {
    const u = need(req), b = await readJson(req).catch(() => ({}));
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const why = BUYER_WHY[b?.reason] ? b.reason : null, comment = str(b?.comment, 500);
    if (b?.reason !== undefined && !why) throw bad("bad_reason", "Unknown reason");
    if (why === "other" && comment.length < 3) throw bad("comment_required", "Tell the store why");
    const note = why === "other" ? comment : why ? BUYER_WHY[why] + (comment ? ": " + comment : "") : comment || null;
    if (!cancelOrder(o, "buyer", note)) throw new HttpError(409, "too_late", "The order is already on its way");
    return { order: orderOut(db.get("SELECT * FROM orders WHERE id=?", o.id)) };
  });
  /* Cancels a whole order while nothing has left the stores: stock back, points back (via setShipStatus), promo freed. False once a shipment is on its way. */
  function cancelOrder(o, reason, note = null) {
    if (o.status === "cancelled") return false; // cancelling twice must not run the side effects (promo use, points) again
    const ships = db.all("SELECT * FROM shipments WHERE order_id=?", o.id);
    if (ships.some(s => !["unpaid", "new", "assembling", "cancelled"].includes(s.status))) return false;
    db.tx(() => {
      for (const s of ships) {
        if (s.status === "cancelled") continue;
        for (const l of JSON.parse(s.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, s.store_id);
        if (note) db.run("UPDATE shipments SET cancel_note=? WHERE id=?", note, s.id); // before the status: the store's message carries it
        setShipStatus(s, "cancelled", reason);
      }
      db.run("UPDATE orders SET status='cancelled' WHERE id=?", o.id);
      if (o.promo) db.run("DELETE FROM promo_uses WHERE user_id=? AND code=? AND order_id=?", o.user_id, o.promo, o.id); // only this order's use comes back
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
    // a courier already ordered for this shipment is called off (a paid cancellation is reported to the admins)
    if (status === "cancelled" && s.claim_id && !String(s.claim_id).startsWith("sim-")) courier.cancel(s).then(r => { if (r?.cancel_state === "paid") notify.admins(`🚚 Отправление #${s.id} отменено после выезда курьера Яндекса — отмена платная (${r.cancel_state}).`); }).catch(e => { log.warn("[courier] cancel", e.message); notify.admins(`🚚 Не удалось отменить заявку Яндекса для отправления #${s.id}: ${String(e.message).replace(/[<>&]/g, "")}. Отмените её вручную в кабинете Яндекс Доставки.`); });
    const all = db.all("SELECT status FROM shipments WHERE order_id=?", s.order_id).map(x => x.status);
    const st = all.every(x => x === "cancelled") ? "cancelled" : all.every(x => ["delivered", "picked", "cancelled"].includes(x)) ? "done" : "active";
    db.run("UPDATE orders SET status=? WHERE id=?", st, s.order_id);
    if (status === "delivered" || status === "picked") bonus.shipDone({ ...s, status });
    if (st === "cancelled") bonus.orderCancelled(s.order_id);
    else if (status === "cancelled") bonus.shipCancelled(s); // the rest of the order goes on: this part's points come back
    // a card-paid shipment the store failed (or the buyer cancelled in time): the money must go back — flagged for the admin until refunds are automated
    if (status === "cancelled" && reason !== "refund") {
      const o = db.get("SELECT * FROM orders WHERE id=?", s.order_id);
      if (o && ["paid", "refund_due"].includes(o.pay_status) && !["store", "cash"].includes(o.pay)) { // refund_due: a second part of the same paid order is cancelled → one more refund
        // the buyer paid for this part its goods minus its share of the promo discount and of the points, plus its delivery
        const goods = JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0), share = o.goods ? goods / o.goods : 1;
        const part = Math.max(0, Math.round(goods - (o.promo_disc || 0) * share - (o.points_used || 0) * share + (s.price || 0)));
        db.run("UPDATE orders SET pay_status='refund_due' WHERE id=?", o.id);
        notify.owners(`💳 Возврат по заказу ${o.num}: ${part.toLocaleString("ru-RU")} сум (${o.pay}) — отправление отменено (${reason || "—"}). Сделайте возврат в кабинете ${o.pay === "payme" ? "Payme" : "Click"}.`);
      }
    }
  }

  /* ---------- AI ---------- */
  r.post("/api/ai/chat", async (req, res) => {
    const u = req.user;
    const day = new Date().toISOString().slice(0, 10);
    // the limits come first, then the body is read (a guest's body is smaller: one compressed photo, shorter texts)
    if (u) lim.hit(`ai:${u.id}:${day}`, cfg.ai.dailyUser, 86400_000); else lim.hit(`ai-ip:${req.ip}:${day}`, cfg.ai.dailyGuest, 86400_000);
    lim.hit("ai-min:" + (u?.id || req.ip), 8, 60_000);
    const b = await readJson(req, (u ? 7 : 2) * 1024 * 1024);
    await streamChat(cfg.ai, buildRequest(db, ref, cfg.ai, b, u, { discounts: cfg.discounts }), res, log);
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
    if (has("payout_to")) out.payout_to = str(b.payout_to, 120); // card number or bank account for payouts
    if (!partial || has("addr")) { out.addr = str(b.addr, 200); if (out.addr.length < 3) throw bad("bad_addr", "Address is required"); }
    if (has("la") || has("lo") || !partial) {
      const la = b.la === null || b.la === undefined || b.la === "" ? null : Number(b.la), lo = b.lo === null || b.lo === undefined || b.lo === "" ? null : Number(b.lo);
      if ((la === null) !== (lo === null)) throw bad("bad_location", "Both latitude and longitude are needed");
      if (la !== null && !(la > 37 && la < 46 && lo > 55 && lo < 74)) throw bad("bad_location", "The location must be in Uzbekistan");
      out.la = la; out.lo = lo; out.loc_src = la === null ? "district" : b.loc_src === "gps" ? "gps" : "map";
    }
    if (!partial || has("district")) {
      let d = isDistrict(b.district) ? b.district : null;
      if (!d && out.la != null) d = ref.districts.reduce((best, x) => ((x.la - out.la) ** 2 + (x.lo - out.lo) ** 2 < (best.la - out.la) ** 2 + (best.lo - out.lo) ** 2 ? x : best)).id;
      if (!d) throw bad("bad_district", "Choose the district");
      out.district = d;
    }
    if (out.la === null && out.district) { out.la = D[out.district].la; out.lo = D[out.district].lo; }
    for (const k of ["name", "descr", "addr", "hours", "landmark", "telegram", "payout_to"]) if (typeof out[k] === "string") out[k] = out[k].replace(/[<>]/g, ""); // shown in every buyer's browser, the panel and Telegram: no markup at all (the client escapes too)
    return out;
  }

  r.post("/api/seller/store", async req => {
    const u = need(req), b = await readJson(req);
    if (u.store_id) throw new HttpError(409, "store_exists", "You already have a store; edit it in the cabinet");
    if (staffOf(u)) throw new HttpError(409, "staff_account", "A staff account cannot own a store — sign in by phone to register one");
    const s = storeInput(b);
    const base = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "store";
    let id = base + "-" + randomBytes(2).toString("hex");
    for (let n = 0; db.get("SELECT 1 FROM stores WHERE id=?", id) && n < 10; n++) id = base + "-" + randomBytes(n < 5 ? 2 : 4).toString("hex"); // a popular name never collides into a 500
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
  /* the card or account for payouts: a changed one needs the account password (a stolen session alone cannot redirect the money),
     and the store owner is told by Telegram and SMS, the owners of the platform by Telegram; the audit log keeps both ends masked */
  const maskTo = t => { const d = String(t || "").replace(/\s+/g, ""); return d ? "…" + d.slice(-4) : "—"; };
  async function payoutChange(req, u, s, to, b) {
    if ((to || "") === (s.payout_to || "")) return;
    lim.hit("payoutchg:" + u.id, 5, 3600_000);
    if (u.pw_hash) { if (!verifyPassword(typeof b.current === "string" ? b.current : "", u.pw_hash)) throw new HttpError(403, "bad_current", "Enter your account password to change the payout details"); }
    else if (s.payout_to) throw new HttpError(403, "need_password", "Set a password in your profile first — it is needed to change the payout details");
    audit(req, "payout.change", s.id, { from: maskTo(s.payout_to), to: maskTo(to) });
    const msg = `Quriliş Go: реквизиты для выплат магазина «${String(s.name).replace(/[<>&]/g, "")}» изменены на ${maskTo(to)}. Если это были не вы — сразу напишите в поддержку.`;
    const ow = db.get("SELECT tg_chat FROM users WHERE id=?", s.owner_id); if (ow?.tg_chat) tg.send(ow.tg_chat, msg);
    if (s.phone) sms.sendText(s.phone, msg).catch(() => {});
    notify.owners(`🔐 Реквизиты выплат изменены: ${String(s.name).replace(/[<>&]/g, "")} ${maskTo(s.payout_to)} → ${maskTo(to)}.`);
  }
  r.patch("/api/seller/store", async req => {
    const { s, u } = needSeller(req), b = await readJson(req);
    const x = storeInput(b, true);
    if (x.payout_to !== undefined) await payoutChange(req, u, s, x.payout_to, b);
    const cols = Object.keys(x); if (!cols.length) return { store: publicStore(s) };
    const vals = cols.map(k => (k === "cats" ? JSON.stringify(x[k]) : x[k]));
    db.run(`UPDATE stores SET ${cols.map(c => c + "=?").join(",")} WHERE id=?`, ...vals, s.id);
    if (x.descr) db.run("UPDATE stores SET ru=?, uz=? WHERE id=?", x.descr.slice(0, 80), x.descr.slice(0, 80), s.id);
    if (x.addr) db.run("UPDATE stores SET addr_uz=? WHERE id=?", x.addr, s.id);
    // an open store changed what buyers read about it: logged and sent to the moderators to look at (post-moderation)
    const shown = ["name", "descr", "addr", "phone", "telegram"].filter(k => x[k] !== undefined && String(x[k]) !== String(s[k] ?? ""));
    if (s.status === "active" && shown.length) {
      audit(req, "store.edit", s.id, Object.fromEntries(shown.map(k => [k, String(x[k]).slice(0, 120)])));
      notify.owners(`✏️ Магазин «${String(s.name).replace(/[<>&]/g, "")}» изменил: ${shown.join(", ")}${x.name ? ` → «${x.name.replace(/[<>&]/g, "")}»` : ""}. Проверьте в админке.`);
    }
    bumpCatalog();
    return { store: ownerStore(db.get("SELECT * FROM stores WHERE id=?", s.id)) };
  });

  r.get("/api/seller/summary", req => {
    const { s } = needSeller(req);
    const since = Date.now() - 30 * 86400_000;
    const ships = db.all("SELECT sh.*, o.num, o.form, o.created_at oc, o.pay, o.pay_status FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND sh.status<>'unpaid' ORDER BY sh.id DESC LIMIT 100", s.id);
    const revenue = ships.filter(x => x.oc >= since && x.status !== "cancelled").reduce((a, x) => a + JSON.parse(x.lines).reduce((b, l) => b + l.price * l.q, 0), 0);
    const products = db.all(`SELECT p.id,p.ru,p.uz,p.cat,p.sub,p.unit,p.kg,p.img,p.active,p.store_id,p.review,p.review_note,p.m3d,p.m3d_state,p.m3d_err,p.m3d_at,p.img_orig,p.cut_img,p.cut_state,p.cut_err,p.cut_warn, o.price,o.stock FROM offers o JOIN products p ON p.id=o.product_id WHERE o.store_id=? ORDER BY p.id`, s.id)
      .map(({ m3d, m3d_state, m3d_err, m3d_at, img_orig, cut_img, cut_state, cut_err, cut_warn, ...p }) => ({ ...p, img: mediaUrl(p.img), own: p.store_id === s.id, model3d: p.store_id === s.id ? model3d.out({ id: p.id, m3d, m3d_state, m3d_err, m3d_at }) : undefined,
        cutout: p.store_id === s.id ? model3d.outCut({ id: p.id, img: p.img, img_orig, cut_img, cut_state, cut_err, cut_warn }) : undefined }));
    return {
      store: ownerStore(s),
      kpi: { revenue30: revenue, orders30: ships.filter(x => x.oc >= since).length, open: ships.filter(x => !["delivered", "picked", "cancelled"].includes(x.status)).length, products: products.length, out_of_stock: products.filter(p => p.stock <= 0).length },
      finance: storeFinance(s.id),
      rates: storeRates(s),
      prices: pricesFreshness(s),
      telegram: !!req.user.tg_chat, bot: tg.enabled ? tg.username : null,
      rating: storeStats()[s.id] || null,
      reviews: db.all("SELECT r.ship_id, r.stars, r.text, r.reply, r.created_at, u.name FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.store_id=? ORDER BY r.created_at DESC LIMIT 20", s.id).map(x => ({ ...x, name: (x.name || "").split(" ")[0] })),
      orders: ships.map(x => {
        const f = JSON.parse(x.form);
        return { ship_id: x.id, num: x.num, t: x.oc, status: x.status, tariff: x.tariff, price: x.price, kg: x.kg, pay: x.pay, pay_status: x.pay_status,
          buyer: f.name, phone: f.phone, district: f.district, street: f.mode === "pickup" ? "" : f.street, floor: f.private ? null : f.floor, entrance: f.entrance || "", private: !!f.private, help: f.help || (f.lift ? "one" : "none"), access: f.access || "door", elevator: f.elevator ?? null, loaders_failed: !!x.loaders_failed, when: f.when, hour: f.hour, comment: f.comment, lines: JSON.parse(x.lines),
          cancel_reason: x.cancel_reason, cancel_note: x.cancel_note || null, accept_by: x.status === "new" ? (x.start_at || x.status_at) + cfg.timers.cancel * 60000 : null, commission: x.commission, acquiring: x.acquiring,
          delivery_by: x.tariff ? (f.delivery_by === "store" ? "store" : "yandex") : null, // who delivers: the store's own courier (stage 0) or Yandex
          delivery_price: x.price_named_at ? x.price : null, // the price the store named to the buyer (store delivery), null until it does
          next: SELLER_MOVES[x.status]?.filter(n => (x.tariff ? n !== "ready" && (f.delivery_by === "store" ? n !== "searching" : !(n === "on_way" && x.status === "assembling")) : !["searching", "on_way"].includes(n))) || [] };
      }),
      products
    };
  });
  /* "Prices and stock are current": stamps the whole list, so buyers see a fresh confirmation date on every offer of the store */
  r.post("/api/seller/offers/confirm", req => {
    const { s } = needSeller(req), now = Date.now();
    db.run("UPDATE stores SET prices_confirmed_at=? WHERE id=?", now, s.id); bumpCatalog(); audit(req, "offers.confirm", s.id);
    return { prices_confirmed_at: now };
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
    if (!db.get("SELECT 1 FROM products WHERE id=? AND active=1 AND (store_id IS NULL OR store_id=?)", pid, s.id)) throw new HttpError(404, "not_found", "Product not found"); // catalog products or the store's own
    db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id,store_id) DO UPDATE SET price=excluded.price, stock=excluded.stock, updated_at=excluded.updated_at", pid, s.id, price, stock, Date.now());
    bumpCatalog();
    return { offer: { product_id: pid, store: s.id, price, stock } };
  });
  r.post("/api/seller/import", async req => {
    // Price list import: many offers at once (matched in the browser) and new own products
    const { s } = needSeller(req), b = await readJson(req, 1024 * 1024);
    lim.hit("import:" + s.id, 20, 86400_000);
    const isObj = x => x && typeof x === "object";
    const rows = Array.isArray(b.offers) ? b.offers.filter(isObj).slice(0, 2000) : [], create = Array.isArray(b.create) ? b.create.filter(isObj).slice(0, 300) : [];
    if (create.length) lim.hit("prod-new:" + s.id, 500, 86400_000, create.length);
    const bad1 = [];
    const ok = rows.map((x, i) => ({ i, pid: int(x.product_id, 1, 1e9), price: int(x.price, 100, 1e8), stock: x.stock === undefined || x.stock === null || x.stock === "" ? null : int(x.stock, 0, 1e7) }))
      .filter(x => { const good = x.pid && x.price && db.get("SELECT 1 FROM products WHERE id=? AND active=1 AND (store_id IS NULL OR store_id=?)", x.pid, s.id); if (!good) bad1.push(x.i); return good; }); // another store's own product cannot be listed
    const mk = create.map((x, i) => {
      const ru = str(x.ru, 140), c = ref.cats.find(k => k.id === x.cat), price = int(x.price, 100, 1e8), kg = Number(x.kg) > 0 && Number(x.kg) <= 5000 ? Number(x.kg) : 1;
      return ru.length >= 3 && c && c.subs.some(k => k[0] === x.sub) && price ? { ru, uz: str(x.uz, 140) || ru, c, sub: x.sub, unit: subUnit(c.id, x.sub, x.unit), price, kg, stock: int(x.stock ?? 0, 0, 1e7) ?? 0, dims: dimsFrom(x) } : (bad1.push("n" + i), null);
    }).filter(Boolean);
    let updated = 0, added = 0, created = 0;
    const newIds = [];
    db.tx(() => {
      const now = Date.now();
      for (const x of ok) {
        const had = db.get("SELECT stock FROM offers WHERE product_id=? AND store_id=?", x.pid, s.id);
        if (had) { db.run("UPDATE offers SET price=?, stock=?, updated_at=? WHERE product_id=? AND store_id=?", x.price, x.stock ?? had.stock, now, x.pid, s.id); updated++; }
        else { db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", x.pid, s.id, x.price, x.stock ?? 10, now); added++; }
      }
      for (const x of mk) {
        const nid = Math.max(10000, (db.get("SELECT MAX(id) m FROM products")?.m || 0) + 1);
        db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,hit,is_new,rating,reviews,country,warranty,descr,store_id,active,created_at,dims)
          VALUES(?,?,?,?,?,?,?,?,'',0,1,0,0,?,0,'',?,1,?,?)`, nid, x.c.id, x.sub, subIcon(x.c.id, x.sub), x.ru, x.uz, x.unit, x.kg, JSON.stringify(["Узбекистан", "O‘zbekiston"]), s.id, now, x.dims);
        if (!cfg.productAutoApprove) db.run("UPDATE products SET review='pending' WHERE id=?", nid); newIds.push(nid);
        db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", nid, s.id, x.price, x.stock, now);
        created++;
      }
    });
    if (updated + added + created) bumpCatalog();
    if (!cfg.productAutoApprove) moderation.productsAdded(s.id, newIds);
    audit(req, "seller.import", s.id, { updated, added, created, skipped: bad1.length });
    return { updated, added, created, skipped: bad1.length };
  });
  /* package size given by the seller in centimetres ([length, width, height] or len_cm/wid_cm/hgt_cm) → metres, or null */
  /* package size in cm → metres. The length alone is enough (it decides the vehicle); width and height default to 10 cm.
     Values outside 1–1500 cm, or no length at all, mean "not given" — the catalogue's category size is used then. */
  const dimsFrom = b => {
    const a = Array.isArray(b?.dims_cm) ? b.dims_cm.slice(0, 3) : [b?.len_cm, b?.wid_cm, b?.hgt_cm];
    const ok = x => Number.isFinite(Number(x)) && Number(x) >= 1 && Number(x) <= 1500;
    if (!ok(a[0])) return null;
    const n = [Number(a[0]), ok(a[1]) ? Number(a[1]) : 10, ok(a[2]) ? Number(a[2]) : 10];
    return JSON.stringify(n.map(x => Math.round(x) / 100));
  };
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
    // "the same product as before": its photo and 3D model are copied instead of a new photo (model3d.js, look library)
    const src = b.from != null ? model3d.lookSource(b.from, s.id) : null;
    if (b.from != null && !src) throw bad("bad_source", "That product's photo and model cannot be reused");
    const id = db.tx(() => {
      const nid = Math.max(10000, (db.get("SELECT MAX(id) m FROM products")?.m || 0) + 1);
      db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,hit,is_new,rating,reviews,country,warranty,descr,store_id,active,created_at,dims)
        VALUES(?,?,?,?,?,?,?,?,'',0,1,0,0,?,?,?,?,1,?,?)`, nid, cat, sub, subIcon(cat, sub), ru, uz, unit, kg, JSON.stringify(["Узбекистан", "O‘zbekiston"]), int(b.warranty, 0, 120) || 0, str(b.desc, 1000), s.id, Date.now(), dimsFrom(b));
      db.run("INSERT INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", nid, s.id, price, stock, Date.now());
      if (!cfg.productAutoApprove) db.run("UPDATE products SET review='pending' WHERE id=?", nid);
      return nid;
    });
    bumpCatalog();
    if (!cfg.productAutoApprove) moderation.productsAdded(s.id, [id]);
    let look = {};
    if (src) { try { const np = model3d.copyLook(src, id); look = { img: mediaUrl(np.img), model3d: model3d.out(np) }; } catch (e) { log.warn(`[look] product ${id} from ${src.id}: ${e.message}`); } }
    return { product: { id, ru, uz, cat, sub, unit, kg, price, stock, review: cfg.productAutoApprove ? null : "pending" }, ...look };
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
    removeUpload(prod.img);
    db.run("UPDATE products SET img=? WHERE id=?", "/uploads/" + name, prod.id);
    bumpCatalog();
    // a new photo makes an existing 3D model wrong: it goes; the seller asks for a new one with «Создать 3D с помощью AI»
    model3d.photoChanged(prod);
    const fresh = db.get("SELECT * FROM products WHERE id=?", prod.id);
    return { img: mediaUrl("/uploads/" + name), model3d: model3d.out(fresh), cutout: model3d.outCut(fresh) };
  });
  r.patch("/api/seller/shipments/:id", async (req, res, p) => {
    const { u, s } = needSeller(req), b = await readJson(req);
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(p.id));
    if (!sh || (sh.store_id !== s.id && !adminOk(req))) throw new HttpError(404, "not_found", "Shipment not found");
    const fo = JSON.parse(db.get("SELECT form FROM orders WHERE id=?", sh.order_id)?.form || "{}"), byStore = sh.tariff && fo.delivery_by === "store";
    // the store names its delivery price (stage 0): kept on the shipment, shown to the buyer, paid to the store on receipt
    if (b.delivery_price !== undefined) {
      if (sh.store_id !== s.id) throw new HttpError(403, "forbidden", "Only the store that delivers names its price");
      if (!byStore) throw bad("not_store_delivery", "The delivery price is named by the store only when the store delivers");
      if (!["new", "assembling", "on_way"].includes(sh.status)) throw bad("bad_status", "The delivery price can be named until the order is handed over");
      const price = deliveryPriceOf(b.delivery_price); if (price === null) throw bad("bad_price", "Delivery price: 0 … 5 000 000 so'm");
      if (price !== (sh.price || 0) || !sh.price_named_at) { lim.hit("delprice:" + sh.id, 5, 3600_000); db.run("UPDATE shipments SET price=?, price_named_at=? WHERE id=?", price, Date.now(), sh.id); audit(req, "ship.delivery_price", sh.id, { price }); setImmediate(() => notify.deliveryPriced(sh.id)); }
      if (b.status === undefined) return { ok: true, delivery_price: price };
    }
    if (!(SELLER_MOVES[sh.status] || []).includes(b.status) || (b.status === "ready" && sh.tariff) || (b.status === "searching" && (!sh.tariff || byStore)) || (b.status === "on_way" && sh.status === "assembling" && !byStore)) throw bad("bad_status", `Cannot move from ${sh.status} to ${b.status}`);
    if (b.status === "cancelled" && b.note !== undefined) { const note = str(b.note, 300); if (note) db.run("UPDATE shipments SET cancel_note=? WHERE id=?", note, sh.id); } // which item is missing, what it can be replaced with
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
    if (status === "searching" && sh.tariff) courier.order(db.get("SELECT * FROM shipments WHERE id=?", sh.id)).then(r => { if (r?.loaders_failed) notify.loadersFailed(sh.id); }).catch(e => { log.warn("[courier] order", e.message); notify.admins(`🚚 Не удалось вызвать курьера Яндекса для отправления #${sh.id}: ${String(e.message).slice(0, 160).replace(/[<>&]/g, "")}`); });
    audit(req, "ship." + status, sh.id);
  }
  /* the buyer watches the courier: the live position from Yandex, or "unavailable" (real status, no invented coordinates) */
  r.get("/api/orders/:num/courier", async (req, res, p, url) => {
    const u = need(req), o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const sh = db.get("SELECT * FROM shipments WHERE order_id=? AND id=?", o.id, Number(url.searchParams.get("ship")) || db.get("SELECT id FROM shipments WHERE order_id=? AND tariff IS NOT NULL ORDER BY id LIMIT 1", o.id)?.id);
    if (!sh) throw new HttpError(404, "not_found", "Shipment not found");
    return { courier: await courier.position(sh) };
  });

  /* ---------- reviews ---------- */
  r.post("/api/orders/:num/review", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const sh = db.get("SELECT * FROM shipments WHERE id=? AND order_id=?", int(b.ship_id, 1, 1e12), o.id);
    if (!sh) throw new HttpError(404, "not_found", "Shipment not found");
    if (!["delivered", "picked"].includes(sh.status)) throw bad("too_early", "You can rate the store after you receive the order");
    const stars = int(b.stars, 1, 5); if (!stars) throw bad("bad_stars", "Rate from 1 to 5 stars");
    const rtext = str(b.text, 500);
    try { db.run("INSERT INTO reviews(ship_id,order_id,store_id,user_id,stars,text,created_at,mod) VALUES(?,?,?,?,?,?,?,?)", sh.id, o.id, sh.store_id, u.id, stars, rtext, Date.now(), rtext && !cfg.productAutoApprove ? "pending" : "ok"); }
    catch { throw new HttpError(409, "already_rated", "You have already rated this order"); }
    if (rtext && !cfg.productAutoApprove) moderation.reviewAdded("store", 0, rtext);
    const st = db.get("SELECT owner_id FROM stores WHERE id=?", sh.store_id), ow = st?.owner_id && db.get("SELECT tg_chat FROM users WHERE id=?", st.owner_id);
    if (ow?.tg_chat) tg.send(ow.tg_chat, `${"⭐".repeat(stars)} Новый отзыв к заказу ${o.num}${b.text ? `:\n«${str(b.text, 500).replace(/[<>&]/g, "")}»` : ""}`);
    return { ok: true };
  });
  r.get("/api/stores/:id/reviews", (req, res, p) => {
    const rows = db.all("SELECT r.stars, r.text, r.reply, r.created_at, u.name FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.store_id=? AND (r.mod IS NULL OR r.mod='ok') ORDER BY r.created_at DESC LIMIT 30", p.id);
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
  /* Delete my account (App Store 5.1.1(v) / Google Play user-data policy): personal data is wiped at once, the orders stay
     anonymised for the stores' accounting and tax records. A store owner must first hand over or finish open orders and
     withdraw the balance; the store itself is hidden and left without an owner. */
  r.del("/api/me", async req => {
    const u = need(req), b = await readJson(req).catch(() => ({}));
    if (b.confirm !== true) throw bad("confirm", "Send {\"confirm\": true} to delete the account");
    if (staffOf(u)) throw new HttpError(409, "staff_account", "A staff account is disabled by the owner from the panel, not deleted here");
    if (db.get("SELECT COUNT(*) n FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE o.user_id=? AND sh.status NOT IN ('delivered','picked','cancelled')", u.id).n) throw new HttpError(409, "active_orders", "Finish or cancel your active orders first");
    const st = u.store_id ? db.get("SELECT * FROM stores WHERE id=?", u.store_id) : null;
    if (st && st.owner_id === u.id) {
      if (db.get("SELECT COUNT(*) n FROM shipments WHERE store_id=? AND status NOT IN ('delivered','picked','cancelled','unpaid')", st.id).n) throw new HttpError(409, "store_orders", "The store still has open orders — finish them first");
      if (storeFinance(st.id).payout_available > 0) throw new HttpError(409, "payout_due", "Withdraw the store's balance first");
    }
    const stamp = Date.now();
    db.tx(() => {
      if (st && st.owner_id === u.id) db.run("UPDATE stores SET status='blocked', owner_id=NULL, review_note='owner deleted the account' WHERE id=?", st.id);
      db.run("UPDATE users SET phone=?, name='', email='', google_sub=NULL, apple_sub=NULL, tg_chat=NULL, district='mirob', token_ver=token_ver+1, ref_code=NULL, totp_secret=NULL, totp_on=0, store_id=NULL, role='buyer', vip=0, points=0, deleted_at=? WHERE id=?", `deleted:${stamp}:${u.id}`, stamp, u.id);
      db.run("DELETE FROM push_subs WHERE user_id=?", u.id); db.run("DELETE FROM devices WHERE user_id=?", u.id);
      if (u.phone) db.run("DELETE FROM otp WHERE phone=?", u.phone);
      db.run("UPDATE masters SET status='deleted', phone=NULL, about='', name='' WHERE user_id=?", u.id);
      db.run("DELETE FROM team_members WHERE user_id=?", u.id);
      for (const o of db.all("SELECT id, form FROM orders WHERE user_id=?", u.id)) {
        const f = JSON.parse(o.form || "{}");
        for (const k of ["name", "phone", "street", "flat", "entrance", "intercom", "comment", "landmark"]) if (k in f) f[k] = "";
        for (const k of ["la", "lo"]) if (k in f) f[k] = null;
        f.deleted = true; db.run("UPDATE orders SET form=? WHERE id=?", JSON.stringify(f), o.id);
      }
    });
    audit(req, "account.delete", u.id);
    log.info(`[account] ${u.id} deleted by its owner`);
    return { ok: true };
  });
  r.del("/api/me/telegram", req => { const u = need(req); db.run("UPDATE users SET tg_chat=NULL WHERE id=?", u.id); return { ok: true }; });
  r.post("/api/push/subscribe", async req => {
    const u = need(req), b = await readJson(req);
    const ep = str(b.endpoint, 1000), p256 = str(b.keys?.p256dh, 200), au = str(b.keys?.auth, 100);
    // only the browsers' own push services: the server POSTs to this address, so anything else would let it be aimed at other hosts
    let host = ""; try { const x = new URL(ep); host = x.protocol === "https:" && !x.port ? x.hostname.toLowerCase() : ""; } catch {}
    const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com|push\.yandex\.(ru|net))$/;
    if (!host || !PUSH_HOSTS.test(host) || !p256 || !au) throw bad("bad_subscription", "Invalid push subscription");
    db.run("INSERT INTO push_subs(endpoint,user_id,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth", ep, u.id, p256, au, Date.now());
    return { ok: true };
  });
  /* the Android / iPhone app registers its push token for the signed-in person (one row per install) */
  r.post("/api/me/devices", async req => {
    const u = need(req), b = await readJson(req);
    const platform = ["android", "ios"].includes(b.platform) ? b.platform : null, token = str(b.token, 4096);
    if (!platform || !token || token.length < 16) throw bad("bad_device", "platform (android|ios) and token are required");
    db.run("INSERT INTO devices(token,user_id,platform,lang,app_ver,created_at,seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, platform=excluded.platform, lang=excluded.lang, app_ver=excluded.app_ver, seen_at=excluded.seen_at",
      token, u.id, platform, ["ru", "uz", "en"].includes(b.lang) ? b.lang : "ru", str(b.app_ver, 40) || "", Date.now(), Date.now());
    return { ok: true, push: push.native[platform] };
  });
  r.del("/api/me/devices", async req => { const u = need(req), b = await readJson(req); db.run("DELETE FROM devices WHERE token=? AND user_id=?", str(b.token, 4096), u.id); return { ok: true }; });
  r.post("/api/push/unsubscribe", async req => { const u = need(req), b = await readJson(req); db.run("DELETE FROM push_subs WHERE endpoint=? AND user_id=?", str(b.endpoint, 1000), u.id); return { ok: true }; });
  r.post("/api/push/test", async req => { const u = need(req); const n = await push.toUser(u.id, { title: "Quriliş Go", body: "Уведомления работают ✅", url: cfg.siteUrl }); return { sent: n }; });
  r.post("/api/me/logout-all", req => {
    const u = need(req);
    db.run("UPDATE users SET token_ver=token_ver+1 WHERE id=?", u.id); db.run("DELETE FROM push_subs WHERE user_id=?", u.id); db.run("DELETE FROM devices WHERE user_id=?", u.id);
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
    const fo = JSON.parse(db.get("SELECT form FROM orders WHERE id=?", sh.order_id)?.form || "{}");
    const target = { acc: "assembling", oos: "cancelled", rdy: sh.tariff ? (fo.delivery_by === "store" ? "on_way" : "searching") : "ready", pick: "picked", dlv: "delivered" }[act];
    if (!target || !(SELLER_MOVES[sh.status] || []).includes(target)) { await tg.answer(q.id, "Статус уже изменён"); return notify.sellerRefresh(sh.id); }
    moveShipment(sh, target, { user: ow, ip: "telegram" });
    if (act === "acc" && sh.tariff && fo.delivery_by === "store" && !sh.price_named_at) setTimeout(() => bot.askDeliveryPrice(ow.tg_chat, sh.id), 600); // the store delivers: ask what it costs the buyer
    await tg.answer(q.id, { on_way: "Покупателю сообщили, что курьер выехал", delivered: "Доставлено — спасибо!", assembling: "Принято! Соберите заказ", cancelled: "Заказ отменён, товар скрыт из наличия", searching: "Вызываем курьера", ready: "Покупатель получит уведомление", picked: "Готово" }[target]);
  });

  /* ---------- finance: commission ledger and settlements ---------- */
  const monthRange = m => { const [y, mo] = (/^\d{4}-\d{2}$/.test(m || "") ? m : new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7)).split("-").map(Number); return [Date.UTC(y, mo - 1, 1) - 5 * 3600000, Date.UTC(y, mo, 1) - 5 * 3600000, `${y}-${String(mo).padStart(2, "0")}`]; };
  function storeFinance(storeId, m) {
    const [a, b, month] = monthRange(m);
    const mon = db.get("SELECT COALESCE(SUM(goods),0) goods, COALESCE(SUM(commission),0) commission, COALESCE(SUM(acquiring),0) acquiring, COUNT(*) n FROM shipments WHERE store_id=? AND status IN ('delivered','picked') AND status_at>=? AND status_at<?", storeId, a, b);
    const tot = db.get("SELECT COALESCE(SUM(commission),0) c, COALESCE(SUM(acquiring),0) q FROM shipments WHERE store_id=? AND status IN ('delivered','picked')", storeId), all = tot.c + tot.q;
    // Money that crossed sides: for orders paid to the store the buyer also handed it the delivery fee that Quriliş Go paid to Yandex;
    // for orders paid by card online Quriliş Go holds the goods money and owes the store its share (goods minus commission and the bank's fee).
    const flow = db.get(`SELECT COALESCE(SUM(CASE WHEN o.pay IN ('store','cash') AND sh.tariff IS NOT NULL AND sh.claim_id IS NOT NULL AND sh.claim_id NOT LIKE 'sim-%' THEN sh.price ELSE 0 END),0) delivery_due,
        COALESCE(SUM(CASE WHEN o.pay NOT IN ('store','cash') AND o.pay_status IN ('paid','refund_due','refunded') THEN sh.goods - sh.commission - sh.acquiring ELSE 0 END),0) payout_due,
        COALESCE(SUM(CASE WHEN o.pay NOT IN ('store','cash') AND o.pay_status IN ('paid','refund_due','refunded') THEN sh.goods ELSE 0 END),0) online_held,
        COALESCE(SUM(CASE WHEN o.pay NOT IN ('store','cash') AND o.pay_status IN ('paid','refund_due','refunded') AND sh.status_at>=? AND sh.status_at<? THEN sh.goods ELSE 0 END),0) online_month
        FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND sh.status IN ('delivered','picked')`, a, b, storeId);
    const paid = db.get("SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE store_id=?", storeId).s;
    const po = db.get("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) paid, COALESCE(SUM(CASE WHEN status='requested' THEN amount ELSE 0 END),0) pending FROM payouts WHERE store_id=?", storeId);
    // balance > 0: the store owes Quriliş Go; < 0: Quriliş Go owes the store. Commission and fees on card-paid orders are already inside
    // the goods money Quriliş Go holds, so they are counted once: all commissions and fees + delivery fees handed to the store − goods money held + what was paid out.
    return { month, goods: mon.goods, commission: mon.commission, acquiring: mon.acquiring, orders: mon.n, online_month: flow.online_month, commission_total: tot.c, acquiring_total: tot.q, delivery_due: flow.delivery_due, payout_due: flow.payout_due,
      payout_paid: po.paid, payout_pending: po.pending, payout_available: Math.max(0, flow.payout_due - po.paid - po.pending), settled: paid, balance: all + flow.delivery_due - flow.online_held - paid + po.paid };
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
    lim.hit("mfa:" + u.id, 10, 15 * 60000); lim.hit("mfa-d:" + u.id, 30, 86400_000); // and at most 30 tries a day: guessing a 6-digit code stays hopeless
    const counter = u.totp_secret ? checkTotp(u.totp_secret, b.code) : false;
    if (counter === false) {
      audit(req, "mfa.fail", u.id);
      const fails = db.get("SELECT COUNT(*) n FROM audit WHERE action='mfa.fail' AND user_id=? AND created_at>?", u.id, Date.now() - 3600_000).n;
      if (fails === 5) notify.owners(`⚠️ 5 неверных кодов входа в панель за час для ${String(u.name || u.phone || u.id).replace(/[<>&]/g, "")}. Если это не вы — смените пароль.`); // the password or SMS step was passed by someone
      throw bad("mfa_wrong", "Wrong code");
    }
    // each code counts once: the counter it belongs to is remembered, and anything up to it is refused (no replay in the ±30 s tolerance)
    if (!db.run("UPDATE users SET totp_last=? WHERE id=? AND (totp_last IS NULL OR CAST(totp_last AS INTEGER)<?)", String(counter), u.id, counter).changes) throw bad("mfa_reused", "This code was already used, wait for the next one");
    if (!u.totp_on) { db.run("UPDATE users SET totp_on=1 WHERE id=?", u.id); audit(req, "mfa.enabled", u.id); }
    return session(db.get("SELECT * FROM users WHERE id=?", u.id), { mfa: true });
  });
  r.get("/api/admin/finance", (req, res, p, url) => {
    needOwner(req); // money: the owner only
    const m = url.searchParams.get("month");
    const rows = db.all("SELECT id, name, status, free_until FROM stores ORDER BY name").map(s => ({ id: s.id, name: s.name, status: s.status, free_until: s.free_until, promo: inPromo(s), ...storeFinance(s.id, m) })).filter(x => x.orders || x.balance || x.commission_total || x.acquiring_total);
    const t = rows.reduce((a, x) => ({ goods: a.goods + x.goods, commission: a.commission + x.commission, acquiring: a.acquiring + x.acquiring, balance: a.balance + x.balance }), { goods: 0, commission: 0, acquiring: 0, balance: 0 });
    return { month: monthRange(m)[2], rates: { platform: cfg.commission, acquiring: cfg.acquiring, acquiring_by: cfg.acquiringBy, promo_months: cfg.promoMonths }, stores: rows, totals: t, settlements: db.all("SELECT st.*, s.name FROM settlements st LEFT JOIN stores s ON s.id=st.store_id ORDER BY st.created_at DESC LIMIT 30"),
      payouts: db.all("SELECT p.*, s.name FROM payouts p LEFT JOIN stores s ON s.id=p.store_id ORDER BY p.status='requested' DESC, p.requested_at DESC LIMIT 60") };
  });
  /* the store asks for its money from card-paid orders; an admin transfers it and marks the request paid */
  r.post("/api/seller/payout", async req => {
    const { s, u } = needSeller(req), b = await readJson(req);
    const f = storeFinance(s.id), amount = b.amount == null || b.amount === "" ? f.payout_available : int(b.amount, 1, 1e12);
    if (!amount || amount > f.payout_available) throw bad("bad_amount", "Nothing to pay out yet");
    const to = str(b.payout_to, 120).replace(/[<>]/g, "") || s.payout_to || ""; if (to.length < 8) throw bad("payout_to", "Add a card number or bank account for the transfer");
    if (to !== s.payout_to) { await payoutChange(req, u, s, to, b); db.run("UPDATE stores SET payout_to=? WHERE id=?", to, s.id); }
    if (db.get("SELECT 1 FROM payouts WHERE store_id=? AND status='requested'", s.id)) throw new HttpError(409, "payout_pending", "The previous request is still being processed");
    const id = Number(db.run("INSERT INTO payouts(store_id,amount,payout_to,requested_at) VALUES(?,?,?,?)", s.id, amount, to, Date.now()).lastInsertRowid);
    audit(req, "payout.request", s.id, { amount });
    notify.owners(`💸 Запрос выплаты #${id}: ${s.name.replace(/[<>&]/g, "")} — ${amount.toLocaleString("ru-RU")} сум на ${to.replace(/[<>&]/g, "")}. Отметьте «Выплачено» в админке после перевода.`);
    return { ok: true, finance: storeFinance(s.id), payout: db.get("SELECT * FROM payouts WHERE id=?", id) };
  });
  /* Monthly statement for the seller: every completed sale with the two deductions, refunds, payouts and other entries,
     and the sum due. It is deliberately not called profit: the store's purchase prices and taxes are unknown here. */
  r.get("/api/seller/statement", (req, res, p, url) => {
    const { s } = needSeller(req), [a, b, month] = monthRange(url.searchParams.get("month"));
    const sales = db.all(`SELECT sh.id ship_id, sh.status_at at, sh.goods, sh.commission, sh.acquiring, sh.lines, sh.status, o.num, o.pay, o.pay_status
      FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE sh.store_id=? AND sh.status IN ('delivered','picked') AND sh.status_at>=? AND sh.status_at<? ORDER BY sh.status_at`, s.id, a, b)
      .map(x => { const card = !["store", "cash"].includes(x.pay); return { ship_id: x.ship_id, at: x.at, num: x.num, items: JSON.parse(x.lines).reduce((n, l) => n + l.q, 0), paid: card ? "card" : "store", goods: x.goods, commission: x.commission, acquiring: x.acquiring, net: card ? x.goods - x.commission - x.acquiring : 0 }; });
    // card orders cancelled after the bank took the money: the buyer is refunded, the store sees the sale fall away
    const refunds = db.all(`SELECT sh.id ship_id, sh.status_at at, sh.goods, sh.cancel_reason, o.num, o.pay_status FROM shipments sh JOIN orders o ON o.id=sh.order_id
      WHERE sh.store_id=? AND sh.status='cancelled' AND o.pay NOT IN ('store','cash') AND o.pay_status IN ('refund_due','refunded') AND sh.status_at>=? AND sh.status_at<? ORDER BY sh.status_at`, s.id, a, b)
      .map(x => ({ ship_id: x.ship_id, at: x.at, num: x.num, goods: x.goods, reason: x.cancel_reason, refunded: x.pay_status === "refunded" }));
    const payouts = db.all("SELECT id, amount, status, payout_to, requested_at, done_at, note FROM payouts WHERE store_id=? AND requested_at>=? AND requested_at<? ORDER BY requested_at", s.id, a, b);
    const other = db.all("SELECT id, amount, note, created_at FROM settlements WHERE store_id=? AND created_at>=? AND created_at<? ORDER BY created_at", s.id, a, b); // payments the store made to Quriliş Go (e.g. for pay-at-store orders), entered by the admin
    const sum = (arr, k) => arr.reduce((n, x) => n + (x[k] || 0), 0);
    const f = storeFinance(s.id, month);
    return {
      month, store: { id: s.id, name: s.name, free_until: s.free_until || null, promo: inPromo(s) }, rates: storeRates(s),
      sales, refunds, payouts, other,
      totals: { sales: sum(sales, "goods"), sales_card: sum(sales.filter(x => x.paid === "card"), "goods"), sales_store: sum(sales.filter(x => x.paid === "store"), "goods"), orders: sales.length, refunds: sum(refunds, "goods"), commission: sum(sales, "commission"), acquiring: sum(sales, "acquiring"), other: sum(other, "amount"), due: sum(sales, "net"),
        payouts_paid: sum(payouts.filter(x => x.status === "paid"), "amount"), payouts_pending: sum(payouts.filter(x => x.status === "requested"), "amount") },
      balance: { payout_due: f.payout_due, payout_paid: f.payout_paid, payout_pending: f.payout_pending, payout_available: f.payout_available, delivery_due: f.delivery_due, settled: f.settled, owed: f.balance } // all-time, same figures as the cabinet
    };
  });
  r.get("/api/seller/payouts", req => { const { s } = needSeller(req); return { payouts: db.all("SELECT * FROM payouts WHERE store_id=? ORDER BY requested_at DESC LIMIT 30", s.id) }; });
  r.patch("/api/admin/payouts/:id", async (req, res, p) => {
    const a = needOwner(req), b = await readJson(req);
    const po = db.get("SELECT * FROM payouts WHERE id=?", Number(p.id)); if (!po) throw new HttpError(404, "not_found", "Request not found");
    if (po.status !== "requested") throw bad("done", "This request is already closed");
    if (!["paid", "rejected"].includes(b.status)) throw bad("bad_status", "paid or rejected");
    db.run("UPDATE payouts SET status=?, note=?, admin_id=?, done_at=? WHERE id=?", b.status, str(b.note, 200), a.id, Date.now(), po.id);
    audit(req, "payout." + b.status, po.store_id, { id: po.id, amount: po.amount });
    const st = db.get("SELECT * FROM stores WHERE id=?", po.store_id), ow = st?.owner_id && db.get("SELECT tg_chat FROM users WHERE id=?", st.owner_id);
    if (ow?.tg_chat) tg.send(ow.tg_chat, b.status === "paid" ? `💸 Выплата ${po.amount.toLocaleString("ru-RU")} сум отправлена на ${po.payout_to.replace(/[<>&]/g, "")}.` : `Выплата ${po.amount.toLocaleString("ru-RU")} сум не проведена${b.note ? ": " + str(b.note, 200).replace(/[<>&]/g, "") : ""}. Проверьте реквизиты в кабинете.`);
    return { ok: true, finance: storeFinance(po.store_id) };
  });
  r.post("/api/admin/settlements", async req => {
    const u = needOwner(req), b = await readJson(req);
    const s = db.get("SELECT id FROM stores WHERE id=?", String(b.store_id || "")); if (!s) throw new HttpError(404, "not_found", "Store not found");
    const amount = int(b.amount, -1e12, 1e12); if (!amount) throw bad("bad_amount", "Amount is required");
    db.run("INSERT INTO settlements(store_id,amount,note,admin_id,created_at) VALUES(?,?,?,?,?)", s.id, amount, str(b.note, 200), u.id, Date.now());
    audit(req, "settlement", s.id, { amount, note: str(b.note, 200) });
    return { ok: true, finance: storeFinance(s.id) };
  });
  r.get("/api/admin/audit", req => { needOwner(req); return { log: db.all("SELECT a.*, u.name, u.phone FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100") }; });
  r.get("/api/admin/stores", req => { needAdmin(req); return { stores: db.all("SELECT s.*, u.name owner_name, u.phone owner_phone FROM stores s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.status='pending' DESC, s.created_at DESC").map(s => ({ ...publicStore(s), owner_name: s.owner_name, owner_phone: s.owner_phone, loc_src: s.loc_src, created: s.created_at, note: s.review_note, free_until: s.free_until, promo: inPromo(s), ...contractView(s) })) }; });
  r.patch("/api/admin/stores/:id", async (req, res, p) => {
    const adm = needAdmin(req), b = await readJson(req);
    const s = db.get("SELECT * FROM stores WHERE id=?", p.id); if (!s) throw new HttpError(404, "not_found", "Store not found");
    if (b.status && !["active", "pending", "meeting", "rejected", "blocked"].includes(b.status)) throw bad("bad_status", "Unknown status");
    // access opens only after the contract is signed on paper: the admin records its number (once; a blocked store comes back without it)
    const contractNo = b.contract_no != null ? str(b.contract_no, 40) : "";
    if (b.status === "active" && s.status !== "active" && !s.contract_no && !contractNo && process.env.STORE_AUTO_APPROVE !== "1") throw bad("contract_required", "Record the signed contract number before opening access");
    let meetAt; if (b.meet_at !== undefined) { meetAt = b.meet_at ? new Date(b.meet_at).getTime() : null; if (b.meet_at && !Number.isFinite(meetAt)) throw bad("bad_date", "meet_at must be a date"); if (meetAt && (meetAt < Date.now() - 5 * 60000 || meetAt > Date.now() + 366 * 86400000)) throw bad("meeting_past", "The meeting must be within the coming year"); }
    if (b.status === "meeting" && !meetAt && !s.meet_at) throw bad("meeting_required", "Set the date and place of the meeting");
    if ((b.owner_phone !== undefined || b.free_until !== undefined) && !isOwner(adm)) throw new HttpError(403, "owner_only", "Only the owner of Quriliş Go moves a store to another person or changes its free months");
    // validate everything before the first write, so a bad owner phone does not leave a half-applied change
    const newOwner = b.owner_phone ? db.get("SELECT * FROM users WHERE phone=?", parsePhone(b.owner_phone)) : null;
    if (b.owner_phone && !newOwner) throw new HttpError(404, "user_not_found", "The owner must sign in once first");
    // the free months start on the day of approval; an admin may also move or end them by hand ("free_until": date, "" ends them now)
    let freeUntil; if (b.free_until !== undefined) { if (b.free_until === "" || b.free_until === null) freeUntil = Date.now(); else { freeUntil = new Date(b.free_until).getTime(); if (!Number.isFinite(freeUntil)) throw bad("bad_date", "free_until must be a date"); } }
    else if (b.status === "active" && s.status !== "active" && !s.free_until) freeUntil = addMonths(Date.now(), cfg.promoMonths);
    if (meetAt !== undefined || b.meet_place != null) db.run("UPDATE stores SET meet_at=?, meet_place=? WHERE id=?", meetAt !== undefined ? meetAt : s.meet_at, b.meet_place != null ? str(b.meet_place, 200).replace(/[<>]/g, "") : s.meet_place, s.id);
    if (contractNo && contractNo !== s.contract_no) db.run("UPDATE stores SET contract_no=?, contract_at=?, contract_by=? WHERE id=?", contractNo.replace(/[<>]/g, ""), Date.now(), adm.id, s.id);
    db.run("UPDATE stores SET status=COALESCE(?,status), review_note=COALESCE(?,review_note), verified=COALESCE(?,verified), free_until=COALESCE(?,free_until) WHERE id=?", b.status || null, b.note != null ? str(b.note, 300) : null, b.verified == null ? null : b.verified ? 1 : 0, freeUntil ?? null, s.id);
    audit(req, "store." + (b.status || "edit"), s.id, { note: str(b.note, 300), owner_phone: str(b.owner_phone, 20) });
    if (b.status === "active" && s.status !== "active") channel.storeApproved(s).catch(e => log.warn("[channel]", e.message));
    if (b.status && s.owner_id) { const ow = db.get("SELECT tg_chat FROM users WHERE id=?", s.owner_id); if (ow?.tg_chat) tg.send(ow.tg_chat, b.status === "meeting" ? (() => { const x = db.get("SELECT meet_at, meet_place FROM stores WHERE id=?", s.id); return `📅 Анкета магазина «${s.name.replace(/[<>&]/g, "")}» проверена. Встреча для подписания договора: ${new Date(x.meet_at).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}${x.meet_place ? ", " + x.meet_place.replace(/[<>&]/g, "") : ""}. После подписания откроем доступ к кабинету.`; })() : b.status === "active" ? `🎉 Магазин «${s.name.replace(/[<>&]/g, "")}» одобрен и виден покупателям на Quriliş Go.` : `Статус магазина «${s.name.replace(/[<>&]/g, "")}»: ${b.status}.${b.note ? " " + str(b.note, 300).replace(/[<>&]/g, "") : ""}`); }
    if (newOwner) {
      const ou = newOwner;
      db.tx(() => { db.run("UPDATE stores SET owner_id=? WHERE id=?", ou.id, s.id); db.run("UPDATE users SET role='seller', store_id=? WHERE id=?", s.id, ou.id);
        db.run("UPDATE users SET store_id=NULL, role='buyer' WHERE store_id=? AND id<>?", s.id, ou.id); });
    }
    bumpCatalog();
    return { store: publicStore(db.get("SELECT * FROM stores WHERE id=?", s.id)) };
  });
  r.patch("/api/admin/shipments/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(p.id)); if (!sh) throw new HttpError(404, "not_found", "Shipment not found");
    const o = db.get("SELECT * FROM orders WHERE id=?", sh.order_id);
    const steps = STEPS[flowOf(sh, o ? JSON.parse(o.form) : {})]; // a store-delivered shipment has no carrier steps (searching / to_store)
    if (!steps.includes(b.status) && b.status !== "cancelled") throw bad("bad_status", "Unknown status");
    if (b.courier) db.run("UPDATE shipments SET courier=? WHERE id=?", str(b.courier, 80), sh.id);
    if (b.status === sh.status) return { ok: true };
    // the admin can move a shipment forward or cancel it, but not revive a cancelled one, hand over an unpaid one, or undo a handover
    if (sh.status === "cancelled") throw bad("already_cancelled", "This shipment is cancelled");
    if (["delivered", "picked"].includes(sh.status)) throw bad("already_done", "This shipment has been handed over");
    if (sh.status === "unpaid" && b.status !== "cancelled") throw bad("unpaid", "The order has not been paid yet — mark the payment first");
    if (["delivered", "picked"].includes(b.status) && !["store", "cash"].includes(o?.pay) && !["paid", "refund_due", "refunded"].includes(o?.pay_status)) throw bad("unpaid", "The order has not been paid yet");
    if (b.status !== "cancelled" && steps.indexOf(b.status) < steps.indexOf(sh.status)) throw bad("backwards", "A shipment cannot go back to an earlier step");
    db.tx(() => {
      if (b.status === "cancelled") for (const l of JSON.parse(sh.lines)) db.run("UPDATE offers SET stock=stock+? WHERE product_id=? AND store_id=?", l.q, l.id, sh.store_id);
      setShipStatus(sh, b.status, b.status === "cancelled" ? "admin" : null);
    });
    if (b.status === "cancelled") bumpCatalog();
    if (b.status === "searching" && sh.tariff) courier.order(db.get("SELECT * FROM shipments WHERE id=?", sh.id)).then(r => { if (r?.loaders_failed) notify.loadersFailed(sh.id); }).catch(e => log.warn("[courier] order", e.message));
    audit(req, "admin.ship." + b.status, sh.id);
    return { ok: true };
  });
  r.patch("/api/admin/orders/:num/pay", async (req, res, p) => {
    needOwner(req); const b = await readJson(req); // marks money as received: the owner only
    if (!["paid", "pending", "refunded", "refund_due", "on_delivery"].includes(b.pay_status)) throw bad("bad_status", "Unknown payment status");
    const o = db.get("SELECT id, pay_status FROM orders WHERE num=?", p.num); if (!o) throw new HttpError(404, "not_found", "Order not found");
    db.run("UPDATE orders SET pay_status=?, paid_at=CASE WHEN ?='paid' AND paid_at IS NULL THEN ? ELSE paid_at END WHERE id=?", b.pay_status, b.pay_status, Date.now(), o.id);
    audit(req, "order.pay." + b.pay_status, p.num);
    // marked paid by hand (payment confirmed outside the callbacks): the stores get the order exactly as after a bank callback
    if (b.pay_status === "paid") orderPaid(o.id);
    return { ok: true };
  });

  const mastersApi = registerMasters({ r, db, cfg, ref, need, needAdmin, audit, lim, tg, push, sms, log, saveImage, removeUpload, mediaUrl });
  bot = registerBot({ db, cfg, ref, tg, bonus, masters: mastersApi, log, hooks: {
    /* the store's delivery price typed in the bot: the same rules as the cabinet (store-delivered, not handed over yet, 0 … 5 000 000) */
    deliveryPrice(shipId, price, u) {
      const sh = db.get("SELECT * FROM shipments WHERE id=?", Number(shipId)), st = sh && db.get("SELECT owner_id FROM stores WHERE id=?", sh.store_id);
      if (!sh || !u || st?.owner_id !== u.id) return { error: "forbidden" };
      const fo = JSON.parse(db.get("SELECT form FROM orders WHERE id=?", sh.order_id)?.form || "{}");
      if (!(sh.tariff && fo.delivery_by === "store") || !["new", "assembling", "on_way"].includes(sh.status)) return { error: "bad_status" };
      const p = deliveryPriceOf(price); if (p === null) return { error: "bad_price" };
      try { lim.hit("delprice:" + sh.id, 5, 3600_000); } catch { return { error: "rate_limited" }; }
      db.run("UPDATE shipments SET price=?, price_named_at=? WHERE id=?", p, Date.now(), sh.id); audit({ user: u, ip: "telegram" }, "ship.delivery_price", sh.id, { price: p });
      setImmediate(() => notify.deliveryPriced(sh.id)); return { ok: true };
    }
  } });
  bonus.routes(r, need, lim);
  registerStats({ r, db, lim, needSeller });
  channel.routes(r, needOwner); // the Telegram channel speaks for the company: the owner only
  registerQuestions({ r, db, cfg, need, needSeller, lim, tg, push, log });
  registerSupport({ r, db, cfg, need, needAdmin, lim, tg, push, notify, log });
  registerTeams({ r, db, cfg, need, lim, tg, log });
  registerDashboard({ r, db, needAdmin: needOwner }); // analytics: the owner only
  const cx = registerCatalogExtras({ r, db, cfg, need, lim, tg, push, saveImage, removeUpload, mediaUrl, log, moderation });
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
      if (status === 500) { log.error("[error]", req.method, url.pathname, e); if (Date.now() - (server.lastAlert || 0) > 600000) { server.lastAlert = Date.now(); notify.owners(`⚠️ Ошибка сервера: ${req.method} ${url.pathname}\n${String(e?.message ?? e).slice(0, 200).replace(/[<>&]/g, "")}`); } }
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
    db.run("DELETE FROM tg_links WHERE expires_at<?", now); db.run("DELETE FROM tg_logins WHERE expires_at<?", now);
    priceReminders(now);
    payments.sweep(now);
    courierSweep().catch(e => log.warn("[courier] sweep", e.message));
  }
  /* Sellers who have not touched or confirmed their prices for a week get a Telegram nudge, at most once a week per store */
  function priceReminders(now = Date.now()) {
    const week = 7 * 86400000;
    for (const s of db.all("SELECT s.*, u.tg_chat, u.lang FROM stores s JOIN users u ON u.id=s.owner_id WHERE s.status='active' AND u.tg_chat IS NOT NULL AND COALESCE(s.prices_reminded_at,0)<?", now - week)) {
      const f = pricesFreshness(s); if (!f.stale || (f.confirmed_at && now - f.confirmed_at < week)) continue;
      db.run("UPDATE stores SET prices_reminded_at=? WHERE id=?", now, s.id);
      const days = f.days != null ? f.days : null, link = `${cfg.siteUrl}#seller`;
      tg.send(s.tg_chat, (s.lang || "ru") === "uz" ? `🏷 <b>${s.name.replace(/[<>&]/g, "")}</b>: narx va qoldiqlar ${days != null ? days + " kundan beri" : "hali"} tasdiqlanmagan. Xaridorlar eski narxni ko‘rmasligi uchun kabinetda «Hammasi dolzarb» tugmasini bosing yoki narxlarni yangilang: ${link}`
        : `🏷 <b>${s.name.replace(/[<>&]/g, "")}</b>: цены и остатки не подтверждались ${days != null ? days + " дн." : "ещё ни разу"}. Чтобы покупатели не видели устаревшую цену, нажмите «Всё актуально» в кабинете или обновите прайс: ${link}`).catch(e => log.warn("[prices] remind", e.message));
    }
  }
  /* Yandex drives the courier statuses once a claim exists; a failed search returns the shipment to the store */
  let courierSweeping = false;
  async function courierSweep() {
    if (!courier.live || courierSweeping) return; // a slow carrier API must not let two sweeps move the same shipment twice
    courierSweeping = true;
    try { await courierSweepRun(); } finally { courierSweeping = false; }
  }
  async function courierSweepRun() {
    for (const s of db.all("SELECT * FROM shipments WHERE claim_id IS NOT NULL AND status IN ('searching','to_store','on_way')")) {
      let r; try { r = await courier.poll(s); } catch (e) { log.warn("[courier] poll", s.id, e.message); continue; }
      if (!r || !r.status || r.status === s.status) continue;
      const order = ["searching", "to_store", "on_way", "delivered"];
      if (r.status === "failed") {
        db.run("UPDATE shipments SET claim_id=NULL, tracking_url=NULL WHERE id=?", s.id); setShipStatus(s, "assembling", "courier_failed");
        db.run("UPDATE shipments SET accepted_at=? WHERE id=?", Date.now(), s.id); // the handover clock starts again: the store did its part, the carrier failed
        notify.admins(`🚚 Яндекс не выполнил доставку отправления #${s.id} (${r.raw}). Магазину нужно вызвать курьера снова.`);
        const st = db.get("SELECT owner_id FROM stores WHERE id=?", s.store_id), ow = st?.owner_id && db.get("SELECT tg_chat FROM users WHERE id=?", st.owner_id);
        if (ow?.tg_chat) tg.send(ow.tg_chat, `🚚 Яндекс не нашёл курьера для отправления #${s.id}. Нажмите «Вызвать курьера» ещё раз в кабинете.`);
      } else if (order.indexOf(r.status) > order.indexOf(s.status)) setShipStatus(db.get("SELECT * FROM shipments WHERE id=?", s.id), r.status);
    }
  }
  function backup() {
    if (!cfg.backupDir || cfg.dbPath === ":memory:") return;
    try {
      mkdirSync(cfg.backupDir, { recursive: true });
      const day = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10), file = join(cfg.backupDir, `imorat-${day}.db`);
      if (!existsSync(file)) { db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); log.info("[backup] saved", file); }
      readdirSync(cfg.backupDir).filter(f => /^imorat-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14).forEach(f => unlinkSync(join(cfg.backupDir, f)));
    } catch (e) { log.error("[backup] failed", e.message); notify.owners("⚠️ Резервная копия базы не сохранилась: " + String(e.message).slice(0, 150)); }
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
  server.notify = notify; server.bot = bot; server.tg = tg;
  return server;
}
