import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { totp } from "../src/totp.js";
import { createECDH, createDecipheriv, hkdfSync } from "node:crypto";

/* ---- fake external services: Eskiz, Yandex, Anthropic, Google JWKS ---- */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const sms = [], tgSent = [], tgUpdates = [], pushes = [];
const fake = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks), body = raw.toString("utf8");
  const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/eskiz/auth/login") return json(200, { data: { token: "T" } });
  if (req.url === "/eskiz/message/sms/send") { sms.push(body); return json(200, { id: "1", status: "waiting" }); }
  if (req.url === "/ya/b2b/cargo/integration/v2/check-price") { const b = JSON.parse(body); return json(200, { price: b.requirements.taxi_class === "express" ? "21000.00" : "99000.00", eta: 30 }); }
  if (req.url === "/jwks") return json(200, { keys: [jwk] });
  if (req.url.startsWith("/tg/botTGTOKEN/")) {
    const m = req.url.split("/").pop(), b = body ? JSON.parse(body) : {};
    if (m === "getMe") return json(200, { ok: true, result: { username: "imorat_test_bot" } });
    if (m === "getUpdates") return json(200, { ok: true, result: tgUpdates.splice(0) });
    if (m === "sendMessage" || m === "sendPhoto" || m === "editMessageText" || m === "answerCallbackQuery") { tgSent.push({ m, ...b }); return json(200, { ok: true, result: { message_id: tgSent.length } }); }
  }
  if (req.url === "/push/ep1") { pushes.push({ body: raw, auth: req.headers.authorization, enc: req.headers["content-encoding"] }); res.writeHead(201); return res.end(); }
  if (req.url === "/ai/v1/messages") {
    const b = JSON.parse(body);
    assert.equal(req.headers["x-api-key"], "sk-test");
    if (b.system[0].text.startsWith("Ты — AI-дизайнер")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: '{"items":[520],"say":"ok"}' } })}\n\n`); return res.end(); }
    assert.ok(b.system[0].text.includes("Цемент М400"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const t of ["Для подвала ", "нужен цемент ", "[[1:115]]"]) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
    return res.end();
  }
  json(404, {});
});

let app, base, fakeBase, dir;
const idToken = claims => {
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "RS256", kid: "k1", typ: "JWT" }), p = enc({ iss: "https://accounts.google.com", aud: "gid", exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const s = createSign("RSA-SHA256").update(h + "." + p).sign(privateKey, "base64url");
  return `${h}.${p}.${s}`;
};
async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function login(phone, codeFrom = "dev") {
  const s = await call("POST", "/api/auth/otp/send", { phone });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return call("POST", "/api/auth/otp/verify", { phone, code: s.data.dev_code });
}

before(async () => {
  await new Promise(r => fake.listen(0, r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  dir = mkdtempSync(join(tmpdir(), "imorat-"));
  const cfg = loadConfig({
    JWT_SECRET: "test-secret", DB_PATH: join(dir, "t.db"), UPLOADS_DIR: join(dir, "up"), ADMIN_PHONES: "998901111111",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_JWKS_URL: fakeBase + "/jwks", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_URL: fakeBase + "/ai", SMS_MODE: "dev",
    TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0", BACKUP_DIR: join(dir, "bk"), OTP_PER_IP_HOUR: "200", TELEGRAM_CHANNEL: "@imorat_test", CHANNEL_HOUR: "25"
  });
  app = createApp(cfg, { info() {}, warn() {}, error: console.error });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.stopJobs(); app.close(); app.closeAllConnections(); fake.close(); fake.closeAllConnections(); app.db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

test("catalog is seeded from the website", async () => {
  const r = await call("GET", "/api/catalog");
  assert.equal(r.status, 200);
  assert.equal(r.data.stores.length, 9);
  assert.ok(r.data.products.length >= 340);
  assert.equal(r.data.products[0].ru, "Цемент М400 Д20");
});

test("phone sign-in: validation, wrong code, success, profile", async () => {
  assert.equal((await call("POST", "/api/auth/otp/send", { phone: "12345" })).data.error, "bad_phone");
  const s = await call("POST", "/api/auth/otp/send", { phone: "90 123 45 67" });
  assert.match(s.data.dev_code, /^\d{6}$/);
  const again = await call("POST", "/api/auth/otp/send", { phone: "+998 90 123 45 67" });
  assert.equal(again.status, 429);
  const wrong = await call("POST", "/api/auth/otp/verify", { phone: "901234567", code: "000000" });
  assert.equal(wrong.data.error, "otp_wrong");
  const ok = await call("POST", "/api/auth/otp/verify", { phone: "901234567", code: s.data.dev_code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.is_new, true);
  const me = await call("PATCH", "/api/me", { name: "Азиз", role: "pro", district: "chil" }, ok.data.token);
  assert.equal(me.data.user.role, "pro");
  assert.equal((await call("PATCH", "/api/me", { role: "seller" }, ok.data.token)).data.error, "bad_role");
  assert.equal((await call("GET", "/api/me")).status, 401);
});

test("google sign-in asks for a phone, then links the account", async () => {
  const g = await call("POST", "/api/auth/google", { credential: idToken({ sub: "g-1", email: "a@gmail.com", email_verified: true, name: "Aziz" }) });
  assert.equal(g.data.need_phone, true);
  const s = await call("POST", "/api/auth/otp/send", { phone: "935556677" });
  const v = await call("POST", "/api/auth/otp/verify", { phone: "935556677", code: s.data.dev_code, ticket: g.data.ticket });
  assert.equal(v.data.user.via, "google");
  assert.equal(v.data.user.email, "a@gmail.com");
  const again = await call("POST", "/api/auth/google", { credential: idToken({ sub: "g-1", email: "a@gmail.com", email_verified: true }) });
  assert.ok(again.data.token);
  const forged = idToken({ sub: "g-2" }).slice(0, -4) + "AAAA";
  assert.equal((await call("POST", "/api/auth/google", { credential: forged })).data.error, "bad_token");
  const otherApp = await call("POST", "/api/auth/google", { credential: idToken({ sub: "g-3", aud: "evil" }) });
  assert.equal(otherApp.data.error, "bad_token");
});

test("order: server prices, tiers, promo, stock, cancel", async () => {
  const { data } = await login("977001122");
  await call("PATCH", "/api/me", { name: "Нилуфар", district: "mirob" }, data.token);
  const cart = { lines: [{ id: 1, store: "usta", q: 10 }, { id: 53, store: "elp", q: 2 }], services: [], bundles: [], promo: "imorat5",
    form: { name: "Нилуфар", phone: "+998 97 700 11 22", district: "mirob", street: "ул. Навои, 10", floor: "3", lift: true, mode: "yandex", when: "asap", pay: "cash" } };
  const q = await call("POST", "/api/quote", cart, data.token);
  const cem = q.data.quote.ships.find(s => s.store === "usta").lines[0];
  assert.equal(cem.tier, 0.03); // 10 bags → wholesale −3%
  assert.equal(cem.price, Math.round(62000 * 0.97 / 500) * 500);
  assert.ok(q.data.quote.pd > 0);
  assert.equal(q.data.quote.ships.find(s => s.store === "usta").tariff, "cargo_s");
  const bad = await call("POST", "/api/orders", { ...cart, expected_total: 1 }, data.token);
  assert.equal(bad.status, 409); assert.equal(bad.data.error, "total_changed");
  const before = (await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(o => o.store === "usta").stock;
  const o = await call("POST", "/api/orders", { ...cart, expected_total: q.data.quote.total }, data.token);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.match(o.data.order.num, /^IM-1\d{5}$/);
  assert.equal(o.data.order.pay_status, "to_store");
  const afterStock = (await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(o => o.store === "usta").stock;
  assert.equal(afterStock, before - 10);
  const q2 = await call("POST", "/api/quote", cart, data.token);
  assert.equal(q2.data.quote.pd, 0); // promo is one-time
  const tooMany = await call("POST", "/api/orders", { ...cart, lines: [{ id: 1, store: "usta", q: 5000 }] }, data.token);
  assert.equal(tooMany.data.error, "cart_changed");
  const list = await call("GET", "/api/orders", null, data.token);
  assert.equal(list.data.orders.length, 1);
  const c = await call("POST", `/api/orders/${o.data.order.num}/cancel`, null, data.token);
  assert.equal(c.data.order.status, "cancelled");
  const restored = (await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(o => o.store === "usta").stock;
  assert.equal(restored, before);
});

test("store registration → admin approval → products → order to the store", async () => {
  const seller = (await login("998887766")).data.token;
  const bad = await call("POST", "/api/seller/store", { name: "X" }, seller);
  assert.equal(bad.data.error, "bad_store_name");
  const st = await call("POST", "/api/seller/store", {
    name: "Stroy Baraka", descr: "Сухие смеси, кирпич и металл оптом и в розницу", cats: ["build", "metal", "nope"], phone: "71 200 30 40",
    telegram: "@strbaraka", hours: "08:00–20:00", addr: "ул. Катартал, 5", landmark: "напротив рынка", la: 41.2905, lo: 69.2011, loc_src: "gps"
  }, seller);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.equal(st.data.store.status, "pending");
  assert.deepEqual(st.data.store.cats, ["build", "metal"]);
  assert.equal(st.data.store.d, "chil"); // nearest district from GPS
  assert.equal(st.data.user.role, "seller");
  const sid = st.data.store.id;
  assert.ok(!(await call("GET", "/api/catalog")).data.stores.some(s => s.id === sid));
  const np = await call("POST", "/api/seller/products", { ru: "Цемент Baraka М400, 50 кг", cat: "build", sub: "dry", unit: "bag50", price: 59000, stock: 200, kg: 50 }, seller);
  assert.equal(np.status, 200, JSON.stringify(np.data));
  assert.ok(np.data.product.id >= 10000);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const up = await fetch(`${base}/api/seller/products/${np.data.product.id}/photo`, { method: "POST", headers: { authorization: "Bearer " + seller, "content-type": "image/png" }, body: png });
  const upj = await up.json(); assert.equal(up.status, 200, JSON.stringify(upj));
  assert.equal((await fetch(base + upj.img)).status, 200);
  const notAdmin = await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, seller);
  assert.equal(notAdmin.status, 403);
  const adminRaw = (await login("901111111")).data.token;
  assert.equal((await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, adminRaw)).data.error, "mfa_setup_required");
  const setup = await call("POST", "/api/admin/mfa/setup", null, adminRaw);
  assert.match(setup.data.url, /^otpauth:\/\/totp\//);
  assert.equal((await call("POST", "/api/admin/mfa/verify", { code: "000000" }, adminRaw)).data.error, "mfa_wrong");
  const admin = (await call("POST", "/api/admin/mfa/verify", { code: totp(setup.data.secret) }, adminRaw)).data.token;
  globalThis.ADMIN = admin;
  assert.equal((await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, adminRaw)).data.error, "mfa_required");
  assert.equal((await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, admin)).status, 200);
  const cat = (await call("GET", "/api/catalog")).data;
  assert.ok(cat.stores.some(s => s.id === sid));
  assert.ok(cat.products.some(p => p.id === np.data.product.id));
  const buyer = (await login("950001122")).data.token;
  const o = await call("POST", "/api/orders", { lines: [{ id: np.data.product.id, store: sid, q: 20 }], form: { name: "Тимур", phone: "998950001122", mode: "pickup", pay: "cash" } }, buyer);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const sum = await call("GET", "/api/seller/summary", null, seller);
  assert.equal(sum.data.orders.length, 1);
  assert.deepEqual(sum.data.orders[0].next, ["assembling", "cancelled"]);
  const sh = sum.data.orders[0].ship_id;
  assert.equal((await call("PATCH", `/api/seller/shipments/${sh}`, { status: "searching" }, seller)).status, 400);
  for (const s of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/seller/shipments/${sh}`, { status: s }, seller)).status, 200);
  const done = await call("GET", `/api/orders/${o.data.order.num}`, null, buyer);
  assert.equal(done.data.order.status, "done");
  assert.equal((await call("GET", `/api/orders/${o.data.order.num}`, null, seller)).status, 404);
});

