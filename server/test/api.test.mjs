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
    if (["sendMessage", "sendPhoto", "editMessageText", "answerCallbackQuery", "editMessageReplyMarkup", "setMyCommands", "sendChatAction"].includes(m)) { tgSent.push({ m, ...b }); return json(200, { ok: true, result: { message_id: tgSent.length } }); }
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
    TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0", PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PAYME_SECRET", CLICK_SERVICE_ID: "12345", CLICK_MERCHANT_ID: "777", CLICK_SECRET_KEY: "CLICK_SECRET", PAY_TIMEOUT_MIN: "30", BACKUP_DIR: join(dir, "bk"), OTP_PER_IP_HOUR: "200", TELEGRAM_CHANNEL: "@imorat_test", CHANNEL_HOUR: "25"
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
    form: { name: "Нилуфар", phone: "+998 97 700 11 22", district: "mirob", street: "ул. Навои, 10", floor: "3", lift: true, mode: "yandex", when: "asap", pay: "payme" } };
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
  assert.equal(o.data.order.pay_status, "pending"); assert.ok(o.data.order.pay_url, "delivery is paid by card: a checkout link comes back");
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
  await until(() => tgSent.some(x => String(x.chat_id) === "555" && /подключён к магазину/.test(x.text)));
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
  // finance: build category → 4% commission
  const fin = (await call("GET", "/api/seller/summary", null, seller)).data.finance;
  assert.equal(fin.goods, 57000 * 3); assert.equal(fin.commission, Math.round(57000 * 3 * 0.04)); assert.equal(fin.balance, fin.commission);
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
  const bad = await call("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { name: "Тест", phone: "998995556677", mode: "pickup", pay: "uzum" } }, t);
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

test("Bonus points: referral code, welcome after the first delivery, capped cashback, no cashback on own store, refund on cancel", async () => {
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
  assert.equal(w.status, 200, JSON.stringify(w.data)); assert.equal(w.data.points, 0, "nothing is credited for entering a code"); assert.equal(w.data.pending_welcome, 30000);
  assert.equal((await call("POST", "/api/me/bonus/referral", { code: ab.code }, b)).status, 409);
  const form = { name: "Бобур", phone: "998996660033", mode: "pickup", pay: "store" };
  const q = await call("POST", "/api/quote", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 999999 }, b);
  assert.equal(q.data.quote.pts, 0); assert.equal(q.data.quote.total, 295000);
  const o = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 0, expected_total: 295000 }, b);
  assert.equal(o.status, 200, JSON.stringify(o.data)); assert.equal(o.data.order.pts, 0);
  const sh = (await call("GET", "/api/seller/summary", null, seller)).data.orders[0].ship_id;
  for (const s of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/seller/shipments/${sh}`, { status: s }, seller)).status, 200);
  const bb = (await call("GET", "/api/me/bonus", null, b)).data;
  assert.equal(bb.points, 30000 + 2950, "welcome bonus + 1% cashback of 295 000, both on the first delivery");
  assert.equal((await call("GET", "/api/me/bonus", null, a)).data.points, 30000, "referral reward after the friend's first delivery");
  assert.equal((await call("GET", "/api/me/bonus", null, a)).data.invited_paid, 1);
  // spend part of the points, cancel, points come back
  const o2 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form, points: 2000 }, b);
  assert.equal(o2.data.order.pts, 2000);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 30950);
  assert.equal((await call("POST", `/api/orders/${o2.data.order.num}/cancel`, null, b)).status, 200);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 32950);
  // the store owner buying from his own store earns nothing; a huge order is capped at 200 000 points
  assert.equal((await call("PATCH", "/api/seller/offers/1", { price: 9999999999 }, seller)).status, 400, "price above 100 000 000 so'm is rejected");
  await call("PATCH", "/api/seller/offers/1", { price: 50000000, stock: 500 }, seller);
  const own = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, name: "Владелец", phone: "998996660011" } }, seller);
  assert.equal(own.status, 200, JSON.stringify(own.data));
  const sh2 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === own.data.order.num).ship_id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh2}`, { status: s }, seller);
  assert.equal((await call("GET", "/api/me/bonus", null, seller)).data.points, 0, "no cashback on the owner's own store");
  const c = (await login("996660044")).data.token;
  const big = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 2 }], form: { ...form, name: "Крупный", phone: "998996660044" } }, c);
  assert.equal(big.status, 200, JSON.stringify(big.data));
  const sh3 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === big.data.order.num).ship_id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh3}`, { status: s }, seller);
  assert.equal((await call("GET", "/api/me/bonus", null, c)).data.points, 200000, "cashback capped at 200 000 per shipment");
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

test("Back in stock alert and product reviews with a photo", async () => {
  const seller = (await login("991110011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Nalichie Test", descr: "Магазин для проверки наличия и отзывов", cats: ["tools"], phone: "712001100", addr: "ул. Наличия, 1", hours: "00:00–00:00", district: "mirob" }, seller);
  const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  const np = await call("POST", "/api/seller/products", { ru: "Уровень строительный 120 см", cat: "tools", sub: "measure", unit: "pcs", price: 150000, stock: 0, kg: 1 }, seller);
  assert.equal(np.status, 200, JSON.stringify(np.data)); const pid = np.data.product.id;
  const buyer = (await login("991110022")).data.token;
  await call("POST", `/api/products/${pid}/stock-watch`, null, buyer);
  assert.deepEqual((await call("GET", "/api/me/stock-watch", null, buyer)).data.ids, [pid]);
  assert.equal(app.stockSweep(), 0, "still out of stock");
  await call("PATCH", `/api/seller/offers/${pid}`, { stock: 5 }, seller);
  assert.equal(app.stockSweep(), 1);
  assert.deepEqual((await call("GET", "/api/me/stock-watch", null, buyer)).data.ids, [], "alert sent once");
  // reviews: only after receiving the product
  let rv = (await call("GET", `/api/products/${pid}/reviews`, null, buyer)).data;
  assert.equal(rv.can_review, false);
  assert.equal((await call("POST", `/api/products/${pid}/reviews`, { stars: 5 }, buyer)).status, 403);
  const o = await call("POST", "/api/orders", { lines: [{ id: pid, store: sid, q: 1 }], form: { name: "Бобур", phone: "998991110022", mode: "pickup", pay: "store" } }, buyer);
  const sh = o.data.order.ships[0].id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh}`, { status: s }, seller);
  rv = (await call("GET", `/api/products/${pid}/reviews`, null, buyer)).data;
  assert.equal(rv.can_review, true);
  const add = await call("POST", `/api/products/${pid}/reviews`, { stars: 4, text: "Точный, но тяжеловат" }, buyer);
  assert.equal(add.status, 200);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await fetch(`${base}/api/product-reviews/${add.data.review.id}/photo`, { method: "POST", headers: { authorization: "Bearer " + buyer }, body: png })).status, 200);
  assert.equal((await call("POST", `/api/products/${pid}/reviews`, { stars: 1 }, buyer)).status, 409);
  rv = (await call("GET", `/api/products/${pid}/reviews`)).data;
  assert.equal(rv.count, 1); assert.equal(rv.stars, 4); assert.ok(rv.reviews[0].photo.includes("/uploads/")); assert.equal(rv.can_review, false);
});