test("Usta AI streams text from the model", async () => {
  const r = await fetch(base + "/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Сколько цемента на подвал?" }], lang: "ru", cart: [{ id: 1, q: 2 }] }) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "Для подвала нужен цемент [[1:115]]");
  const j = await fetch(base + "/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "json", messages: [{ role: "user", content: "Комната 3×4" }] }) });
  assert.equal(JSON.parse(await j.text()).items[0], 520);
  assert.ok((await call("GET", "/api/catalog")).data.products.some(p => p.id === 520 && p.sub === "sofa"));
  const bad = await call("POST", "/api/ai/chat", { messages: [] });
  assert.equal(bad.data.error, "bad_messages");
});

test("Eskiz SMS and Yandex prices when keys are set", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "imorat2-"));
  const cfg = loadConfig({ JWT_SECRET: "x", DB_PATH: join(d2, "t.db"), UPLOADS_DIR: join(d2, "up"), ESKIZ_EMAIL: "e", ESKIZ_PASSWORD: "p", ESKIZ_URL: fakeBase + "/eskiz", YANDEX_DELIVERY_TOKEN: "y", YANDEX_DELIVERY_URL: fakeBase + "/ya" });
  const a2 = createApp(cfg, { info() {}, warn() {}, error: console.error });
  await new Promise(r => a2.listen(0, "127.0.0.1", r));
  const b2 = `http://127.0.0.1:${a2.address().port}`;
  const s = await (await fetch(b2 + "/api/auth/otp/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "901112233" }) })).json();
  assert.equal(s.dev_code, undefined);
  assert.ok(sms.at(-1).includes("998901112233"));
  const q = await (await fetch(b2 + "/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ id: 1, store: "usta", q: 4 }, { id: 53, store: "elp", q: 1 }], form: { mode: "yandex", district: "yunus" } }) })).json();
  const usta = q.quote.ships.find(x => x.store === "usta"), elp = q.quote.ships.find(x => x.store === "elp");
  assert.equal(usta.source, "yandex"); assert.equal(usta.price, 99000);
  assert.equal(elp.price, 21000);
  a2.stopJobs(); a2.close(); a2.closeAllConnections(); a2.db.raw.close(); rmSync(d2, { recursive: true, force: true });
});

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(50); } throw new Error("timeout"); }

test("Telegram: link seller, order arrives with buttons, accept from Telegram", async () => {
  const seller = (await login("991234567")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Tez Qurilish", descr: "Сухие смеси и инструмент рядом с метро", cats: ["build"], phone: "712223344", addr: "ул. Мукими, 7", hours: "00:00–00:00", district: "yunus" }, seller);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 2, price: 57000, stock: 50 }, seller);
  const link = await call("POST", "/api/me/telegram", null, seller);
  assert.match(link.data.url, /^https:\/\/t\.me\/imorat_test_bot\?start=[0-9a-f]+$/);
  tgUpdates.push({ update_id: 1, message: { chat: { id: 555 }, text: "/start " + link.data.url.split("=")[1], from: { id: 555 } } });
  await until(() => tgSent.some(x => x.chat_id === 555 && /подключён к магазину/.test(x.text)));
  const sum0 = await call("GET", "/api/seller/summary", null, seller);
  assert.equal(sum0.data.telegram, true);
  const buyer = (await login("933334455")).data;
  await call("PATCH", "/api/me", { name: "Бобур" }, buyer.token);
  const o = await call("POST", "/api/orders", { lines: [{ id: 2, store: sid, q: 3 }], form: { name: "Бобур", phone: "998933334455", mode: "pickup", pay: "store" } }, buyer.token);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const ship = o.data.order.ships[0];
  assert.ok(ship.accept_by > Date.now());
  const msg = await until(() => tgSent.find(x => x.m === "sendMessage" && x.chat_id === "555" && /заказ IM-/.test(x.text)));
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, `acc:${ship.id}`);
  tgUpdates.push({ update_id: 2, callback_query: { id: "cb1", data: `acc:${ship.id}`, message: { chat: { id: 999 } } } });
  await until(() => tgSent.some(x => x.m === "answerCallbackQuery" && x.callback_query_id === "cb1"));
  assert.equal((await call("GET", `/api/orders/${o.data.order.num}`, null, buyer.token)).data.order.ships[0].status, "new"); // stranger's chat can't accept
  tgUpdates.push({ update_id: 3, callback_query: { id: "cb2", data: `acc:${ship.id}`, message: { chat: { id: 555 } } } });
  await until(async () => (await call("GET", `/api/orders/${o.data.order.num}`, null, buyer.token)).data.order.ships[0].status === "assembling");
  await until(() => tgSent.some(x => x.m === "editMessageText"));
  tgUpdates.push({ update_id: 4, callback_query: { id: "cb3", data: `rdy:${ship.id}`, message: { chat: { id: 555 } } } });
  await until(async () => (await call("GET", `/api/orders/${o.data.order.num}`, null, buyer.token)).data.order.ships[0].status === "ready");
  await call("PATCH", `/api/seller/shipments/${ship.id}`, { status: "picked" }, seller);
  // review → rating
  const rv = await call("POST", `/api/orders/${o.data.order.num}/review`, { ship_id: ship.id, stars: 5, text: "Быстро собрали" }, buyer.token);
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  assert.equal((await call("POST", `/api/orders/${o.data.order.num}/review`, { ship_id: ship.id, stars: 1 }, buyer.token)).data.error, "already_rated");
  const revs = await call("GET", `/api/stores/${sid}/reviews`);
  assert.equal(revs.data.reviews[0].text, "Быстро собрали");
  const cat = await call("GET", "/api/catalog");
  const sr = cat.data.stores.find(s => s.id === sid).rating;
  assert.equal(sr.stars, 5); assert.equal(sr.done, 1);
  // finance: build category → 5% commission
  const fin = (await call("GET", "/api/seller/summary", null, seller)).data.finance;
  assert.equal(fin.goods, 57000 * 3); assert.equal(fin.commission, Math.round(57000 * 3 * 0.05)); assert.equal(fin.balance, fin.commission);
  const af = await call("GET", "/api/admin/finance", null, globalThis.ADMIN);
  assert.ok(af.data.stores.some(x => x.id === sid && x.commission === fin.commission));
  await call("POST", "/api/admin/settlements", { store_id: sid, amount: fin.commission, note: "Наличными" }, globalThis.ADMIN);
  assert.equal((await call("GET", "/api/seller/summary", null, seller)).data.finance.balance, 0);
  assert.ok((await call("GET", "/api/admin/audit", null, globalThis.ADMIN)).data.log.some(x => x.action === "settlement"));
});