test("Team projects: create, join by code, add items, notify, leave and delete", async () => {
  const boss = (await login("990001100")).data.token, worker = (await login("990001122")).data.token, stranger = (await login("990001133")).data.token;
  const cr = await call("POST", "/api/team-projects", { name: "Квартира на Чиланзаре", items: { "1|usta": 10, "999999|usta": 3, "2|nope": 1 } }, boss);
  assert.equal(cr.status, 200, JSON.stringify(cr.data));
  const pr = cr.data.project; assert.match(pr.code, /^[A-Z2-9]{6}$/); assert.deepEqual(Object.keys(pr.items), ["1|usta"]);
  assert.equal((await call("PATCH", `/api/team-projects/${pr.id}`, { add: { "5|usta": 100 } }, stranger)).status, 404);
  assert.equal((await call("POST", "/api/team-projects/join", { code: "NOPE00" }, worker)).status, 400);
  assert.equal((await call("POST", "/api/team-projects/join", { code: pr.code.toLowerCase() }, worker)).data.project.members.length, 2);
  const up = await call("PATCH", `/api/team-projects/${pr.id}`, { add: { "5|usta": 100, "1|usta": 5 } }, worker);
  assert.equal(up.data.project.items["1|usta"].q, 15); assert.equal(up.data.project.items["5|usta"].q, 100);
  const set = await call("PATCH", `/api/team-projects/${pr.id}`, { set: { "5|usta": 0 }, name: "Квартира, этап 1" }, boss);
  assert.deepEqual(Object.keys(set.data.project.items), ["1|usta"]); assert.equal(set.data.project.name, "Квартира, этап 1");
  assert.equal((await call("GET", "/api/team-projects", null, worker)).data.projects.length, 1);
  assert.equal((await call("DELETE", `/api/team-projects/${pr.id}`, null, worker)).data.deleted, false, "a member leaves");
  assert.equal((await call("GET", "/api/team-projects", null, worker)).data.projects.length, 0);
  assert.equal((await call("DELETE", `/api/team-projects/${pr.id}`, null, boss)).data.deleted, true);
});