test("Seller deadlines: reminder, SMS, auto-cancel restores stock and lowers reliability", async () => {
  const seller = (await login("990001111")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Sekin Market", descr: "Магазин, который забывает про заказы", cats: ["build"], phone: "712220000", addr: "ул. Тест, 1", hours: "00:00–00:00", district: "yunus" }, seller);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 3, price: 60000, stock: 10 }, seller);
  const buyer = (await login("990002222")).data.token;
  const o = await call("POST", "/api/orders", { lines: [{ id: 3, store: sid, q: 4 }], form: { name: "Тест", phone: "998990002222", mode: "pickup", pay: "store" } }, buyer);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const stock = async () => (await call("GET", "/api/catalog")).data.products.find(p => p.id === 3).offers.find(x => x.store === sid)?.stock;
  assert.equal(await stock(), 6);
  const t0 = Date.now();
  app.sweep(t0 + 6 * 60000);
  assert.equal(app.db.get("SELECT reminded FROM shipments WHERE id=?", o.data.order.ships[0].id).reminded, 1);
  app.sweep(t0 + 11 * 60000);
  assert.equal(app.db.get("SELECT sms_sent FROM shipments WHERE id=?", o.data.order.ships[0].id).sms_sent, 1);
  app.sweep(t0 + 21 * 60000);
  const ord = (await call("GET", `/api/orders/${o.data.order.num}`, null, buyer)).data.order;
  assert.equal(ord.status, "cancelled"); assert.equal(ord.ships[0].cancel_reason, "not_accepted");
  assert.equal(await stock(), 10);
  const r = (await call("GET", `/api/stores/${sid}/reviews`)).data.rating;
  assert.equal(r.fail, 1);
});

test("Web push: subscription gets an encrypted, VAPID-signed message", async () => {
  const u = (await login("994445566")).data.token;
  const cfgR = await call("GET", "/api/config");
  assert.ok(cfgR.data.push_key.length > 80);
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  assert.equal((await call("POST", "/api/push/subscribe", { endpoint: fakeBase.replace("http:", "https:") + "/x", keys: {} }, u)).data.error, "bad_subscription");
  app.db.run("INSERT INTO push_subs(endpoint,user_id,p256dh,auth,created_at) VALUES(?,?,?,?,?)", fakeBase + "/push/ep1", (await call("GET", "/api/me", null, u)).data.user.id, ua.getPublicKey().toString("base64url"), auth.toString("base64url"), Date.now());
  const r = await call("POST", "/api/push/test", null, u);
  assert.equal(r.data.sent, 1);
  const p = await until(() => pushes[0]);
  assert.equal(p.enc, "aes128gcm"); assert.match(p.auth, /^vapid t=.+, k=.+/);
  // decrypt as the browser would (RFC 8291)
  const b = p.body, salt = b.subarray(0, 16), idlen = b[20], asPub = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(JSON.parse(plain.subarray(0, -1).toString()).body, "Уведомления работают ✅");
});

test("Logout everywhere invalidates old sessions; online payment is refused until connected; backups", async () => {
  const t = (await login("995556677")).data.token;
  assert.equal((await call("GET", "/api/me", null, t)).status, 200);
  const bad = await call("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { name: "Тест", phone: "998995556677", mode: "pickup", pay: "click" } }, t);
  assert.equal(bad.data.error, "payment_unavailable");
  await call("POST", "/api/me/logout-all", null, t);
  assert.equal((await call("GET", "/api/me", null, t)).status, 401);
  app.backup();
  const { readdirSync } = await import("node:fs");
  assert.ok(readdirSync(join(dir, "bk")).some(f => /^imorat-\d{4}-\d{2}-\d{2}\.db$/.test(f)));
});

test("Price list import: update, add, create, skip bad rows", async () => {
  const seller = (await login("993334455")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Prays Test", descr: "Магазин для проверки загрузки прайса", cats: ["build"], phone: "712000000", addr: "ул. Тестовая, 1", hours: "09:00–18:00", district: "yunus" }, seller);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  await call("POST", "/api/seller/offers", { product_id: 1, price: 60000, stock: 7 }, seller);
  const r = await call("POST", "/api/seller/import", {
    offers: [{ product_id: 1, price: 59500, stock: null }, { product_id: 5, price: 1250, stock: 5000 }, { product_id: 999999, price: 1000 }, { product_id: 6, price: 5 }],
    create: [{ ru: "Клей для газоблока Baraka, 25 кг", cat: "build", sub: "dry", unit: "bag25", kg: 25, price: 41000, stock: 30 }, { ru: "x", cat: "nope", price: 1 }]
  }, seller);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { updated: 1, added: 1, created: 1, skipped: 3 });
  const sum = (await call("GET", "/api/seller/summary", null, seller)).data;
  const by = Object.fromEntries(sum.products.map(p => [p.ru, p]));
  assert.equal(sum.products.find(p => p.id === 1).price, 59500);
  assert.equal(sum.products.find(p => p.id === 1).stock, 7, "stock kept when the price list has none");
  assert.equal(sum.products.find(p => p.id === 5).stock, 5000);
  assert.ok(by["Клей для газоблока Baraka, 25 кг"]?.own);
  const buyer = (await login("993334466")).data.token;
  assert.equal((await call("POST", "/api/seller/import", { offers: [] }, buyer)).status, 403);
});

test("Masters: profile → moderation → request → accept shows phone → done → review", async () => {
  const mt = (await login("994440011")).data.token;
  await call("PATCH", "/api/me", { name: "Бахтиёр Каримов" }, mt);
  assert.equal((await call("POST", "/api/masters/me", { name: "Бахтиёр", specs: [], districts: ["yunus"] }, mt)).status, 400);
  const prof = await call("POST", "/api/masters/me", { name: "Бахтиёр Каримов", specs: ["tile", "plumb", "nope"], districts: ["yunus", "chil", "zzz"], exp: 8, price: 70000, price_unit: "m2", about: "Кафель в ванной под ключ" }, mt);
  assert.equal(prof.status, 200, JSON.stringify(prof.data));
  assert.deepEqual(prof.data.master.specs, ["tile", "plumb"]);
  assert.equal(prof.data.master.status, "pending");
  assert.equal((await call("GET", "/api/masters")).data.masters.length, 0, "hidden until approved");
  const id = prof.data.master.id;
  assert.equal((await call("PATCH", `/api/admin/masters/${id}`, { status: "active" }, globalThis.ADMIN)).status, 200);
  const list = (await call("GET", "/api/masters?spec=tile&district=yunus")).data.masters;
  assert.equal(list.length, 1); assert.equal(list[0].phone, undefined, "phone is not public");
  assert.equal((await call("GET", "/api/masters?spec=elec")).data.masters.length, 0);
  const buyer = (await login("994440022")).data.token;
  assert.equal((await call("POST", `/api/masters/${id}/requests`, { text: "x" }, buyer)).status, 400);
  const rq = await call("POST", `/api/masters/${id}/requests`, { text: "Положить плитку в ванной 6 м²", when: "на этой неделе", district: "yunus", street: "ул. Тест, 5" }, buyer);
  assert.equal(rq.status, 200, JSON.stringify(rq.data));
  assert.equal((await call("POST", `/api/masters/${id}/requests`, { text: "сам себе заявка" }, mt)).status, 400);
  let mine = (await call("GET", "/api/me/master-requests", null, buyer)).data.requests;
  assert.equal(mine[0].phone, null, "master phone hidden before accept");
  const inbox = (await call("GET", "/api/masters/me", null, mt)).data;
  assert.equal(inbox.requests[0].phone, "998994440022");
  const rid = inbox.requests[0].id;
  assert.equal((await call("PATCH", `/api/masters/requests/${rid}`, { status: "done" }, mt)).status, 409);
  assert.equal((await call("PATCH", `/api/masters/requests/${rid}`, { status: "accepted" }, buyer)).status, 409);
  assert.equal((await call("PATCH", `/api/masters/requests/${rid}`, { status: "accepted" }, mt)).status, 200);
  mine = (await call("GET", "/api/me/master-requests", null, buyer)).data.requests;
  assert.equal(mine[0].phone, "998994440011");
  assert.equal((await call("POST", `/api/masters/requests/${rid}/review`, { stars: 5 }, buyer)).status, 409, "only after done");
  await call("PATCH", `/api/masters/requests/${rid}`, { status: "done" }, mt);
  assert.equal((await call("POST", `/api/masters/requests/${rid}/review`, { stars: 5, text: "Аккуратно и быстро" }, buyer)).status, 200);
  assert.equal((await call("POST", `/api/masters/requests/${rid}/review`, { stars: 1 }, buyer)).status, 409);
  const one = (await call("GET", `/api/masters/${id}`)).data;
  assert.equal(one.master.stars, 5); assert.equal(one.master.done, 1); assert.equal(one.reviews[0].name, "");
  assert.equal(one.reviews[0].text, "Аккуратно и быстро");
});

test("Bonus points: referral welcome, spend at checkout, cashback on delivery, referral reward, refund on cancel", async () => {
  const seller = (await login("996660011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Bonus Qurilish", descr: "Магазин для проверки бонусов и кешбэка", cats: ["build"], phone: "712001122", addr: "ул. Бонусная, 3", hours: "00:00–00:00", district: "yunus" }, seller);
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 1, price: 59000, stock: 500 }, seller);
  const a = (await login("996660022")).data.token, b = (await login("996660033")).data.token;
  const ab = (await call("GET", "/api/me/bonus", null, a)).data;
  assert.match(ab.code, /^IM[A-Z2-9]{5}$/); assert.equal(ab.points, 0);
  assert.equal((await call("POST", "/api/me/bonus/referral", { code: ab.code }, a)).status, 400, "own code");
  assert.equal((await call("POST", "/api/me/bonus/referral", { code: "IMNOPE1" }, b)).status, 400);
  const w = await call("POST", "/api/me/bonus/referral", { code: ab.code.toLowerCase() }, b);
  assert.equal(w.status, 200, JSON.stringify(w.data)); assert.equal(w.data.points, 30000);
  assert.equal((await call("POST", "/api/me/bonus/referral", { code: ab.code }, b)).status, 409);
  const form = { name: "Бобур", phone: "998996660033", mode: "pickup", pay: "store" };
  const q = await call("POST", "/api/quote", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 999999 }, b);
  assert.equal(q.data.quote.pts, 30000); assert.equal(q.data.quote.total, 295000 - 30000);
  const o = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 999999, expected_total: 265000 }, b);
  assert.equal(o.status, 200, JSON.stringify(o.data)); assert.equal(o.data.order.pts, 30000);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 0);
  const sh = (await call("GET", "/api/seller/summary", null, seller)).data.orders[0].ship_id;
  for (const s of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/seller/shipments/${sh}`, { status: s }, seller)).status, 200);
  const bb = (await call("GET", "/api/me/bonus", null, b)).data;
  assert.equal(bb.points, 2950, "1% cashback of 295 000");
  assert.equal((await call("GET", "/api/me/bonus", null, a)).data.points, 30000, "referral reward after the friend's first delivery");
  assert.equal((await call("GET", "/api/me/bonus", null, a)).data.invited_paid, 1);
  // spend part of the cashback, cancel, points come back
  const o2 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form, points: 2000 }, b);
  assert.equal(o2.data.order.pts, 2000);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 950);
  assert.equal((await call("POST", `/api/orders/${o2.data.order.num}/cancel`, null, b)).status, 200);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 2950);
});

test("Seller statistics: anonymous views and cart adds, orders, price position", async () => {
  const seller = (await login("997770011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Stat Market", descr: "Магазин для проверки статистики продавца", cats: ["build"], phone: "712009988", addr: "ул. Статистики, 9", hours: "00:00–00:00", district: "chil" }, seller);
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 2, price: 70000, stock: 50 }, seller); // pricier than the market
  await call("POST", "/api/seller/offers", { product_id: 4, price: 30000, stock: 50 }, seller); // cheapest
  const ev = await call("POST", "/api/events", { events: [{ t: "view", id: 2 }, { t: "view", id: 2 }, { t: "view", id: 4 }, { t: "cart", id: 2, store: sid }, { t: "cart", id: 2, store: "usta" }, { t: "nope", id: 2 }, { t: "view", id: 99999999 }] });
  assert.equal(ev.status, 200); assert.equal(ev.data.n, 5);
  const s = (await call("GET", "/api/seller/stats?days=30", null, seller)).data;
  const p2 = s.products.find(p => p.id === 2), p4 = s.products.find(p => p.id === 4);
  assert.ok(p2.views >= 2); assert.equal(p2.carts, 1, "only adds to this store count");
  assert.ok(p2.diff > 5); assert.ok(p4.price <= p4.market_min);
  assert.equal(s.series.length, 30); assert.ok(s.series.at(-1).views >= 3);
  assert.equal(s.prices.pricier, 1); assert.equal(s.prices.cheapest, 1);
  assert.equal((await call("GET", "/api/seller/stats", null, (await login("997770022")).data.token)).status, 403);
});

test("Telegram channel: new store post, product of the day with photo, new products, price drops, admin controls", async () => {
  await until(() => tgSent.some(x => x.chat_id === "@imorat_test" && /Новый магазин/.test(x.text)));
  const ch = app.channel;
  assert.deepEqual(await ch.daily(Date.now(), true), ["day"], "first run: product of the day only, prices remembered");
  const day = tgSent.filter(x => x.chat_id === "@imorat_test" && x.m === "sendPhoto").at(-1);
  assert.match(day.caption, /Товар дня/); assert.match(day.caption, /Kun mahsuloti/); assert.match(day.photo, /^https:\/\/.+\/img\/.+\.webp$/);
  assert.match(day.reply_markup.inline_keyboard[0][0].url, /#p-\d+$/);
  // a seller drops a price and adds a product → next day both are posted
  const seller = (await login("995550011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Arzon Qurilish", descr: "Магазин для проверки канала Telegram", cats: ["build"], phone: "712005544", addr: "ул. Канальная, 1", hours: "00:00–00:00", district: "chil" }, seller);
  await call("PATCH", `/api/admin/stores/${st.data.store.id}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 3, price: 40000, stock: 10 }, seller);
  await call("POST", "/api/seller/products", { ru: "Клей для газоблока Arzon, 25 кг", cat: "build", sub: "dry", unit: "bag25", price: 39000, stock: 20, kg: 25 }, seller);
  const kinds = await ch.daily(Date.now() + 86400000, true);
  assert.ok(kinds.includes("new") && kinds.includes("drop"), JSON.stringify(kinds));
  assert.ok(tgSent.some(x => x.chat_id === "@imorat_test" && /Новинки/.test(x.text) && /Arzon/.test(x.text)));
  assert.ok(tgSent.some(x => x.chat_id === "@imorat_test" && /Цены снизились/.test(x.text) && /Шпаклёвка финишная/.test(x.text)));
  const adm = (await call("GET", "/api/admin/channel", null, globalThis.ADMIN)).data;
  assert.equal(adm.enabled, true); assert.ok(adm.last.length >= 3); assert.ok(adm.preview.length >= 1);
  assert.equal((await call("POST", "/api/admin/channel/post", { kind: "nope" }, globalThis.ADMIN)).status, 400);
  assert.equal((await call("POST", "/api/admin/channel/post", { kind: "day" }, globalThis.ADMIN)).data.posted, true);
  assert.equal((await call("GET", "/api/admin/channel", null, seller)).status, 403);
});

test("Order problems: buyer reports with a photo, store answers, moderator resolves", async () => {
  const seller = (await login("993330011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Shikoyat Test", descr: "Магазин для проверки жалоб покупателей", cats: ["build"], phone: "712003300", addr: "ул. Жалоб, 2", hours: "00:00–00:00", district: "chil" }, seller);
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 5, price: 1300, stock: 1000 }, seller);
  const buyer = (await login("993330022")).data.token, other = (await login("993330033")).data.token;
  const o = await call("POST", "/api/orders", { lines: [{ id: 5, store: sid, q: 100 }], form: { name: "Азиз", phone: "998993330022", mode: "pickup", pay: "store" } }, buyer);
  const num = o.data.order.num, ship = o.data.order.ships[0].id;
  assert.equal((await call("POST", `/api/orders/${num}/problems`, { ship_id: ship, reason: "damaged", text: "x" }, buyer)).status, 400);
  assert.equal((await call("POST", `/api/orders/${num}/problems`, { ship_id: ship, reason: "damaged", text: "Половина кирпича битая" }, other)).status, 404);
  const pr = await call("POST", `/api/orders/${num}/problems`, { ship_id: ship, reason: "damaged", text: "Половина кирпича битая" }, buyer);
  assert.equal(pr.status, 200, JSON.stringify(pr.data));
  assert.equal((await call("POST", `/api/orders/${num}/problems`, { ship_id: ship, reason: "other", text: "Ещё одна жалоба" }, buyer)).status, 409);
  const id = pr.data.problem.id;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const up = await fetch(`${base}/api/problems/${id}/photo`, { method: "POST", headers: { authorization: "Bearer " + buyer, "content-type": "image/png" }, body: png });
  assert.equal(up.status, 200); assert.equal((await up.json()).photos.length, 1);
  const bad = await fetch(`${base}/api/problems/${id}/photo`, { method: "POST", headers: { authorization: "Bearer " + buyer }, body: "not an image" });
  assert.equal(bad.status, 400);
  const sp = (await call("GET", "/api/seller/problems", null, seller)).data.problems;
  assert.equal(sp[0].reason, "damaged"); assert.equal(sp[0].phone, "998993330022");
  assert.equal((await call("POST", `/api/seller/problems/${id}/reply`, { text: "Привезём замену завтра" }, seller)).data.problem.status, "answered");
  const mine = (await call("GET", "/api/me/problems", null, buyer)).data.problems;
  assert.equal(mine[0].seller_reply, "Привезём замену завтра"); assert.equal(mine[0].phone, undefined);
  assert.equal((await call("PATCH", `/api/admin/problems/${id}`, { status: "resolved", resolution: "Магазин заменил кирпич" }, seller)).status, 403);
  assert.equal((await call("PATCH", `/api/admin/problems/${id}`, { status: "resolved", resolution: "Магазин заменил кирпич" }, globalThis.ADMIN)).data.problem.status, "resolved");
  assert.equal((await call("POST", `/api/seller/problems/${id}/reply`, { text: "ещё" }, seller)).status, 409);
});