test("Owner dashboard: totals, daily series, top products and stores, slow stores", async () => {
  assert.equal((await call("GET", "/api/admin/dashboard", null, (await login("990009988")).data.token)).status, 403);
  const d = (await call("GET", "/api/admin/dashboard?days=30", null, globalThis.ADMIN)).data;
  assert.equal(d.series.length, 30);
  assert.ok(d.totals.orders >= 3, JSON.stringify(d.totals)); assert.ok(d.totals.gmv > 0); assert.ok(d.counts.users >= 10);
  assert.ok(d.top_products.length >= 1 && d.top_products[0].sum > 0);
  assert.ok(d.top_stores.length >= 1);
  assert.equal(d.series.reduce((a, x) => a + x.orders, 0), d.totals.orders);
  assert.ok(Array.isArray(d.slow_stores));
});

test("Telegram bot: search, sign-in by contact, request to a master with buttons, rating, pause, language", async () => {
  let uid = 100;
  const send = (chat, msg) => tgUpdates.push({ update_id: ++uid, message: { chat: { id: chat, type: "private" }, from: { id: chat }, ...msg } });
  const press = (chat, data) => { const id = "q" + (++uid); tgUpdates.push({ update_id: uid, callback_query: { id, data, from: { id: chat }, message: { chat: { id: chat }, message_id: 1 } } }); return id; };
  const sentTo = (chat, re) => tgSent.filter(x => String(x.chat_id) === String(chat) && re.test(x.text || ""));
  // welcome with the menu
  send(7001, { text: "/start" });
  const w = await until(() => sentTo(7001, /Imorat/)[0]);
  assert.ok(w.reply_markup.keyboard.flat().some(b => b.request_contact), "sign-in button for a new chat");
  // search with a typo and in Uzbek Latin
  send(7001, { text: "перфаратор" });
  const s1 = await until(() => sentTo(7001, /Нашли/)[0]);
  assert.match(s1.text, /Исправили опечатку: <b>перфоратор/); assert.match(s1.text, /Перфоратор/);
  assert.match(s1.reply_markup.inline_keyboard[0][0].url, /#p-\d+$/);
  send(7001, { text: "sement" });
  await until(() => sentTo(7001, /Нашли[\s\S]*Цемент/).length);
  // a stranger's contact is refused, own contact signs in (new user)
  send(7001, { contact: { phone_number: "+998901112233", user_id: 999, first_name: "X" } });
  await until(() => sentTo(7001, /свой номер/).length);
  // masters need an approved profile and a linked chat
  const mt = (await login("994440077")).data.token;
  const prof = await call("POST", "/api/masters/me", { name: "Ильхом Электрик", specs: ["elec"], districts: ["yunus"], exp: 5, price: 60000, price_unit: "pt", about: "Проводка под ключ" }, mt);
  const mid = prof.data.master.id;
  await call("PATCH", `/api/admin/masters/${mid}`, { status: "active" }, globalThis.ADMIN);
  send(7002, { contact: { phone_number: "998994440077", user_id: 7002, first_name: "Ильхом" } });
  const mk = await until(() => sentTo(7002, /Вы вошли/)[0]);
  assert.ok(mk.reply_markup.keyboard.flat().some(b => /Мои заявки/.test(b.text)), "masters get the requests button");
  // the buyer picks a trade and a master, before signing in: asked to sign in, then the flow continues
  send(7001, { text: "🧰 Мастера" });
  await until(() => sentTo(7001, /Какой мастер нужен/).length);
  press(7001, "ms:elec");
  const lst = await until(() => sentTo(7001, /Ильхом Электрик/)[0]);
  const mq = lst.reply_markup.inline_keyboard[0][0].callback_data; assert.equal(mq, "mq:" + mid);
  press(7001, mq);
  await until(() => sentTo(7001, /Сначала войдите/).length);
  send(7001, { contact: { phone_number: "+998901112233", user_id: 7001, first_name: "Азиз", last_name: "Т" } });
  await until(() => sentTo(7001, /Опишите работу/).length);
  send(7001, { text: "Поменять 6 розеток и выключатели в квартире" });
  await until(() => sentTo(7001, /Когда нужно/).length);
  press(7001, "wh:tomorrow");
  await until(() => sentTo(7001, /Район/).length);
  press(7001, "di:yunus");
  await until(() => sentTo(7001, /Заявка №\d+ отправлена/).length);
  // the master sees it with buttons and accepts right in Telegram
  const card = await until(() => sentTo(7002, /Новая заявка/)[0]);
  assert.match(card.text, /6 розеток/); assert.match(card.text, /\+998901112233/);
  const acc = card.reply_markup.inline_keyboard[0][0].callback_data; assert.match(acc, /^mr:acc:\d+$/);
  const rid = acc.split(":")[2];
  press(7001, acc); // a stranger cannot accept
  await until(() => tgSent.some(x => x.m === "answerCallbackQuery" && /не ваша/.test(x.text)));
  press(7002, acc);
  await until(() => sentTo(7001, /принял вашу заявку[\s\S]*\+998994440077/).length);
  press(7002, `mr:done:${rid}`);
  const rate = await until(() => sentTo(7001, /выполненной/)[0]);
  assert.equal(rate.reply_markup.inline_keyboard[0][4].callback_data, `rv:${rid}:5`);
  press(7001, `rv:${rid}:5`);
  await until(() => sentTo(7001, /пару слов/).length);
  send(7001, { text: "Пришёл вовремя, всё аккуратно" });
  await until(() => sentTo(7002, /⭐⭐⭐⭐⭐[\s\S]*вовремя/).length);
  const pubm = (await call("GET", `/api/masters/${mid}`)).data;
  assert.equal(pubm.master.stars, 5); assert.equal(pubm.reviews[0].text, "Пришёл вовремя, всё аккуратно");
  // pause hides the master from the public list
  send(7002, { text: "⏸ Пауза для заявок" });
  await until(() => sentTo(7002, /Пауза включена/).length);
  assert.ok(!(await call("GET", "/api/masters?spec=elec")).data.masters.some(m => m.id === mid));
  send(7002, { text: "▶️ Снова принимать заявки" });
  await until(() => sentTo(7002, /снова принимаете/).length);
  assert.ok((await call("GET", "/api/masters?spec=elec")).data.masters.some(m => m.id === mid));
  // orders and bonuses for a signed-in chat; language switch
  send(7001, { text: "/orders" });
  await until(() => sentTo(7001, /Заказов пока нет/).length);
  send(7001, { text: "/bonus" });
  await until(() => sentTo(7001, /Ваш код для друзей/).length);
  send(7001, { text: "🌐 Özbekça" });
  const uzm = await until(() => sentTo(7001, /Til: özbekça/)[0]);
  assert.ok(uzm.reply_markup.keyboard.flat().some(b => b.text === "🔎 Mahsulot qidiriş"));
  send(7001, { text: "laminat" });
  await until(() => sentTo(7001, /Topildi[\s\S]*Laminat/).length);
});

test("Card payment: Payme and Click callbacks, store sees the order only after the money, unpaid orders expire", async () => {
  const { createHash } = await import("node:crypto");
  const seller = (await login("998880011")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Karta Market", descr: "Магазин для проверки онлайн-оплаты картой", cats: ["build"], phone: "712004455", addr: "ул. Картовая, 7", hours: "00:00–00:00", district: "yunus" }, seller);
  assert.equal(st.status, 200, JSON.stringify(st.data)); const sid = st.data.store.id;
  await call("PATCH", `/api/admin/stores/${sid}`, { status: "active" }, globalThis.ADMIN);
  await call("POST", "/api/seller/offers", { product_id: 1, price: 60000, stock: 20 }, seller);
  const cfgR = (await call("GET", "/api/config")).data;
  assert.deepEqual(cfgR.payments, ["payme", "click"], "both providers offered once their keys are set");
  const buyer = (await login("998880022")).data.token;
  const form = { name: "Карта", phone: "998998880022", mode: "pickup", pay: "payme" };
  // --- Payme: order waits for the money
  const o = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 2 }], form }, buyer);
  assert.equal(o.status, 200, JSON.stringify(o.data) + " store=" + JSON.stringify(st.data.store));
  const num = o.data.order.num, total = o.data.order.total;
  assert.equal(o.data.order.pay_status, "pending"); assert.match(o.data.order.pay_url, /^https:\/\/checkout\.paycom\.uz\//);
  const payload = Buffer.from(o.data.order.pay_url.replace("https://checkout.paycom.uz/", ""), "base64").toString();
  assert.ok(payload.startsWith(`m=5e730e8e0b852a417aa49ceb;ac.order=${num};a=${total * 100};c=`), payload);
  assert.ok((await call("GET", "/api/seller/summary", null, seller)).data.orders.every(x => x.num !== num), "the store does not see an unpaid order");
  const stock0 = (await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(x => x.store === sid).stock;
  assert.equal(stock0, 18, "stock is reserved while the payment is pending");
  const rpc = (method, params, auth = "Paycom:PAYME_SECRET") => fetch(base + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(auth).toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  assert.equal((await rpc("CheckPerformTransaction", { amount: total * 100, account: { order: num } }, "Paycom:wrong")).error.code, -32504);
  assert.equal((await rpc("CheckPerformTransaction", { amount: total * 100 + 100, account: { order: num } })).error.code, -31001);
  assert.equal((await rpc("CheckPerformTransaction", { amount: total * 100, account: { order: "IM-1" } })).error.code, -31050);
  assert.deepEqual((await rpc("CheckPerformTransaction", { amount: total * 100, account: { order: num } })).result, { allow: true });
  const t1 = Date.now();
  const cr = await rpc("CreateTransaction", { id: "pm-1", time: t1, amount: total * 100, account: { order: num } });
  assert.equal(cr.result.state, 1); assert.equal(cr.result.create_time, t1);
  const cr2 = await rpc("CreateTransaction", { id: "pm-1", time: t1 + 5, amount: total * 100, account: { order: num } });
  assert.equal(cr2.result.transaction, cr.result.transaction, "idempotent create");
  assert.equal((await rpc("CreateTransaction", { id: "pm-2", time: t1, amount: total * 100, account: { order: num } })).error.code, -31008, "one open transaction per order");
  const pf = await rpc("PerformTransaction", { id: "pm-1" });
  assert.equal(pf.result.state, 2);
  const paid = (await call("GET", `/api/orders/${num}`, null, buyer)).data.order;
  assert.equal(paid.pay_status, "paid"); assert.equal(paid.pay_url, null); assert.ok(paid.paid_at);
  const sv = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === num);
  assert.ok(sv, "the store sees the order once it is paid"); assert.equal(sv.status, "new"); assert.equal(sv.pay_status, "paid");
  assert.equal((await rpc("PerformTransaction", { id: "pm-1" })).result.state, 2, "idempotent perform");
  assert.equal((await rpc("CheckTransaction", { id: "pm-1" })).result.state, 2);
  const stt = await rpc("GetStatement", { from: t1 - 1000, to: Date.now() + 1000 });
  assert.equal(stt.result.transactions.length, 1); assert.equal(stt.result.transactions[0].account.order, num);
  // refund while the store has not started: order cancelled, stock back
  const cn = await rpc("CancelTransaction", { id: "pm-1", reason: 5 });
  assert.equal(cn.result.state, -2);
  assert.equal((await call("GET", `/api/orders/${num}`, null, buyer)).data.order.pay_status, "refunded");
  assert.equal((await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(x => x.store === sid).stock, 20);
  // --- Click: prepare + complete with signatures
  const o2 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, pay: "click" } }, buyer);
  assert.equal(o2.status, 200, JSON.stringify(o2.data)); const num2 = o2.data.order.num, total2 = o2.data.order.total;
  assert.match(o2.data.order.pay_url, /^https:\/\/my\.click\.uz\/services\/pay\?service_id=12345&merchant_id=777&amount=/);
  const md5 = x => createHash("md5").update(x).digest("hex");
  const post = body => fetch(base + "/api/pay/click", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }).then(r => r.json());
  const signTime = "2026-10-31 10:00:00", amount = total2 + ".00";
  const bad = await post({ click_trans_id: "9001", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, amount, action: "0", error: "0", error_note: "", sign_time: signTime, sign_string: "deadbeef" });
  assert.equal(bad.error, -1);
  const prep = await post({ click_trans_id: "9001", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, amount, action: "0", error: "0", error_note: "", sign_time: signTime, sign_string: md5(`9001` + `12345` + "CLICK_SECRET" + num2 + amount + "0" + signTime) });
  assert.equal(prep.error, 0, JSON.stringify(prep)); assert.ok(prep.merchant_prepare_id);
  const wrongAmt = await post({ click_trans_id: "9002", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, amount: "1.00", action: "0", error: "0", error_note: "", sign_time: signTime, sign_string: md5(`9002` + `12345` + "CLICK_SECRET" + num2 + "1.00" + "0" + signTime) });
  assert.equal(wrongAmt.error, -2);
  const comp = await post({ click_trans_id: "9001", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, merchant_prepare_id: String(prep.merchant_prepare_id), amount, action: "1", error: "0", error_note: "", sign_time: signTime, sign_string: md5(`9001` + `12345` + "CLICK_SECRET" + num2 + prep.merchant_prepare_id + amount + "1" + signTime) });
  assert.equal(comp.error, 0, JSON.stringify(comp)); assert.ok(comp.merchant_confirm_id);
  assert.equal((await call("GET", `/api/orders/${num2}`, null, buyer)).data.order.pay_status, "paid");
  const sh2 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === num2);
  assert.ok(sh2, "the store sees the Click order once paid");
  assert.equal((await call("PATCH", `/api/seller/shipments/${sh2.ship_id}`, { status: "assembling" }, seller)).status, 200);
  // --- an unpaid order expires after PAY_TIMEOUT_MIN and frees the stock
  const o3 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 5 }], form }, buyer);
  assert.equal(o3.status, 200, JSON.stringify(o3.data)); const num3 = o3.data.order.num;
  assert.equal((await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(x => x.store === sid).stock, 14);
  app.sweep(Date.now() + 31 * 60000);
  const gone = (await call("GET", `/api/orders/${num3}`, null, buyer)).data.order;
  assert.equal(gone.status, "cancelled"); assert.equal(gone.pay_url, null);
  assert.equal((await call("GET", "/api/catalog")).data.products.find(p => p.id === 1).offers.find(x => x.store === sid).stock, 19);
  assert.equal((await call("GET", `/api/orders/${num3}/pay`, null, buyer)).status, 409);
  // a provider without keys is refused
  assert.equal((await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, pay: "uzum" } }, buyer)).status, 400);
  // delivery must be paid by card; cash stays for pickup
  const cashDel = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, pay: "store", mode: "yandex", street: "ул. Навои, 10", district: "yunus" } }, buyer);
  assert.equal(cashDel.data.error, "card_required");
  assert.equal((await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, pay: "store", mode: "pickup" } }, buyer)).status, 200);
});

test("Finance with card payments: money held once, a partner's share survives another store's cancellation, admin can mark an order paid", async () => {
  const sellerA = (await login("998880033")).data.token, sellerB = (await login("998880044")).data.token;
  const mk = async (tok, name) => { const r = await call("POST", "/api/seller/store", { name, descr: "Магазин для проверки финансов по картам", cats: ["build"], phone: "712004466", addr: "ул. Финансовая, 1", hours: "00:00–00:00", district: "chil" }, tok); assert.equal(r.status, 200, JSON.stringify(r.data)); await call("PATCH", `/api/admin/stores/${r.data.store.id}`, { status: "active" }, globalThis.ADMIN); return r.data.store.id; };
  const A = await mk(sellerA, "Fin A"), B = await mk(sellerB, "Fin B");
  await call("POST", "/api/seller/offers", { product_id: 1, price: 100000, stock: 50 }, sellerA);
  await call("POST", "/api/seller/offers", { product_id: 2, price: 100000, stock: 50 }, sellerB);
  const buyer = (await login("998880055")).data.token;
  const form = { name: "Финансы", phone: "998998880055", mode: "pickup", pay: "payme" };
  const rpc = (method, params) => fetch(base + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PAYME_SECRET").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  const pay = async (o, id) => { await rpc("CreateTransaction", { id, time: Date.now(), amount: o.total * 100, account: { order: o.num } }); const r = await rpc("PerformTransaction", { id }); assert.equal(r.result?.state, 2, JSON.stringify(r)); };
  const fin = async (tok) => (await call("GET", "/api/seller/summary", null, tok)).data.finance;
  const ship = async (tok, num) => (await call("GET", "/api/seller/summary", null, tok)).data.orders.find(x => x.num === num);
  const advance = async (tok, num, states) => { const s = await ship(tok, num); for (const st of states) assert.equal((await call("PATCH", `/api/seller/shipments/${s.ship_id}`, { status: st }, tok)).status, 200, st); };
  // 1) one store, 100 000 by card, commission 4% = 4 000: Imorat Go holds 100 000 and owes the store 96 000 — not 92 000
  const o1 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order;
  await pay(o1, "fin-1"); await advance(sellerA, o1.num, ["assembling", "ready", "picked"]);
  let f = await fin(sellerA);
  assert.equal(f.payout_due, 96000); assert.equal(f.commission_total, 4000); assert.equal(f.balance, -96000, "card money is counted once");
  // 2) two stores in one order; A hands over, B cancels: A's share stays, the order is flagged for a partial refund
  const o2 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }, { id: 2, store: B, q: 1 }], form }, buyer)).data.order;
  await pay(o2, "fin-2"); await advance(sellerA, o2.num, ["assembling", "ready", "picked"]);
  assert.equal((await fin(sellerA)).payout_due, 192000);
  const sb = await ship(sellerB, o2.num); assert.equal((await call("PATCH", `/api/seller/shipments/${sb.ship_id}`, { status: "cancelled", reason: "out_of_stock" }, sellerB)).status, 200);
  assert.equal((await call("GET", `/api/orders/${o2.num}`, null, buyer)).data.order.pay_status, "refund_due");
  f = await fin(sellerA); assert.equal(f.payout_due, 192000, "A keeps its share after B's cancellation"); assert.equal(f.balance, -192000);
  assert.equal((await fin(sellerB)).payout_due, 0);
  // 3) the admin marks an order paid by hand: the store gets it like after a bank callback
  const o3 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order;
  assert.equal(await ship(sellerA, o3.num), undefined);
  assert.equal((await call("PATCH", `/api/admin/orders/${o3.num}/pay`, { pay_status: "paid" }, globalThis.ADMIN)).status, 200);
  const s3 = await ship(sellerA, o3.num); assert.ok(s3, "the store sees the order"); assert.equal(s3.status, "new");
  const got = (await call("GET", `/api/orders/${o3.num}`, null, buyer)).data.order; assert.equal(got.pay_status, "paid"); assert.ok(got.paid_at);
  await advance(sellerA, o3.num, ["assembling"]); app.sweep(Date.now() + 31 * 60000);
  assert.equal((await call("GET", `/api/orders/${o3.num}`, null, buyer)).data.order.status, "active", "a paid order is not expired by the payment sweep");
});