test("Questions to a store, answers, public FAQ; verified badge", async () => {
  const seller = (await login("992220011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Savol Market", descr: "Магазин для проверки вопросов покупателей", cats: ["paint"], phone: "712002200", telegram: "@savolmarket", addr: "ул. Вопросов, 4", hours: "00:00–00:00", district: "yakka" }, seller);
  const sid = st.data.store.id;
  await call("POST", `/api/stores/${sid}/questions`, { text: "Есть ли краска?" }, (await login("992220022")).data.token).then(r => assert.equal(r.status, 404, "pending store"));
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active", verified: true }, globalThis.ADMIN);
  const cat = (await call("GET", "/api/catalog")).data.stores.find(s => s.id === sid);
  assert.equal(cat.verified, true); assert.match(cat.phone, /712002200$/); assert.equal(cat.telegram, "savolmarket");
  await call("POST", "/api/seller/offers", { product_id: 7, price: 80000, stock: 5 }, seller);
  const buyer = (await login("992220022")).data.token;
  assert.equal((await call("POST", `/api/stores/${sid}/questions`, { text: "Есть ли в наличии 20 листов?", product_id: 1 }, buyer)).status, 400, "product not sold here");
  const qq = await call("POST", `/api/stores/${sid}/questions`, { text: "Есть ли в наличии 20 листов?", product_id: 7 }, buyer);
  assert.equal(qq.status, 200, JSON.stringify(qq.data));
  assert.equal((await call("GET", `/api/stores/${sid}/questions`)).data.questions.length, 0, "unanswered questions are not public");
  const sq = (await call("GET", "/api/seller/questions", null, seller)).data.questions;
  assert.equal(sq[0].phone, "998992220022");
  assert.equal((await call("POST", `/api/seller/questions/${sq[0].id}/answer`, { text: "Да, 40 листов на складе" }, seller)).status, 200);
  const pub = (await call("GET", `/api/stores/${sid}/questions`)).data.questions;
  assert.equal(pub[0].answer, "Да, 40 листов на складе"); assert.equal(pub[0].phone, undefined);
  assert.equal((await call("GET", "/api/me/questions", null, buyer)).data.questions[0].answer, "Да, 40 листов на складе");
});
