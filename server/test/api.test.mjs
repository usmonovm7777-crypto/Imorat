import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp, addMonthsClamped } from "../src/app.js";
import { totp } from "../src/totp.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { createECDH, createDecipheriv, hkdfSync } from "node:crypto";

/* ---- fake external services: Eskiz, Yandex, Anthropic, Google JWKS ---- */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const sms = [], tgSent = [], tgUpdates = [], pushes = [], yaClaims = [], yaCancels = [], geoHits = [], fcmSent = [], apnsSent = [];
const fake = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks), body = raw.toString("utf8");
  const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/eskiz/auth/login") return json(200, { data: { token: "T" } });
  if (req.url === "/eskiz/message/sms/send") { sms.push(body); return json(200, { id: "1", status: "waiting" }); }
  if (req.url === "/ya/b2b/cargo/integration/v2/check-price") { const b = JSON.parse(body); if (/NOPRICE/.test(b.route_points[1].fullname)) return json(400, { code: "bad_request", message: "route outside the zone" }); return json(200, { price: b.requirements.taxi_class === "express" ? "21000.00" : "99000.00", eta: 30 }); }
  // Yandex claims: create → accept → info (status advances on every call) → tracking link → performer position
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/create")) { const b = JSON.parse(body); if (b.client_requirements.cargo_loaders && /NOLOADER/.test(b.route_points[1].address.fullname)) return json(400, { code: "bad_request", message: "no loaders for this tariff" }); yaClaims.push({ body: b, infos: 0 }); return json(200, { id: "claim-" + yaClaims.length, version: 1, status: "new" }); }
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/accept")) return json(200, { id: "x", status: "ready_for_approval" });
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/cancel-info")) return json(200, { cancel_state: "paid" });
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/cancel?")) { yaCancels.push({ url: req.url, body: JSON.parse(body) }); return json(200, { id: "x", status: "cancelled_with_payment" }); }
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/tracking-links")) return json(200, { route_points: [{ type: "destination", sharing_url: "https://taxi.yandex.ru/route/abc" }] });
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/info")) { const c = yaClaims[Number(req.url.match(/claim-(\d+)/)[1]) - 1]; const seq = ["performer_found", "pickuped", "delivered_finish"]; const st = seq[Math.min(seq.length - 1, c.infos++)]; return json(200, { id: "x", status: st, performer_info: { courier_name: "Шерзод", car_model: "Chevrolet Labo", car_number: "01A123BC" } }); }
  if (req.url.startsWith("/ya/b2b/cargo/integration/v2/claims/performer-position")) return json(200, { position: { lat: 41.3, lon: 69.25, speed: 10, direction: 90, timestamp: Math.floor(Date.now() / 1000), dist_to_point: 1200 } });
  // address search: a fake Nominatim and a fake Yandex geocoder (the geo module picks one by the key)
  if (req.url.startsWith("/nom/search")) { geoHits.push(req.url + "|" + req.headers["user-agent"]); const q = decodeURIComponent(req.url.match(/[?&]q=([^&]*)/)[1]); return json(200, /навои/i.test(q) ? [{ lat: "41.3115", lon: "69.2401", display_name: "10, улица Навои, Шайхантахурский район, Ташкент", addresstype: "building", address: { road: "улица Навои", house_number: "10", suburb: "Шайхантахур", city_district: "Шайхантахурский район" } }, { lat: "41.33", lon: "69.26", display_name: "улица Навои, Ташкент", addresstype: "road", address: { road: "улица Навои" } }] : []); }
  if (req.url.startsWith("/nom/reverse")) { geoHits.push(req.url); return json(200, { lat: "41.311", lon: "69.279", display_name: "15, проспект Амира Темура", address: { road: "проспект Амира Темура", house_number: "15", suburb: "Юнусабад" } }); }
  if (req.url.startsWith("/geocode/1.x/")) { geoHits.push(req.url); const g = decodeURIComponent(req.url.match(/geocode=([^&]*)/)[1]); return json(200, { response: { GeoObjectCollection: { featureMember: [{ GeoObject: { name: /,/.test(g) && !/[а-я]/i.test(g) ? "проспект Амира Темура, 15" : "улица Навои, 10", description: "Ташкент", Point: { pos: "69.2401 41.3115" }, metaDataProperty: { GeocoderMetaData: { kind: "house", text: "Узбекистан, Ташкент, улица Навои, 10", Address: { formatted: "Ташкент, улица Навои, 10", Components: [{ kind: "locality", name: "Ташкент" }, { kind: "district", name: "Шайхантахурский район" }, { kind: "street", name: "улица Навои" }, { kind: "house", name: "10" }] } } } } }] } } }); }
  if (req.url === "/jwks") return json(200, { keys: [jwk] });
  // Firebase Cloud Messaging v1: the OAuth token exchange and the send endpoint
  if (req.url === "/fcm/token") { const p = new URLSearchParams(body); assert.equal(p.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer"); assert.equal(p.get("assertion").split(".").length, 3); return json(200, { access_token: "fcm-access", expires_in: 3600 }); }
  if (req.url === "/fcm/v1/projects/test-proj/messages:send") { assert.equal(req.headers.authorization, "Bearer fcm-access"); const m = JSON.parse(body).message; fcmSent.push(m); return m.token === "android-dead-token-0000000000" ? json(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) : json(200, { name: "projects/test-proj/messages/1" }); }
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

let app, base, fakeBase, dir, apns, apnsBase;
import { createServer as createH2 } from "node:http2";
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
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
  // a plain HTTP/2 server standing in for api.push.apple.com
  apns = createH2(); apns.on("stream", (st, h) => { let b = ""; st.on("data", c => { b += c; }); st.on("end", () => { apnsSent.push({ path: h[":path"], topic: h["apns-topic"], auth: h.authorization, type: h["apns-push-type"], body: JSON.parse(b) }); const dead = h[":path"].endsWith("/ios-dead-token-00000000000000"); st.respond({ ":status": dead ? 410 : 200 }); st.end(dead ? JSON.stringify({ reason: "Unregistered" }) : ""); }); });
  await new Promise(r => apns.listen(0, "127.0.0.1", r)); apnsBase = `http://127.0.0.1:${apns.address().port}`;
  dir = mkdtempSync(join(tmpdir(), "imorat-"));
  const cfg = loadConfig({
    JWT_SECRET: "test-secret", DB_PATH: join(dir, "t.db"), UPLOADS_DIR: join(dir, "up"), ADMIN_PHONES: "998901111111",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_JWKS_URL: fakeBase + "/jwks", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_URL: fakeBase + "/ai", SMS_MODE: "dev",
    TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0", PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PAYME_SECRET", CLICK_SERVICE_ID: "12345", CLICK_MERCHANT_ID: "777", CLICK_SECRET_KEY: "CLICK_SECRET", PAY_TIMEOUT_MIN: "30", BACKUP_DIR: join(dir, "bk"), OTP_PER_IP_HOUR: "200", TELEGRAM_CHANNEL: "@imorat_test", CHANNEL_HOUR: "25",
    ALLOW_PAY_AT_STORE: "1", BONUS_ON: "1", PROMO_MONTHS: "0", DISCOUNTS_ON: "1", // most scenarios below pay the store on pickup; the card-only default and the free months have their own checks
    OWNER_LOGIN: "umv_test", OWNER_PASSWORD_HASH: hashPassword("Owner-Pass-123!"), // the owner's password sign-in (the hash lives in .env on a real server)
    REVIEW_ACCOUNTS: "998900000001:246810", PRODUCT_AUTO_APPROVE: "1", // most scenarios publish at once; "Moderation" below switches the check on
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "svc@test-proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), project_id: "test-proj", token_uri: fakeBase + "/fcm/token" }), FCM_URL: fakeBase + "/fcm",
    APNS_KEY_P8: apnsKey, APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM42", APNS_URL: apnsBase
  });
  app = createApp(cfg, { info() {}, warn() {}, error: console.error }); globalThis.CFG = cfg;
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.stopJobs(); app.close(); app.closeAllConnections(); fake.close(); fake.closeAllConnections(); apns.close(); app.db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

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
  assert.equal((await call("POST", `/api/orders/${o.data.order.num}/cancel`, { reason: "nope" }, data.token)).data.error, "bad_reason");
  assert.equal((await call("POST", `/api/orders/${o.data.order.num}/cancel`, { reason: "other", comment: "" }, data.token)).data.error, "comment_required", "«другое» needs a word of explanation");
  const c = await call("POST", `/api/orders/${o.data.order.num}/cancel`, { reason: "cheaper", comment: "нашёл в соседнем магазине" }, data.token);
  assert.equal(c.data.order.status, "cancelled"); assert.equal(c.data.order.ships[0].cancel_note, "нашёл дешевле: нашёл в соседнем магазине");
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

test("Bulky goods: the vehicle follows the longest item, not only the weight; sellers can give package sizes", async () => {
  const t = (await login("993330001")).data.token;
  const form = { name: "Длинный", phone: "998993330001", mode: "yandex", district: "yunus", street: "ул. Длинная, 1" };
  const q = async lines => (await call("POST", "/api/quote", { lines, form }, t)).data.quote;
  const cat = (await call("GET", "/api/catalog")).data.products, P = id => cat.find(p => p.id === id);
  assert.deepEqual(P(13).dims, [6, 0.1, 0.05], "6-metre timber carries its package size"); assert.equal(P(1).dims, null, "a cement bag has none");
  assert.equal((await q([{ id: 1, store: "usta", q: 1 }])).ships[0].tariff, "cargo_s", "50 kg → small van by weight");
  assert.equal((await q([{ id: 8, store: "usta", q: 1 }])).ships[0].tariff, "cargo_s", "a 1.4 kg but 3-metre profile does not fit a car");
  const long = await q([{ id: 13, store: "usta", q: 1 }]); assert.equal(long.ships[0].tariff, "cargo_l", "6-metre timber → large van"); assert.equal(long.ships[0].len, 6);
  assert.equal((await q([{ id: 37, store: "santex", q: 1 }])).ships[0].tariff, "courier", "a fittings set is a small parcel even in the pipes subcategory");
  // a seller's own product with its package size in centimetres
  const seller = (await login("993330002")).data.token;
  const st = await call("POST", "/api/seller/store", { name: "Uzun Mollar", descr: "Магазин длинных товаров для проверки габаритов", cats: ["build"], phone: "712003300", addr: "ул. Габаритная, 2", hours: "09:00–18:00", district: "chil" }, seller);
  assert.equal((await call("PATCH", `/api/admin/stores/${st.data.store.id}`, { status: "active" }, globalThis.ADMIN)).status, 200);
  const np = await call("POST", "/api/seller/products", { ru: "Плинтус МДФ 2,4 м", cat: "build", sub: "wood", unit: "pcs", price: 45000, stock: 20, kg: 0.8, dims_cm: [240, 8, 2] }, seller);
  assert.equal(np.status, 200, JSON.stringify(np.data));
  const own = (await call("GET", "/api/catalog")).data.products.find(p => p.id === np.data.product.id); assert.deepEqual(own.dims, [2.4, 0.08, 0.02]);
  assert.equal((await q([{ id: np.data.product.id, store: st.data.store.id, q: 2 }])).ships[0].tariff, "cargo_s", "1.6 kg of skirting, 2.4 m long → small van");
  // the length alone is enough (the seller's form asks only for it): width and height default to 10 cm; a bad length means "not given"
  const np2 = await call("POST", "/api/seller/products", { ru: "Труба ПВХ 3 м", cat: "build", sub: "wood", unit: "pcs", price: 25000, stock: 20, kg: 1.2, len_cm: 300 }, seller); assert.equal(np2.status, 200, JSON.stringify(np2.data));
  assert.deepEqual((await call("GET", "/api/catalog")).data.products.find(p => p.id === np2.data.product.id).dims, [3, 0.1, 0.1]);
  const np3 = await call("POST", "/api/seller/products", { ru: "Без габаритов", cat: "build", sub: "wood", unit: "pcs", price: 25000, stock: 20, kg: 1.2, len_cm: "abc", wid_cm: 5 }, seller); assert.equal(np3.status, 200);
  assert.equal(app.db.get("SELECT dims FROM products WHERE id=?", np3.data.product.id).dims, null, "nothing stored"); assert.deepEqual((await call("GET", "/api/catalog")).data.products.find(p => p.id === np3.data.product.id).dims, [3, 0.15, 0.1], "the catalogue shows the typical size of the subcategory");
});

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
  // finance: a reservation paid at the store is free for the store — no commission, nothing owed either way
  const fin = (await call("GET", "/api/seller/summary", null, seller)).data.finance;
  assert.equal(fin.goods, 57000 * 3); assert.equal(fin.commission, 0); assert.equal(fin.balance, 0); assert.equal(fin.payout_available, 0);
  const af = await call("GET", "/api/admin/finance", null, globalThis.ADMIN);
  assert.ok(af.data.stores.some(x => x.id === sid && x.goods === fin.goods && x.commission === 0));
  await call("POST", "/api/admin/settlements", { store_id: sid, amount: 1000, note: "Корректировка" }, globalThis.ADMIN);
  assert.equal((await call("GET", "/api/seller/summary", null, seller)).data.finance.balance, -1000);
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
  // Price freshness: every offer carries the date the seller last edited or confirmed it; a week of silence is "stale",
  // the seller is reminded in Telegram once a week, and "Всё актуально" stamps the whole list without changing a price
  const offer = async () => (await call("GET", "/api/catalog")).data.products.find(p => p.id === 3).offers.find(x => x.store === sid);
  assert.ok((await offer()).upd > Date.now() / 1000 - 60, "a fresh offer shows today's confirmation");
  let pf = (await call("GET", "/api/seller/summary", null, seller)).data.prices; assert.equal(pf.days, 0); assert.equal(pf.stale, false);
  app.db.run("UPDATE offers SET updated_at=? WHERE store_id=?", Date.now() - 10 * 86400000, sid); app.db.setMeta("catalog_rev", Date.now());
  pf = (await call("GET", "/api/seller/summary", null, seller)).data.prices; assert.equal(pf.days, 10); assert.equal(pf.stale, true);
  app.db.run("UPDATE users SET tg_chat='777' WHERE phone='998990001111'");
  const before = tgSent.length; app.sweep(Date.now()); app.sweep(Date.now());
  await until(() => tgSent.slice(before).some(x => x.chat_id === "777" && /не подтверждались 10 дн/.test(x.text)));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(tgSent.slice(before).filter(x => x.chat_id === "777" && /не подтверждались/.test(x.text)).length, 1, "one reminder, not one per sweep");
  const cf = await call("POST", "/api/seller/offers/confirm", {}, seller); assert.equal(cf.status, 200);
  assert.ok((await offer()).upd >= Math.floor(cf.data.prices_confirmed_at / 1000), "the confirmation date reaches the catalog"); assert.equal((await offer()).price, 60000, "confirming changes no price");
  pf = (await call("GET", "/api/seller/summary", null, seller)).data.prices; assert.equal(pf.days, 0); assert.equal(pf.stale, false);
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
  // points are earned on orders paid through the platform, so these orders are paid by card (Payme test keys)
  const form = { name: "Бобур", phone: "998996660033", mode: "pickup", pay: "payme" };
  const rpcB = (method, params) => fetch(base + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PAYME_SECRET").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  let payN = 0; const payNow = async o => { const id = "bonus-" + (++payN); await rpcB("CreateTransaction", { id, time: Date.now(), amount: o.total * 100, account: { order: o.num } }); const r = await rpcB("PerformTransaction", { id }); assert.equal(r.result?.state, 2, JSON.stringify(r)); };
  // a reservation paid at the store earns nothing — the platform earns nothing on it either
  const res0 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, pay: "store" } }, b);
  assert.equal(res0.status, 200, JSON.stringify(res0.data));
  const sh0 = (await call("GET", "/api/seller/summary", null, seller)).data.orders[0].ship_id;
  for (const st of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/seller/shipments/${sh0}`, { status: st }, seller)).status, 200);
  assert.equal((await call("GET", "/api/me/bonus", null, b)).data.points, 0, "no cashback and no welcome bonus on a reservation paid at the store");
  const q = await call("POST", "/api/quote", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 999999 }, b);
  assert.equal(q.data.quote.pts, 0); assert.equal(q.data.quote.total, 295000);
  const o = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 5 }], form, points: 0, expected_total: 295000 }, b);
  assert.equal(o.status, 200, JSON.stringify(o.data)); assert.equal(o.data.order.pts, 0); await payNow(o.data.order);
  const sh = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === o.data.order.num).ship_id;
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
  assert.equal(own.status, 200, JSON.stringify(own.data)); await payNow(own.data.order);
  const sh2 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === own.data.order.num).ship_id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh2}`, { status: s }, seller);
  assert.equal((await call("GET", "/api/me/bonus", null, seller)).data.points, 0, "no cashback on the owner's own store");
  const c = (await login("996660044")).data.token;
  const big = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 2 }], form: { ...form, name: "Крупный", phone: "998996660044" } }, c);
  assert.equal(big.status, 200, JSON.stringify(big.data)); await payNow(big.data.order);
  const sh3 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === big.data.order.num).ship_id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh3}`, { status: s }, seller);
  assert.equal((await call("GET", "/api/me/bonus", null, c)).data.points, 200000, "cashback capped at 200 000 per shipment");
  // points cannot breed points: the part of an order paid with points earns no cashback
  await call("PATCH", "/api/seller/offers/1", { price: 100000, stock: 500 }, seller);
  const o4 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 10 }], form: { ...form, name: "Крупный", phone: "998996660044" }, points: 200000 }, c); // 10 × 97 000 (−3% wholesale tier) = 970 000 goods, 194 000 (20%) in points
  assert.equal(o4.status, 200, JSON.stringify(o4.data)); assert.equal(o4.data.order.pts, 194000); await payNow(o4.data.order);
  const sh4 = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === o4.data.order.num).ship_id;
  for (const s of ["assembling", "ready", "picked"]) await call("PATCH", `/api/seller/shipments/${sh4}`, { status: s }, seller);
  assert.equal((await call("GET", "/api/me/bonus", null, c)).data.points, 6000 + 7760, "1% of the 776 000 actually paid, not of 970 000 (6 000 left after spending)");
  // the same status event twice never pays twice (the shipment is already handed over, the API refuses; the ledger holds one entry)
  assert.equal((await call("PATCH", `/api/seller/shipments/${sh4}`, { status: "picked" }, seller)).status, 400);
  assert.equal((await call("GET", "/api/me/bonus", null, c)).data.log.filter(x => x.ref === "ship:" + sh4).length, 1);
  // an order whose card payment never arrived cannot be handed over, so it never earns points
  const o5 = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { ...form, name: "Крупный", phone: "998996660044" } }, c);
  assert.equal(o5.status, 200); assert.equal(await (async () => (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === o5.data.order.num))(), undefined, "the store does not see an unpaid order");
  const unpaidShip = (await call("GET", `/api/orders/${o5.data.order.num}`, null, c)).data.order.ships[0].id;
  assert.equal((await call("PATCH", `/api/admin/shipments/${unpaidShip}`, { status: "picked" }, globalThis.ADMIN)).data.error, "unpaid");
  assert.equal((await call("GET", "/api/me/bonus", null, c)).data.points, 13760);
  // the VIP plan is gone: it cannot be turned on, the checkout promises no VIP cashback, and an order earns the ordinary 1%
  const v = (await login("996660055")).data.token;
  const von = await call("POST", "/api/me/vip", { on: true }, v);
  assert.equal(von.status, 410); assert.equal(von.data.error, "vip_removed");
  assert.equal((await call("POST", "/api/me/vip", { on: false }, v)).status, 200, "older app builds may still send off");
  assert.equal((await call("GET", "/api/me", null, v)).data.user.vip, undefined);
  const qv = (await call("POST", "/api/quote", { lines: [{ id: 1, store: sid, q: 2 }], form: { ...form, name: "Без VIP", phone: "998996660055" } }, v)).data.quote;
  assert.ok(qv.goods > 0); assert.equal(qv.cash, 0, "no VIP cashback is promised");
  assert.equal((await call("GET", "/api/me/bonus", null, v)).data.rate_vip, undefined);
  const ov = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 2 }], form: { ...form, name: "Без VIP", phone: "998996660055" } }, v);
  assert.equal(ov.status, 200, JSON.stringify(ov.data)); await payNow(ov.data.order);
  const shv = (await call("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === ov.data.order.num).ship_id;
  for (const st of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/seller/shipments/${shv}`, { status: st }, seller)).status, 200);
  assert.equal((await call("GET", "/api/me/bonus", null, v)).data.points, Math.floor(qv.goods * 0.01), "the ordinary 1% of the goods is credited");
});

test("Bonus budget: a monthly cap stops new accruals, refunds of spent points still work", async () => {
  const d6 = mkdtempSync(join(tmpdir(), "imorat-budget-"));
  const cfg6 = loadConfig({ JWT_SECRET: "x", DB_PATH: join(d6, "b.db"), UPLOADS_DIR: join(d6, "up"), ADMIN_PHONES: "998901111111", SMS_MODE: "dev", ALLOW_PAY_AT_STORE: "1", BONUS_ON: "1", BONUS_MONTHLY_BUDGET: "1500", PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PAYME_SECRET", PROMO_MONTHS: "0" });
  assert.equal(cfg6.bonus.monthlyBudget, 1500);
  const a6 = createApp(cfg6, { info() {}, warn() {}, error: console.error });
  await new Promise(r => a6.listen(0, "127.0.0.1", r)); const b6 = `http://127.0.0.1:${a6.address().port}`;
  const c = async (method, path, body, token) => { const r = await fetch(b6 + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
  const lg = async phone => { const s = await c("POST", "/api/auth/otp/send", { phone }); return (await c("POST", "/api/auth/otp/verify", { phone, code: s.data.dev_code })).data.token; };
  const rpc = (method, params) => fetch(b6 + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PAYME_SECRET").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  const payNow = async (o, id) => { await rpc("CreateTransaction", { id, time: Date.now(), amount: o.total * 100, account: { order: o.num } }); const r = await rpc("PerformTransaction", { id }); assert.equal(r.result?.state, 2, JSON.stringify(r)); };
  try {
    const buyer = await lg("998905550011"), form = { name: "Бюджет", phone: "998905550011", mode: "pickup", pay: "payme" };
    const sid = "usta"; // a seeded demo store with product 1 in stock
    const seller = (() => { const u = a6.db.get("SELECT owner_id FROM stores WHERE id=?", sid); return u; })();
    assert.ok(a6.db.get("SELECT 1 FROM offers WHERE store_id=? AND product_id=1", sid));
    const run = async () => { const o = await c("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form }, buyer); assert.equal(o.status, 200, JSON.stringify(o.data)); await payNow(o.data.order, "bud-" + o.data.order.num);
      const sh = (await c("GET", `/api/orders/${o.data.order.num}`, null, buyer)).data.order.ships[0].id;
      for (const s of ["assembling", "ready", "picked"]) assert.equal((await c("PATCH", `/api/admin/shipments/${sh}`, { status: s }, admin)).status, 200, s); return o.data.order; };
    const adminRaw = await lg("998901111111"); const setup = await c("POST", "/api/admin/mfa/setup", null, adminRaw); const admin = (await c("POST", "/api/admin/mfa/verify", { code: totp(setup.data.secret) }, adminRaw)).data.token;
    const o1 = await run(); const p1 = (await c("GET", "/api/me/bonus", null, buyer)).data.points; assert.ok(p1 > 0 && p1 <= 1500, "first order earns within the budget: " + p1);
    let last = p1; for (let i = 0; i < 3 && last < 1500; i++) { await run(); last = (await c("GET", "/api/me/bonus", null, buyer)).data.points; }
    assert.ok(last <= 1500, "accruals never exceed the monthly budget: " + last);
    const before = last; await run(); assert.equal((await c("GET", "/api/me/bonus", null, buyer)).data.points, before, "budget spent: nothing more is issued this month");
    // spent points still come back on a cancellation even when the budget is spent (that is a refund, not an accrual)
    const o = await c("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form, points: 500 }, buyer); assert.equal(o.data.order.pts, 500);
    assert.equal((await c("GET", "/api/me/bonus", null, buyer)).data.points, before - 500);
    assert.equal((await c("POST", `/api/orders/${o.data.order.num}/cancel`, null, buyer)).status, 200);
    assert.equal((await c("GET", "/api/me/bonus", null, buyer)).data.points, before);
    void o1; void seller;
  } finally { a6.stopJobs(); a6.close(); a6.closeAllConnections(); a6.db.raw.close(); rmSync(d6, { recursive: true, force: true }); }
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
  send(7001, { text: "🌐 Язык" });
  const pick = await until(() => sentTo(7001, /Выберите язык/)[0]);
  assert.deepEqual(pick.reply_markup.inline_keyboard[0].map(b => b.callback_data), ["lg:uz", "lg:en"], "the other two languages are offered");
  press(7001, "lg:uz");
  const uzm = await until(() => sentTo(7001, /Til: özbekça/)[0]);
  assert.ok(uzm.reply_markup.keyboard.flat().some(b => b.text === "🔎 Mahsulot qidiriş"));
  send(7001, { text: "laminat" });
  await until(() => sentTo(7001, /Topildi[\s\S]*Laminat/).length);
  // English: a chat whose Telegram is in English starts in English; menu, search and pros are translated
  tgUpdates.push({ update_id: ++uid, message: { chat: { id: 7003, type: "private" }, from: { id: 7003, language_code: "en" }, text: "/start" } });
  const en = await until(() => sentTo(7003, /I am the <b>Imorat Go<\/b> bot/)[0]);
  assert.ok(en.reply_markup.keyboard.flat().some(b => b.text === "🔎 Find a product"));
  send(7003, { text: "cement" });
  const es = await until(() => sentTo(7003, /Found: <b>\d+<\/b>/)[0]);
  assert.match(es.text, /from \d[\d ]* UZS · \d+ stores?/);
  assert.ok(es.reply_markup.inline_keyboard.some(r => r[0].url && r[0].url.includes("?lang=en#p-")), "product links open the English site");
  send(7003, { text: "/masters" });
  const em = await until(() => sentTo(7003, /Which pro do you need/)[0]);
  assert.ok(em.reply_markup.inline_keyboard.flat().some(b => /Tiler/.test(b.text)));
  press(7003, "ms:tile");
  await until(() => sentTo(7003, /<b>Tiler<\/b>|No available pros/).length);
  send(7001, { text: "/lang" }); press(7001, "lg:ru");
  await until(() => sentTo(7001, /Язык: русский/).length);
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
  // a second payment for an order that is already paid is refused, whatever the transaction id
  assert.equal((await rpc("CheckPerformTransaction", { amount: total * 100, account: { order: num } })).error?.code, -31008, "a paid order cannot be paid again");
  assert.equal((await rpc("CreateTransaction", { id: "pm-dup", time: Date.now(), amount: total * 100, account: { order: num } })).error?.code, -31008, "no second transaction for a paid order");
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
  { // Click sends the same complete again, and then a brand-new prepare for the paid order: once paid stays once paid
    const again = await post({ click_trans_id: "9001", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, merchant_prepare_id: String(prep.merchant_prepare_id), amount, action: "1", error: "0", error_note: "", sign_time: signTime, sign_string: md5(`9001` + `12345` + "CLICK_SECRET" + num2 + String(prep.merchant_prepare_id) + amount + "1" + signTime) });
    assert.ok(again.error === 0 || again.error === -4, "a repeated complete is idempotent or says already paid: " + JSON.stringify(again));
    const dup = await post({ click_trans_id: "9777", service_id: "12345", click_paydoc_id: "1", merchant_trans_id: num2, amount, action: "0", error: "0", error_note: "", sign_time: signTime, sign_string: md5(`9777` + `12345` + "CLICK_SECRET" + num2 + amount + "0" + signTime) });
    assert.equal(dup.error, -4, "no second payment for a paid order");
    assert.equal((await call("GET", `/api/orders/${num2}`, null, buyer)).data.order.pay_status, "paid");
  }
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
  // 1) one store, 100 000 by card: Imorat Go's commission 1% = 1 000 and the bank's acquiring fee 2% = 2 000 are two separate lines;
  //    Imorat Go holds 100 000 and owes the store 97 000 — not 94 000
  const rates = (await call("GET", "/api/seller/summary", null, sellerA)).data.rates;
  assert.deepEqual(rates.platform, { "*": 0.01 }); assert.equal(rates.acquiring, 0.02); assert.equal(rates.promo, false);
  const o1 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order;
  await pay(o1, "fin-1"); await advance(sellerA, o1.num, ["assembling", "ready", "picked"]);
  let f = await fin(sellerA);
  assert.equal(f.payout_due, 97000); assert.equal(f.commission_total, 1000); assert.equal(f.acquiring_total, 2000); assert.equal(f.commission, 1000); assert.equal(f.acquiring, 2000);
  assert.equal(f.balance, -97000, "card money is counted once");
  assert.equal((await ship(sellerA, o1.num)).acquiring, 2000);
  // the store takes its money out whenever it likes after the handover: request → admin transfers → marked paid
  assert.equal((await call("POST", "/api/seller/payout", { amount: 97000 }, sellerA)).data.error, "payout_to", "needs a card or account first");
  const pr = await call("POST", "/api/seller/payout", { amount: 50000, payout_to: "8600 1234 5678 9012" }, sellerA);
  assert.equal(pr.status, 200, JSON.stringify(pr.data)); assert.equal(pr.data.finance.payout_available, 47000); assert.equal(pr.data.finance.payout_pending, 50000);
  assert.equal((await call("POST", "/api/seller/payout", {}, sellerA)).status, 409, "one open request at a time");
  const adminFin = (await call("GET", "/api/admin/finance", null, globalThis.ADMIN)).data;
  const req1 = adminFin.payouts.find(x => x.id === pr.data.payout.id); assert.equal(req1.status, "requested"); assert.equal(req1.payout_to, "8600 1234 5678 9012");
  assert.equal((await call("PATCH", `/api/admin/payouts/${req1.id}`, { status: "paid" }, globalThis.ADMIN)).status, 200);
  f = await fin(sellerA); assert.equal(f.payout_paid, 50000); assert.equal(f.payout_available, 47000); assert.equal(f.balance, -47000, "after the transfer Imorat Go owes the rest");
  assert.equal((await call("POST", "/api/seller/payout", { amount: 99999999 }, sellerA)).data.error, "bad_amount");
  const pr2 = await call("POST", "/api/seller/payout", {}, sellerA); assert.equal(pr2.data.payout.amount, 47000, "no amount = everything available");
  assert.equal((await call("PATCH", `/api/admin/payouts/${pr2.data.payout.id}`, { status: "rejected", note: "неверная карта" }, globalThis.ADMIN)).status, 200);
  assert.equal((await fin(sellerA)).payout_available, 47000, "a rejected request frees the money again");
  assert.equal(adminFin.rates.acquiring, 0.02); assert.ok(adminFin.totals.acquiring >= 2000); assert.equal(adminFin.stores.find(x => x.id === A).acquiring, 2000);
  assert.equal((await call("GET", "/api/seller/payouts", null, sellerA)).data.payouts.length, 2);
  assert.equal((await call("GET", "/api/seller/summary", null, sellerA)).data.store.payout_to, "8600 1234 5678 9012");
  // 2) two stores in one order; A hands over, B cancels: A's share stays, the order is flagged for a partial refund
  const o2 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }, { id: 2, store: B, q: 1 }], form }, buyer)).data.order;
  await pay(o2, "fin-2"); await advance(sellerA, o2.num, ["assembling", "ready", "picked"]);
  assert.equal((await fin(sellerA)).payout_due, 194000);
  const sb = await ship(sellerB, o2.num); assert.equal((await call("PATCH", `/api/seller/shipments/${sb.ship_id}`, { status: "cancelled", reason: "out_of_stock" }, sellerB)).status, 200);
  assert.equal((await call("GET", `/api/orders/${o2.num}`, null, buyer)).data.order.pay_status, "refund_due");
  f = await fin(sellerA); assert.equal(f.payout_due, 194000, "A keeps its share after B's cancellation"); assert.equal(f.balance, -144000, "194 000 due minus the 50 000 already paid out");
  assert.equal((await fin(sellerB)).payout_due, 0);
  // 2b) both parts of a paid two-store order fail one after the other: each cancellation raises its own refund for the admin
  app.db.run("UPDATE users SET tg_chat='7777' WHERE phone='998901111111'");
  await call("POST", "/api/seller/offers", { product_id: 2, price: 100000, stock: 50 }, sellerB); // "out of stock" above zeroed B's offer
  const o2bR = await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }, { id: 2, store: B, q: 1 }], form }, buyer); assert.equal(o2bR.status, 200, JSON.stringify(o2bR.data)); const o2b = o2bR.data.order;
  await pay(o2b, "fin-2b");
  const refundsTo = () => tgSent.filter(m => String(m.chat_id) === "7777" && new RegExp("Возврат по заказу " + o2b.num).test(m.text || "")).length;
  const sb2 = await ship(sellerB, o2b.num); assert.equal((await call("PATCH", `/api/seller/shipments/${sb2.ship_id}`, { status: "cancelled", reason: "out_of_stock" }, sellerB)).status, 200);
  await until(() => refundsTo() >= 1);
  const sa2 = await ship(sellerA, o2b.num); assert.equal((await call("PATCH", `/api/seller/shipments/${sa2.ship_id}`, { status: "cancelled", reason: "out_of_stock" }, sellerA)).status, 200);
  await until(() => refundsTo() >= 2); // the second part's refund is reported too, although the order was already refund_due
  assert.equal((await call("GET", `/api/orders/${o2b.num}`, null, buyer)).data.order.status, "cancelled");
  await call("POST", "/api/seller/offers", { product_id: 1, price: 100000, stock: 50 }, sellerA); // A's "out of stock" zeroed its offer
  // 3) the admin marks an order paid by hand: the store gets it like after a bank callback
  const o3 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order;
  assert.equal(await ship(sellerA, o3.num), undefined);
  assert.equal((await call("PATCH", `/api/admin/orders/${o3.num}/pay`, { pay_status: "paid" }, globalThis.ADMIN)).status, 200);
  const s3 = await ship(sellerA, o3.num); assert.ok(s3, "the store sees the order"); assert.equal(s3.status, "new");
  const got = (await call("GET", `/api/orders/${o3.num}`, null, buyer)).data.order; assert.equal(got.pay_status, "paid"); assert.ok(got.paid_at);
  await advance(sellerA, o3.num, ["assembling"]); app.sweep(Date.now() + 31 * 60000);
  assert.equal((await call("GET", `/api/orders/${o3.num}`, null, buyer)).data.order.status, "active", "a paid order is not expired by the payment sweep");
  // 4) free months: the admin gives store B three months — Imorat Go's 1% is 0, the bank's 2% stays; ending them brings the 1% back
  const untilDay = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  assert.equal((await call("PATCH", `/api/admin/stores/${B}`, { free_until: untilDay }, globalThis.ADMIN)).status, 200);
  const sumB = (await call("GET", "/api/seller/summary", null, sellerB)).data; assert.equal(sumB.rates.promo, true); assert.ok(sumB.store.free_until > Date.now());
  await call("POST", "/api/seller/offers", { product_id: 2, price: 100000, stock: 50 }, sellerB); // B's "out of stock" cancellation zeroed its stock
  const o4r = await call("POST", "/api/orders", { lines: [{ id: 2, store: B, q: 1 }], form }, buyer); assert.equal(o4r.status, 200, JSON.stringify(o4r.data)); const o4 = o4r.data.order;
  await pay(o4, "fin-4"); await advance(sellerB, o4.num, ["assembling", "ready", "picked"]);
  f = await fin(sellerB); assert.equal(f.commission_total, 0, "no commission in the free months"); assert.equal(f.acquiring_total, 2000); assert.equal(f.payout_due, 98000);
  assert.equal((await call("PATCH", `/api/admin/stores/${B}`, { free_until: "" }, globalThis.ADMIN)).status, 200);
  assert.equal((await call("GET", "/api/seller/summary", null, sellerB)).data.rates.promo, false);
  const o5 = (await call("POST", "/api/orders", { lines: [{ id: 2, store: B, q: 1 }], form }, buyer)).data.order;
  await pay(o5, "fin-5"); await advance(sellerB, o5.num, ["assembling", "ready", "picked"]);
  f = await fin(sellerB); assert.equal(f.commission_total, 1000); assert.equal(f.acquiring_total, 4000); assert.equal(f.payout_due, 98000 + 97000);
  assert.ok((await call("GET", "/api/admin/stores", null, globalThis.ADMIN)).data.stores.some(x => x.id === B && x.promo === false && x.free_until <= Date.now()));
  { // the free-period boundary: an order placed while free_until is still ahead carries 0% Imorat Go commission, one placed
    // the moment it has passed carries the full rate — and the three months are counted date to date, clamped to month ends
    const soon = Date.now() + 1500;
    app.db.run("UPDATE stores SET free_until=? WHERE id=?", soon, B);
    const inside = (await call("POST", "/api/orders", { lines: [{ id: 2, store: B, q: 1 }], form }, buyer)).data.order;
    assert.equal(app.db.get("SELECT commission, acquiring FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", inside.num).commission, 0, "still inside the free period");
    assert.equal(app.db.get("SELECT acquiring FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", inside.num).acquiring, 2000, "the bank's fee applies in the free period too");
    await new Promise(r => setTimeout(r, 1600));
    const after = (await call("POST", "/api/orders", { lines: [{ id: 2, store: B, q: 1 }], form }, buyer)).data.order;
    assert.equal(app.db.get("SELECT commission FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", after.num).commission, 1000, "the first order after the boundary pays the full rate");
    const iso = t => new Date(t).toISOString().slice(0, 10);
    assert.equal(iso(addMonthsClamped(Date.UTC(2026, 0, 15), 3)), "2026-04-15"); assert.equal(iso(addMonthsClamped(Date.UTC(2026, 0, 31), 3)), "2026-04-30", "31 Jan + 3 months ends on 30 Apr, not 1 May");
    assert.equal(iso(addMonthsClamped(Date.UTC(2026, 10, 30), 3)), "2027-02-28"); assert.equal(iso(addMonthsClamped(Date.UTC(2026, 11, 31), 3)), "2027-03-31");
  }
  // 5) the seller's statement: every sale with its two deductions, the refund, payouts, the sum due — and the same balance as the cabinet
  const stA = (await call("GET", "/api/seller/statement", null, sellerA)).data;
  assert.equal(stA.sales.length, 2, "two completed sales for A this month"); assert.ok(stA.sales.every(x => x.paid === "card" && x.net === x.goods - x.commission - x.acquiring));
  assert.equal(stA.totals.sales, 200000); assert.equal(stA.totals.commission, 2000); assert.equal(stA.totals.acquiring, 4000); assert.equal(stA.totals.due, 194000); assert.equal(stA.totals.refunds, 100000, "A's part of the twice-cancelled card order is its refund line");
  assert.equal(stA.totals.payouts_paid, 50000); assert.equal(stA.balance.payout_due, 194000); assert.equal(stA.balance.payout_paid, 50000);
  const stB = (await call("GET", "/api/seller/statement", null, sellerB)).data;
  assert.equal(stB.refunds.length, 2, "B's cancelled card orders are refund lines"); assert.ok(stB.refunds.some(x => x.num === o2.num)); assert.equal(stB.totals.refunds, 200000);
  assert.equal(stB.sales.length, 2); assert.equal(stB.totals.commission, 1000, "the free-month sale carried no commission"); assert.equal(stB.totals.due, 98000 + 97000);
  assert.equal(stB.store.free_until <= Date.now(), true); assert.ok(!JSON.stringify(stB).match(/profit|прибыл/i), "a payout is never called profit");
  assert.equal((await call("GET", "/api/seller/statement?month=2020-01", null, sellerA)).data.sales.length, 0, "an empty month is empty, not an error");
});

test("Guard rails: admin shipment moves, partial cancellation refunds points, competitor products, paused masters, disputes, odd JSON", async () => {
  const seller = (await login("998880066")).data.token, rival = (await login("998880077")).data.token;
  const mk = async (tok, name) => { const r = await call("POST", "/api/seller/store", { name, descr: "Магазин для проверки ограничений сервера", cats: ["build"], phone: "712004477", addr: "ул. Проверочная, 2", hours: "00:00–00:00", district: "chil" }, tok); assert.equal(r.status, 200, JSON.stringify(r.data)); await call("PATCH", `/api/admin/stores/${r.data.store.id}`, { status: "active" }, globalThis.ADMIN); return r.data.store.id; };
  const A = await mk(seller, "Guard A"), B = await mk(rival, "Guard B");
  await call("POST", "/api/seller/offers", { product_id: 1, price: 100000, stock: 50 }, seller);
  await call("POST", "/api/seller/offers", { product_id: 2, price: 100000, stock: 50 }, rival);
  const buyer = (await login("998880088")).data.token;
  const rpc = (method, params) => fetch(base + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PAYME_SECRET").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  const pay = async (o, id) => { await rpc("CreateTransaction", { id, time: Date.now(), amount: o.total * 100, account: { order: o.num } }); const r = await rpc("PerformTransaction", { id }); assert.equal(r.result?.state, 2, JSON.stringify(r)); };
  const stock = async (sid, pid = 1) => (await call("GET", "/api/catalog")).data.products.find(p => p.id === pid).offers.find(x => x.store === sid).stock;
  const form = { name: "Страж", phone: "998998880088", mode: "pickup", pay: "payme" };
  // 1) admin cannot hand over an unpaid shipment, cancelling it returns the stock, a cancelled one stays cancelled
  const o1 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 3 }], form }, buyer)).data.order;
  const s1 = o1.ships[0].id; assert.equal(await stock(A), 47);
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1}`, { status: "picked" }, globalThis.ADMIN)).data.error, "unpaid");
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1}`, { status: "cancelled" }, globalThis.ADMIN)).status, 200);
  assert.equal(await stock(A), 50, "stock comes back when the admin cancels");
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1}`, { status: "picked" }, globalThis.ADMIN)).data.error, "already_cancelled");
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1}`, { status: "cancelled" }, globalThis.ADMIN)).status, 200, "repeating the same status is a no-op");
  assert.equal(await stock(A), 50, "stock is not returned twice");
  assert.equal((await call("GET", `/api/orders/${o1.num}`, null, buyer)).data.order.status, "cancelled");
  // paid order: admin may move it forward but not backwards, and the handover counts once
  const o1b = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order; await pay(o1b, "guard-1");
  const s1b = o1b.ships[0].id;
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1b}`, { status: "ready" }, globalThis.ADMIN)).status, 200);
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1b}`, { status: "assembling" }, globalThis.ADMIN)).data.error, "backwards");
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1b}`, { status: "picked" }, globalThis.ADMIN)).status, 200);
  assert.equal((await call("PATCH", `/api/admin/shipments/${s1b}`, { status: "cancelled" }, globalThis.ADMIN)).data.error, "already_done");
  // 2) two stores, points spent: B cancels its part → B's share of the points comes back, the rest of the order goes on
  app.db.run("UPDATE users SET points=100000 WHERE phone=?", "998998880088"); // a balance to spend (earned bonuses in real life)
  const pts0 = (await call("GET", "/api/me/bonus", null, buyer)).data.points;
  assert.equal(pts0, 100000);
  {
    const o2 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }, { id: 2, store: B, q: 1 }], form, points: 40000 }, buyer)).data.order;
    assert.equal(o2.pts, 40000); await pay(o2, "guard-2");
    const sb = o2.ships.find(x => x.store === B).id, sa = o2.ships.find(x => x.store === A).id;
    const shipB = (await call("GET", "/api/seller/summary", null, rival)).data.orders.find(x => x.num === o2.num);
    assert.equal((await call("PATCH", `/api/seller/shipments/${shipB.ship_id}`, { status: "cancelled", reason: "out_of_stock" }, rival)).status, 200);
    const pts1 = (await call("GET", "/api/me/bonus", null, buyer)).data.points;
    assert.equal(pts1, pts0 - 40000 + 20000, "half of the points (B's half of the goods) refunded");
    for (const st of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/admin/shipments/${sa}`, { status: st }, globalThis.ADMIN)).status, 200, st);
    assert.equal((await call("GET", `/api/orders/${o2.num}`, null, buyer)).data.order.status, "done");
    assert.equal((await call("GET", "/api/me/bonus", null, buyer)).data.points >= pts1, true, "no double refund when the order completes");
    void sb;
  }
  // 3) a store cannot list another store's own product
  const own = await call("POST", "/api/seller/products", { ru: "Эксклюзив B", cat: "build", sub: "cement", price: 50000, unit: "pcs", kg: 1, descr: "Только у нас" }, rival);
  if (own.status === 200) {
    const pid = own.data.product?.id || own.data.id;
    assert.equal((await call("POST", "/api/seller/offers", { product_id: pid, price: 40000, stock: 5 }, seller)).status, 404);
    const imp = await call("POST", "/api/seller/import", { offers: [{ product_id: pid, price: 40000, stock: 5 }, null] }, seller);
    assert.equal(imp.status, 200, JSON.stringify(imp.data)); assert.equal((await call("GET", "/api/catalog")).data.products.find(p => p.id === pid)?.offers.some(x => x.store === A) || false, false);
  }
  // 4) requests do not reach a paused master
  const mt = (await login("998880099")).data.token;
  const prof = await call("POST", "/api/masters/me", { name: "Пауза Мастер", specs: ["tile"], districts: ["chil"], exp: 3, price: 50000, price_unit: "m2", about: "Проверка паузы" }, mt);
  assert.equal(prof.status, 200, JSON.stringify(prof.data)); const mid = prof.data.master.id;
  await call("PATCH", `/api/admin/masters/${mid}`, { status: "active" }, globalThis.ADMIN);
  assert.equal((await call("POST", `/api/masters/${mid}/requests`, { text: "Положить плитку 6 м²", when: "завтра" }, buyer)).status, 200);
  assert.equal((await call("PATCH", "/api/masters/me", { busy: true }, mt)).status, 200);
  assert.equal((await call("POST", `/api/masters/${mid}/requests`, { text: "Положить плитку 6 м²", when: "завтра" }, buyer)).status, 409);
  // editing name or description sends an active profile back to moderation; a price change does not
  assert.equal((await call("POST", "/api/masters/me", { name: "Пауза Мастер", specs: ["tile"], districts: ["chil"], exp: 3, price: 60000, price_unit: "m2", about: "Проверка паузы" }, mt)).data.master.status, "active");
  assert.equal((await call("POST", "/api/masters/me", { name: "Пауза Мастер", specs: ["tile", "plumb"], districts: ["chil"], exp: 3, price: 60000, price_unit: "m2", about: "Проверка паузы" }, mt)).data.master.status, "pending");
  // 5) no dispute on an unpaid part of an order
  const o5 = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form }, buyer)).data.order;
  assert.equal((await call("POST", `/api/orders/${o5.num}/problems`, { ship_id: o5.ships[0].id, reason: "not_delivered", text: "Ничего не привезли" }, buyer)).data.error, "too_early");
  // 6) odd shapes in valid JSON are answered, not crashed on
  assert.notEqual((await call("POST", "/api/quote", { lines: [{ id: 1, store: A, q: 1 }], form, services: "x", bundles: 5 }, buyer)).status, 500);
  assert.notEqual((await call("POST", "/api/seller/import", { offers: [null], create: [null] }, seller)).status, 500);
  // 6b) a promo code comes back when the order is cancelled, but cancelling the same order twice must not free another order's use
  const pA = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form: { ...form, mode: "pickup" }, promo: "IMORAT5" }, buyer)).data.order; assert.equal(pA.promo, "IMORAT5");
  assert.equal((await call("POST", `/api/orders/${pA.num}/cancel`, {}, buyer)).status, 200);
  const pB = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form: { ...form, mode: "pickup" }, promo: "IMORAT5" }, buyer)).data.order; assert.equal(pB.promo, "IMORAT5", "the use came back after the cancellation");
  assert.notEqual((await call("POST", `/api/orders/${pA.num}/cancel`, {}, buyer)).status, 200, "a cancelled order cannot be cancelled again");
  const pC = (await call("POST", "/api/orders", { lines: [{ id: 1, store: A, q: 1 }], form: { ...form, mode: "pickup" }, promo: "IMORAT5" }, buyer)).data.order; assert.equal(pC.promo, null, "B still holds the promo use");
  // 6c) a one-time admin code is one-time in the neighbouring 30-second window as well
  const adminRaw2 = (await login("901111111")).data.token, secret = app.db.get("SELECT totp_secret FROM users WHERE phone='998901111111'").totp_secret;
  const future = totp(secret, Date.now() + 30000); // the code of the next window is already accepted now (clock tolerance)…
  assert.equal((await call("POST", "/api/admin/mfa/verify", { code: future }, adminRaw2)).status, 200);
  assert.equal((await call("POST", "/api/admin/mfa/verify", { code: future }, adminRaw2)).data.error, "mfa_reused", "…and is refused when replayed");
  assert.equal((await call("POST", "/api/admin/mfa/verify", { code: totp(secret) }, adminRaw2)).data.error, "mfa_reused", "an older window's code is refused once a newer one was used");
  // 7) payment callbacks with a body that is valid JSON but not an object (null, a string, an array) get a provider-style error, never a 500
  for (const raw of ["null", "\"x\"", "[]", "{\"params\":null,\"method\":\"CheckTransaction\"}"]) {
    for (const p of ["/api/pay/payme", "/api/pay/click", "/api/pay/click/prepare", "/api/pay/click/complete"]) {
      const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      assert.equal(r.status, 200, `${p} ${raw}`); const j = await r.json(); assert.ok(j.error !== undefined, `${p} ${raw} answers with an error object`);
    }
  }
  // 8) CORS: the website's origins and the app's WebView origins are allowed, anything else gets no CORS headers (the browser then blocks it)
  const acao = async origin => (await fetch(base + "/api/config", { headers: { origin } })).headers.get("access-control-allow-origin");
  assert.equal(await acao("https://usmonovm7777-crypto.github.io"), "https://usmonovm7777-crypto.github.io");
  assert.equal(await acao("https://localhost"), "https://localhost", "Android app (androidScheme https)");
  assert.equal(await acao("capacitor://localhost"), "capacitor://localhost", "iOS app");
  assert.equal(await acao("https://evil.example"), null);
  const pre = await fetch(base + "/api/orders", { method: "OPTIONS", headers: { origin: "https://localhost", "access-control-request-method": "POST", "access-control-request-headers": "authorization" } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-headers") || "", /Authorization/);
});

test("Card only: no cash, the full address reaches the courier, the buyer watches the courier (simulated and via Yandex)", async () => {
  const d3 = mkdtempSync(join(tmpdir(), "imorat-card-"));
  const mk = env => { const cfg = loadConfig({ JWT_SECRET: "x", DB_PATH: join(d3, (env.YANDEX_DELIVERY_TOKEN ? "y" : "n") + ".db"), UPLOADS_DIR: join(d3, "up"), ADMIN_PHONES: "998901111111", ADMIN_MFA: "0", SMS_MODE: "dev", OTP_PER_IP_HOUR: "500", TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0", ...env }); const a = createApp(cfg, { info() {}, warn() {}, error: console.error }); return a; };
  const run = async (a, fn) => { await new Promise(r => a.listen(0, "127.0.0.1", r)); const b3 = `http://127.0.0.1:${a.address().port}`; const c = async (m, p, body, tok) => { const r = await fetch(b3 + p, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; }; const lg = async ph => { const s = await c("POST", "/api/auth/otp/send", { phone: ph }); return (await c("POST", "/api/auth/otp/verify", { phone: ph, code: s.data.dev_code })).data.token; }; try { await fn(c, lg, a); } finally { a.stopJobs(); a.close(); a.closeAllConnections(); a.db.raw.close(); } };
  let simOrder = "";
  const form = { name: "Карта", phone: "998901234567", mode: "yandex", district: "yunus", street: "ул. Амира Темура, 15", entrance: "3", floor: "4", flat: "27", intercom: "27К", comment: "Позвоните заранее", la: 41.311, lo: 69.279, pay: "payme", help: "one" };
  // 1) no payment keys yet: ordering is closed, not silently switched to cash
  await run(mk({}), async (c, lg) => {
    const t = await lg("998901234567");
    assert.equal((await c("GET", "/api/config")).data.pay_at_store, false);
    assert.equal((await c("GET", "/api/config")).data.site_url, "https://usmonovm7777-crypto.github.io/Imorat/", "the website address is the server's explicit SITE_URL");
    const h = (await c("GET", "/api/health")).data; assert.equal(h.name, "imorat-api"); assert.equal(h.contract, 1); assert.equal(h.min_client, 1); assert.match(h.version, /^\d+\.\d+/);
    const r1 = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, pay: "store", mode: "pickup" } }, t);
    assert.equal(r1.status, 503); assert.equal(r1.data.error, "payments_off");
    assert.equal((await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t)).data.error, "payments_off");
  });
  // 2) with Payme keys and no Yandex token: card is the only way, the address is stored whole, the courier is simulated
  await run(mk({ PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PK" }), async (c, lg, a) => {
    const t = await lg("998901234567"), seller = await lg("998901234568");
    assert.equal((await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, mode: "pickup", pay: "store" } }, t)).data.error, "card_required", "no cash even for pickup");
    const o = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t);
    assert.equal(o.status, 200, JSON.stringify(o.data)); const d = o.data.order.d;
    assert.equal(d.entrance, "3"); assert.equal(d.flat, "27"); assert.equal(d.floor, "4"); assert.equal(d.intercom, "27К"); assert.equal(d.la, 41.311); assert.equal(d.help, "one");
    { // unloading help is priced per floor (cargo tariff): none < one; a private house counts as one floor
      const q = async f => (await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, ...f } }, t)).data.quote.del;
      const none = await q({ help: "none" }), one = await q({ help: "one" }), priv = await q({ help: "one", private: true });
      assert.ok(none < one, `${none} < ${one}`); assert.equal(one - none, 3 * (priv - none), "floor 4 = 3 flights, a private house = 1");
      assert.equal(await q({ lift: true, help: undefined }), one, "old clients sending lift:true get one loader");
    }
    { // discounts are off by default (DISCOUNTS_ON unset): no wholesale tier, no promo code, no bundle discount, no −10% slot
      assert.equal((await c("GET", "/api/config")).data.discounts, false);
      const qd = async (extra, f = {}) => (await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 60 }], form: { ...form, ...f }, ...extra }, t)).data.quote;
      const plain = await qd({}), withAll = await qd({ promo: "IMORAT5", bundles: ["bath", "paint"] });
      assert.equal(plain.ships[0].lines[0].tier, 0); assert.equal(plain.ships[0].lines[0].price, plain.ships[0].lines[0].base, "60 bags at the full price");
      assert.equal(withAll.pd, 0); assert.equal(withAll.promo, null); assert.equal(withAll.disc, 0); assert.equal(withAll.total, plain.total);
      assert.equal((await qd({}, { when: "slot" })).del, plain.del, "tomorrow 10–14 costs the same as asap");
    }
    const rpc = (method, params) => fetch(`http://127.0.0.1:${a.address().port}/api/pay/payme`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PK").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
    await rpc("CreateTransaction", { id: "c1", time: Date.now(), amount: o.data.order.total * 100, account: { order: o.data.order.num } }); assert.equal((await rpc("PerformTransaction", { id: "c1" })).result.state, 2);
    // the demo store "usta" belongs to nobody: move the shipment as admin
    const admin = await lg("998901111111"); const sh = o.data.order.ships[0].id;
    for (const st of ["assembling", "searching"]) assert.equal((await c("PATCH", `/api/admin/shipments/${sh}`, { status: st }, admin)).status, 200, st);
    let cr = (await c("GET", `/api/orders/${o.data.order.num}/courier?ship=${sh}`, null, t)).data.courier;
    assert.equal(cr.status, "searching"); assert.equal(cr.pos, null); assert.ok(cr.unavailable && !cr.simulated, "no Yandex → no coordinates are invented"); assert.equal(cr.to.la, 41.311);
    assert.equal((await c("PATCH", `/api/admin/shipments/${sh}`, { status: "to_store" }, admin)).status, 200);
    cr = (await c("GET", `/api/orders/${o.data.order.num}/courier?ship=${sh}`, null, t)).data.courier;
    assert.equal(cr.status, "to_store", "the real status is still reported"); assert.equal(cr.pos, null); assert.ok(cr.unavailable); assert.equal(cr.eta_min, undefined, "no made-up ETA either");
    assert.equal((await c("GET", `/api/orders/${o.data.order.num}/courier`, null, seller)).status, 404, "only the buyer sees the courier");
    simOrder = o.data.order.num;
  });
  // 2b) the same database on a declared test server (COURIER_SIMULATION=1): the pretend courier moves, and says so
  await run(mk({ PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PK", COURIER_SIMULATION: "1" }), async (c, lg) => {
    const t = await lg("998901234567");
    const cr = (await c("GET", `/api/orders/${simOrder}/courier`, null, t)).data.courier;
    assert.ok(cr.simulated && cr.pos && cr.pos.la > 41 && cr.eta_min >= 1, "a simulated courier is on the way to the store");
  });
  assert.throws(() => loadConfig({ JWT_SECRET: "x", NODE_ENV: "production", ESKIZ_EMAIL: "a", ESKIZ_PASSWORD: "b", COURIER_SIMULATION: "1" }), /test servers only/, "no simulation on a production server");
  // 3) with a Yandex token: the claim is created with porch/floor/flat/door code, statuses follow Yandex, position is live
  await run(mk({ PAYME_MERCHANT_ID: "5e730e8e0b852a417aa49ceb", PAYME_KEY: "PK", YANDEX_DELIVERY_TOKEN: "y", YANDEX_DELIVERY_URL: fakeBase + "/ya" }), async (c, lg, a) => {
    const t = await lg("998901234567"), admin = await lg("998901111111");
    { // the carrier is connected but returns no price for this address: the cost is unknown — shown as unknown, never as 0 — and no order is taken
      const q = (await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, street: "NOPRICE street 1" } }, t)).data.quote;
      assert.equal(q.unknown, true); assert.equal(q.del, null); assert.equal(q.total, null); assert.equal(q.ships[0].source, "unavailable"); assert.equal(q.ships[0].price, null); assert.ok(q.goods > 0);
      const bad = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, street: "NOPRICE street 1" } }, t);
      assert.equal(bad.status, 503); assert.equal(bad.data.error, "delivery_price_unavailable");
      const ok = (await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t)).data.quote; assert.equal(ok.ships[0].source, "yandex"); assert.equal(ok.unknown, false);
    }
    const o = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t); assert.equal(o.status, 200, JSON.stringify(o.data));
    const rpc = (method, params) => fetch(`http://127.0.0.1:${a.address().port}/api/pay/payme`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PK").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
    await rpc("CreateTransaction", { id: "c2", time: Date.now(), amount: o.data.order.total * 100, account: { order: o.data.order.num } }); await rpc("PerformTransaction", { id: "c2" });
    const sh = o.data.order.ships[0].id, n0 = yaClaims.length;
    for (const st of ["assembling", "searching"]) await c("PATCH", `/api/admin/shipments/${sh}`, { status: st }, admin);
    await until(() => yaClaims.length > n0);
    const claim = yaClaims[yaClaims.length - 1].body, dest = claim.route_points.find(p => p.type === "destination");
    assert.equal(dest.address.porch, "3"); assert.equal(dest.address.sfloor, "4"); assert.equal(dest.address.sflat, "27"); assert.equal(dest.address.door_code, "27К");
    assert.deepEqual(dest.address.coordinates, [69.279, 41.311]); assert.equal(dest.contact.phone, "+998901234567"); assert.equal(dest.external_order_id, o.data.order.num);
    assert.ok(["express", "cargo"].includes(claim.client_requirements.taxi_class)); // a 50 kg bag of cement goes by cargo van
    assert.equal(claim.client_requirements.cargo_loaders, 1); assert.equal(claim.skip_door_to_door, false); // help was ordered at checkout
    assert.deepEqual(claim.items[0].size, { length: 0.5, width: 0.4, height: 0.3 }, "a cement bag has no dims: the generic parcel size"); assert.match(claim.comment, /нужна помощь с разгрузкой/);
    { // the carrier refuses the loader for this route: the trip is still ordered, without the help, and the order says so
      const o2 = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, street: "NOLOADER street 5", access: "far", elevator: false } }, t); assert.equal(o2.status, 200, JSON.stringify(o2.data));
      await rpc("CreateTransaction", { id: "c2b", time: Date.now(), amount: o2.data.order.total * 100, account: { order: o2.data.order.num } }); await rpc("PerformTransaction", { id: "c2b" });
      const sh2 = o2.data.order.ships[0].id, n1 = yaClaims.length;
      for (const st of ["assembling", "searching"]) await c("PATCH", `/api/admin/shipments/${sh2}`, { status: st }, admin);
      await until(() => yaClaims.length > n1);
      const cl2 = yaClaims[yaClaims.length - 1].body;
      assert.equal(cl2.client_requirements.cargo_loaders, undefined); assert.equal(cl2.skip_door_to_door, true); assert.match(cl2.comment, /Грузчика перевозчик не подтвердил/); assert.match(cl2.comment, /машина не подъедет/); assert.match(cl2.comment, /лифта нет/);
      await until(async () => (await c("GET", `/api/orders/${o2.data.order.num}`, null, t)).data.order.ships[0].loaders_failed === true);
      const d2 = (await c("GET", `/api/orders/${o2.data.order.num}`, null, t)).data.order.d; assert.equal(d2.access, "far"); assert.equal(d2.elevator, false);
    }
    await until(async () => (await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order.ships[0].tracking_url);
    // each sweep asks Yandex and moves the shipment: performer_found → to_store, pickuped → on_way, delivered_finish → delivered
    a.sweep(); await until(async () => (await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order.ships[0].status === "to_store");
    const cr = (await c("GET", `/api/orders/${o.data.order.num}/courier?ship=${sh}`, null, t)).data.courier;
    assert.ok(cr.live); assert.equal(cr.pos.la, 41.3); assert.equal(cr.tracking_url, "https://taxi.yandex.ru/route/abc"); assert.match(cr.courier, /Шерзод/);
    a.sweep(); await until(async () => (await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order.ships[0].status === "on_way");
    a.sweep(); await until(async () => (await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order.ships[0].status === "delivered");
    assert.equal((await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order.status, "done");
    // a shipment cancelled after the courier was called: the Yandex claim is cancelled too (here a paid cancellation → the admins hear about it)
    const o2 = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t); assert.equal(o2.status, 200);
    await rpc("CreateTransaction", { id: "c3", time: Date.now(), amount: o2.data.order.total * 100, account: { order: o2.data.order.num } }); await rpc("PerformTransaction", { id: "c3" });
    const sh2 = o2.data.order.ships[0].id, n1 = yaClaims.length;
    for (const st of ["assembling", "searching"]) await c("PATCH", `/api/admin/shipments/${sh2}`, { status: st }, admin);
    await until(() => yaClaims.length > n1);
    const k0 = yaCancels.length;
    assert.equal((await c("PATCH", `/api/admin/shipments/${sh2}`, { status: "cancelled" }, admin)).status, 200);
    await until(() => yaCancels.length > k0);
    assert.match(yaCancels[yaCancels.length - 1].url, /claim_id=claim-/); assert.equal(yaCancels[yaCancels.length - 1].body.cancel_state, "paid");
  });
  rmSync(d3, { recursive: true, force: true });
});

test("Address search for the checkout map: Nominatim without a key, the Yandex geocoder with one, cached and polite", async () => {
  const d4 = mkdtempSync(join(tmpdir(), "imorat-geo-"));
  const mk = env => createApp(loadConfig({ JWT_SECRET: "x", DB_PATH: join(d4, (env.YANDEX_MAPS_KEY ? "y" : "n") + ".db"), UPLOADS_DIR: join(d4, "up"), ADMIN_PHONES: "998901111111", SMS_MODE: "dev", NOMINATIM_URL: fakeBase + "/nom", YANDEX_GEOCODER_URL: fakeBase + "/geocode/1.x/", ...env }), { info() {}, warn() {}, error: console.error });
  const run = async (a, fn) => { await new Promise(r => a.listen(0, "127.0.0.1", r)); const b4 = `http://127.0.0.1:${a.address().port}`; const g = async p => { const r = await fetch(b4 + p); return { status: r.status, data: await r.json() }; }; try { await fn(g); } finally { a.stopJobs(); a.close(); a.closeAllConnections(); a.db.raw.close(); } };
  await run(mk({}), async g => {
    assert.equal((await g("/api/config")).data.geo, "osm"); assert.equal((await g("/api/config")).data.ymaps_key, null);
    assert.equal((await g("/api/config")).data.bonus, false, "the points programme is off until BONUS_ON=1");
    assert.deepEqual((await g("/api/geo/suggest?q=на")).data.items, [], "two letters: no request at all");
    const n0 = geoHits.length, r = await g("/api/geo/suggest?q=" + encodeURIComponent("Навои 10") + "&lang=ru");
    assert.equal(r.status, 200); assert.equal(r.data.items[0].street, "улица Навои, 10"); assert.equal(r.data.items[0].la, 41.3115); assert.equal(r.data.items[0].sub, "Шайхантахур, Шайхантахурский район"); assert.equal(r.data.items.length, 2);
    assert.match(geoHits[n0], /countrycodes=uz/); assert.match(geoHits[n0], /ImoratGo/, "Nominatim gets a user agent");
    await g("/api/geo/suggest?q=" + encodeURIComponent("Навои 10") + "&lang=ru"); assert.equal(geoHits.length, n0 + 1, "the same query is served from the cache");
    const rv = (await g("/api/geo/reverse?la=41.311&lo=69.279")).data.item; assert.equal(rv.street, "проспект Амира Темура, 15"); assert.equal(rv.sub, "Юнусабад");
    assert.equal((await g("/api/geo/reverse?la=abc&lo=1")).data.item, null);
    assert.deepEqual((await g("/api/geo/suggest?q=" + encodeURIComponent("Чиланзар"))).data.items, [], "nothing found → empty list, not an error");
  });
  await run(mk({ YANDEX_MAPS_KEY: "ymkey" }), async g => {
    assert.equal((await g("/api/config")).data.geo, "yandex"); assert.equal((await g("/api/config")).data.ymaps_key, "ymkey");
    const n0 = geoHits.length, r = await g("/api/geo/suggest?q=" + encodeURIComponent("Навои 10") + "&lang=uz");
    assert.equal(r.data.items[0].street, "улица Навои, 10"); assert.equal(r.data.items[0].sub, "Шайхантахурский район"); assert.equal(r.data.items[0].lo, 69.2401);
    assert.match(geoHits[n0], /apikey=ymkey/); assert.match(geoHits[n0], /lang=uz_UZ/); assert.match(geoHits[n0], /rspn=1/, "results are limited to the Tashkent box");
    const rv = (await g("/api/geo/reverse?la=41.311&lo=69.279")).data.item; assert.equal(rv.street, "улица Навои, 10"); assert.match(geoHits[geoHits.length - 1], /kind=house/);
  });
  rmSync(d4, { recursive: true, force: true });
});

test("Sign in with Telegram from the site: ticket → bot asks for the phone → the page gets the session; a known chat signs in at once", async () => {
  let uid = 900;
  const send = (chat, msg) => tgUpdates.push({ update_id: ++uid, message: { chat: { id: chat, type: "private" }, from: { id: chat }, ...msg } });
  const sentTo = (chat, re) => tgSent.filter(x => String(x.chat_id) === String(chat) && re.test(x.text || ""));
  const st = await call("POST", "/api/auth/tg/start", {});
  assert.equal(st.status, 200); assert.match(st.data.url, /^https:\/\/t\.me\/imorat_test_bot\?start=login_[0-9a-f]{32}$/); assert.equal(st.data.bot, "imorat_test_bot");
  assert.deepEqual((await call("GET", `/api/auth/tg/poll?ticket=${st.data.ticket}`)).data, { pending: true });
  assert.equal((await call("GET", "/api/auth/tg/poll?ticket=nope")).status, 410, "unknown ticket");
  // a brand-new chat opens the link: the bot asks for the phone number, then the contact signs the person in and completes the ticket
  send(7801, { text: "/start login_" + st.data.ticket });
  const ask = await until(() => sentTo(7801, /поделитесь номером/)[0]);
  assert.ok(ask.reply_markup.keyboard.flat().some(b => b.request_contact), "contact button is offered");
  assert.deepEqual((await call("GET", `/api/auth/tg/poll?ticket=${st.data.ticket}`)).data, { pending: true }, "still pending until the phone is shared");
  send(7801, { contact: { phone_number: "+998933337788", user_id: 7801, first_name: "Телеграм", last_name: "Юзер" } });
  // the phone binds the chat, but the site session is handed over only after an explicit "yes, it's me" (a link can be sent to anyone)
  const ask1 = await until(() => sentTo(7801, /Это вы\?/)[0]);
  const yes1 = ask1.reply_markup.inline_keyboard.flat().find(b => /Да/.test(b.text)); assert.equal(yes1.callback_data, `tgl:y:${st.data.ticket}`);
  assert.deepEqual((await call("GET", `/api/auth/tg/poll?ticket=${st.data.ticket}`)).data, { pending: true }, "still pending until the person confirms in the bot");
  let cbid = 0;
  const press = data => { const id = "tglq" + (++cbid); tgUpdates.push({ update_id: ++uid, callback_query: { id, data, from: { id: 7801 }, message: { chat: { id: 7801, type: "private" }, message_id: 5 } } }); return id; };
  press(yes1.callback_data);
  await until(() => sentTo(7801, /вошли на сайт/).length);
  const got = await call("GET", `/api/auth/tg/poll?ticket=${st.data.ticket}`);
  assert.equal(got.status, 200); assert.ok(got.data.token); assert.equal(got.data.user.phone, "+998 93 333 77 88"); assert.equal(got.data.user.name, "Телеграм Юзер"); assert.equal(got.data.user.telegram, true);
  assert.equal((await call("GET", "/api/me", null, got.data.token)).data.user.phone, "+998 93 333 77 88", "the token works");
  assert.equal((await call("GET", `/api/auth/tg/poll?ticket=${st.data.ticket}`)).status, 410, "a ticket is used once");
  // the same chat again: already known → no phone asked, but still a confirmation; "No" kills the ticket (phishing link from a stranger)
  const stX = await call("POST", "/api/auth/tg/start", {});
  send(7801, { text: "/start login_" + stX.data.ticket });
  const askX = await until(() => sentTo(7801, /Это вы\?/).filter(m => m.reply_markup.inline_keyboard.flat().some(b => b.callback_data === `tgl:y:${stX.data.ticket}`))[0]);
  assert.ok(!sentTo(7801, /поделитесь номером/).some(m => tgSent.indexOf(m) > tgSent.indexOf(askX)), "a known chat is not asked for the phone again");
  press(`tgl:n:${stX.data.ticket}`);
  await until(() => sentTo(7801, /никто не вошёл/).length);
  assert.equal((await call("GET", `/api/auth/tg/poll?ticket=${stX.data.ticket}`)).status, 410, "a refused ticket never signs anyone in");
  press(`tgl:y:${stX.data.ticket}`); // a late "yes" on the dead ticket changes nothing
  await until(() => tgSent.filter(x => x.m === "answerCallbackQuery" && /устарела/.test(x.text || "")).length);
  assert.equal((await call("GET", `/api/auth/tg/poll?ticket=${stX.data.ticket}`)).status, 410);
  // and "Yes" signs in
  const st2 = await call("POST", "/api/auth/tg/start", {});
  send(7801, { text: "/start login_" + st2.data.ticket });
  await until(() => sentTo(7801, /Это вы\?/).filter(m => m.reply_markup.inline_keyboard.flat().some(b => b.callback_data === `tgl:y:${st2.data.ticket}`)).length);
  press(`tgl:y:${st2.data.ticket}`);
  await until(() => sentTo(7801, /вошли на сайт/).length >= 2);
  assert.equal((await call("GET", `/api/auth/tg/poll?ticket=${st2.data.ticket}`)).data.user.phone, "+998 93 333 77 88");
  // an expired or reused link gets a friendly message
  send(7801, { text: "/start login_" + st2.data.ticket });
  await until(() => sentTo(7801, /устарела/).length);
});

test("SMS_MODE=telegram: production start without an SMS contract, sign-in only through the bot, no code leaks", async () => {
  const d5 = mkdtempSync(join(tmpdir(), "imorat-tg-"));
  assert.throws(() => loadConfig({ JWT_SECRET: "x", DB_PATH: join(d5, "a.db"), UPLOADS_DIR: join(d5, "up"), ADMIN_PHONES: "998901111111", SMS_MODE: "telegram" }), /TELEGRAM_BOT_TOKEN/, "the bot is the only door, so its token is required");
  { // the acquiring rate: one number for every provider, or each provider's contract rate
    const one = loadConfig({ JWT_SECRET: "x", ACQUIRING_PERCENT: "1.5" }), per = loadConfig({ JWT_SECRET: "x", ACQUIRING_PERCENT: "payme:2,click:1.8" }), def = loadConfig({ JWT_SECRET: "x" });
    assert.equal(one.acquiringOf("click"), 0.015); assert.equal(per.acquiringOf("click"), 0.018); assert.equal(per.acquiringOf("payme"), 0.02); assert.equal(per.acquiring, 0.02); assert.deepEqual(per.acquiringBy, { payme: 0.02, click: 0.018 });
    assert.equal(def.acquiringOf("payme"), 0.02); assert.deepEqual(def.acquiringBy, {});
  }
  assert.throws(() => loadConfig({ JWT_SECRET: "x", DB_PATH: join(d5, "a.db"), UPLOADS_DIR: join(d5, "up"), ADMIN_PHONES: "998901111111", NODE_ENV: "production", API_DOMAIN: "api.test", PUBLIC_URL: "https://api.test", ALLOWED_ORIGINS: "https://x.test" }), /SMS is in dev mode/, "dev codes never reach production");
  const cfg5 = loadConfig({ JWT_SECRET: "x", DB_PATH: join(d5, "b.db"), UPLOADS_DIR: join(d5, "up"), ADMIN_PHONES: "998901111111", NODE_ENV: "production", API_DOMAIN: "api.test", PUBLIC_URL: "https://api.test", ALLOWED_ORIGINS: "https://x.test",
    SMS_MODE: "telegram", TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0" });
  assert.equal(cfg5.sms.mode, "telegram");
  const a5 = createApp(cfg5, { info() {}, warn() {}, error: console.error });
  await new Promise(r => a5.listen(0, "127.0.0.1", r)); const b5 = `http://127.0.0.1:${a5.address().port}`;
  const c = async (method, path, body) => { const r = await fetch(b5 + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
  try {
    assert.equal((await c("GET", "/api/config")).data.sms, "telegram", "the site hides the SMS form and shows the Telegram button");
    const s = await c("POST", "/api/auth/otp/send", { phone: "998901234567" });
    assert.equal(s.status, 503); assert.equal(s.data.error, "sms_off"); assert.equal(s.data.dev_code, undefined);
    const t = await c("POST", "/api/auth/tg/start", {}); assert.equal(t.status, 200); assert.match(t.data.url, /t\.me\/.*start=login_/, "Telegram sign-in still works");
  } finally { a5.stopJobs(); a5.close(); a5.closeAllConnections(); a5.db.raw.close(); rmSync(d5, { recursive: true, force: true }); }
});

test("Stage 0: pay on receipt, the store delivers itself, no invented delivery price, no false debt, statuses and buttons", async () => {
  const d0 = mkdtempSync(join(tmpdir(), "imorat-s0-"));
  const cfg0 = loadConfig({ JWT_SECRET: "x", DB_PATH: join(d0, "s0.db"), UPLOADS_DIR: join(d0, "up"), ADMIN_PHONES: "998901111111", ADMIN_MFA: "0", SMS_MODE: "dev", OTP_PER_IP_HOUR: "500",
    ALLOW_PAY_AT_STORE: "1", DISCOUNTS_ON: "1", TELEGRAM_BOT_TOKEN: "TGTOKEN", TELEGRAM_API_URL: fakeBase + "/tg", TELEGRAM_POLL_TIMEOUT: "0" }); // no Payme/Click keys, no Yandex token
  assert.equal(cfg0.payOnReceipt, true); assert.equal(cfg0.deliveryBy, "store");
  const a0 = createApp(cfg0, { info() {}, warn() {}, error: console.error });
  await new Promise(r => a0.listen(0, "127.0.0.1", r)); const b0 = `http://127.0.0.1:${a0.address().port}`;
  const c = async (m, p, body, tok) => { const r = await fetch(b0 + p, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const lg = async ph => (await c("POST", "/api/auth/otp/verify", { phone: ph, code: (await c("POST", "/api/auth/otp/send", { phone: ph })).data.dev_code })).data.token;
  try {
    const cf = (await c("GET", "/api/config")).data;
    assert.deepEqual(cf.payments, []); assert.equal(cf.pay_at_store, true); assert.equal(cf.pay_on_receipt, true); assert.equal(cf.delivery_by, "store"); assert.equal(cf.yandex, false);
    const t = await lg("998901234567"), seller = await lg("998901234568"), admin = await lg("998901111111");
    const form = { name: "Нулевой", phone: "998901234567", mode: "yandex", district: "yunus", street: "ул. Амира Темура, 15", floor: "3", pay: "store", help: "none" };
    // the quote: goods are priced, delivery is the store's business — no figure, not 0
    const q = (await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 2 }], form }, t)).data.quote;
    assert.equal(q.delivery_by, "store"); assert.equal(q.del, null); assert.equal(q.ships[0].price, null); assert.equal(q.ships[0].source, "store"); assert.equal(q.ships[0].tariff, "cargo_s", "the vehicle class is still told to the store");
    assert.equal(q.total, q.goods, "the total is the goods total"); assert.equal(q.unknown, false);
    // a delivery order paid on receipt is accepted (no card provider needed) and carries no commission or acquiring
    const o = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 2 }], form, expected_total: q.total }, t);
    assert.equal(o.status, 200, JSON.stringify(o.data)); assert.equal(o.data.order.d.delivery_by, "store"); assert.equal(o.data.order.del, 0); assert.equal(o.data.order.pay_status, "to_store");
    const sh = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", o.data.order.num);
    assert.equal(sh.commission, 0); assert.equal(sh.acquiring, 0); assert.equal(sh.price, 0);
    // the seller's Telegram message says the store delivers and asks it to name the delivery price; the button is "courier left"
    a0.db.run("UPDATE stores SET owner_id=(SELECT id FROM users WHERE phone='998901234568') WHERE id='usta'"); a0.db.run("UPDATE users SET store_id='usta', tg_chat='4242' WHERE phone='998901234568'");
    const n0 = tgSent.length; a0.notify.shipmentNew(sh.id); await until(() => tgSent.length > n0);
    const msg = tgSent[tgSent.length - 1]; assert.match(msg.text, /Доставка вашим курьером/); assert.match(msg.text, /платит магазину при получении/); assert.ok(!/Яндекс/.test(msg.text));
    // statuses: accept → assembling → "courier left" (on_way, no Yandex search) → delivered; the buyer hears about the store's courier
    assert.equal((await c("PATCH", `/api/seller/shipments/${sh.id}`, { status: "assembling" }, seller)).status, 200);
    assert.equal((await c("PATCH", `/api/seller/shipments/${sh.id}`, { status: "searching" }, seller)).data.error, "bad_status", "no Yandex search when the store delivers");
    const n1 = tgSent.length;
    assert.equal((await c("PATCH", `/api/seller/shipments/${sh.id}`, { status: "on_way" }, seller)).status, 200);
    const ord = (await c("GET", `/api/orders/${o.data.order.num}`, null, t)).data.order; assert.equal(ord.ships[0].step, 2, "step 2 of the 4-step store flow");
    const cr = (await c("GET", `/api/orders/${o.data.order.num}/courier?ship=${sh.id}`, null, t)).data.courier; assert.equal(cr.pos, null); assert.ok(cr.unavailable);
    assert.equal((await c("PATCH", `/api/seller/shipments/${sh.id}`, { status: "delivered" }, seller)).status, 200);
    // the store owes Imorat Go nothing for a delivery Imorat Go did not order
    const f = (await c("GET", "/api/seller/summary", null, seller)).data.finance; assert.equal(f.delivery_due, 0); assert.equal(f.balance, 0); assert.equal(f.commission_total, 0);
    const st = (await c("GET", "/api/seller/statement", null, seller)).data; assert.equal(st.totals.sales_store, st.totals.sales); assert.equal(st.totals.due, 0);
    // the buyer got one message when the order was placed (what happens next), and the store's named delivery price reaches the buyer
    a0.db.run("UPDATE users SET tg_chat='5151' WHERE phone='998901234567'");
    const oP = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t); assert.equal(oP.status, 200);
    const placed = await until(() => tgSent.find(m => String(m.chat_id) === "5151" && new RegExp("Заказ " + oP.data.order.num + " оформлен").test(m.text || "")));
    assert.match(placed.text, /назовёт стоимость доставки/); assert.match(placed.text, /в течение 20 минут/);
    assert.equal(oP.data.order.del_store, null, "no delivery price until the store names one");
    const shP = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", oP.data.order.num);
    assert.equal((await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: 9e6 }, seller)).data.error, "bad_price");
    for (const v of [null, "", true, [], {}, "abc", 1.5, -1, "1e3"]) assert.equal((await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: v }, seller)).data.error, "bad_price", "refused: " + JSON.stringify(v));
    assert.equal((await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: "30 000" }, seller)).data.delivery_price, 30000, "digits with spaces, as people type them");
    assert.equal((await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: 25000, status: "assembling" }, seller)).status, 200, "price and the move in one call");
    const priced = await until(() => tgSent.find(m => String(m.chat_id) === "5151" && /доставка заказа .* — 25 000 сум/.test(m.text || "")));
    assert.match(priced.text, new RegExp(`К оплате при получении: ${(oP.data.order.total + 25000).toLocaleString("ru-RU").replace(/\u00a0/g, " ")} сум`.replace(/\s/g, "\\s")));
    const oP2 = (await c("GET", `/api/orders/${oP.data.order.num}`, null, t)).data.order; assert.equal(oP2.del_store, 25000); assert.equal(oP2.ships[0].delivery_price, 25000);
    assert.equal((await c("GET", "/api/seller/summary", null, seller)).data.orders.find(x => x.num === oP.data.order.num).delivery_price, 25000);
    assert.equal((await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: 0 }, seller)).status, 200, "free delivery is a price too");
    { let r; for (let i = 1; i <= 5; i++) r = await c("PATCH", `/api/seller/shipments/${shP.id}`, { delivery_price: 1000 * i }, seller); assert.equal(r.data.error, "rate_limited", "the price is not changed more than five times an hour (3 changes above + these)"); }
    await until(() => tgSent.find(m => String(m.chat_id) === "5151" && /доставка заказа .* — бесплатно/.test(m.text || "")));
    // the same from Telegram: after "Принять" the bot asks the store for the price, a typed number reaches the buyer
    const oT = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t); const shT = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", oT.data.order.num);
    await a0.tg.feed({ callback_query: { id: "cbT1", data: `acc:${shT.id}`, from: { id: 4242 }, message: { chat: { id: 4242, type: "private" }, message_id: 9 } } });
    const askP = await until(() => tgSent.find(m => String(m.chat_id) === "4242" && /Сколько будет стоить доставка/.test(m.text || "")), 4000);
    assert.ok(askP); assert.equal(a0.db.get("SELECT status FROM shipments WHERE id=?", shT.id).status, "assembling");
    await a0.tg.feed({ message: { chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: "abc" } });
    await until(() => tgSent.find(m => String(m.chat_id) === "4242" && /числом в сумах/.test(m.text || "")));
    await a0.tg.feed({ message: { chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: "30 000" } });
    await until(() => tgSent.find(m => String(m.chat_id) === "4242" && /Покупателю сообщили: доставка 30 000/.test(m.text || "")));
    await until(() => tgSent.find(m => String(m.chat_id) === "5151" && new RegExp(oT.data.order.num + " — 30 000 сум").test(m.text || "")));
    assert.equal((await c("GET", `/api/orders/${oT.data.order.num}`, null, t)).data.order.del_store, 30000);
    // a pickup order has no delivery price to name
    const oK = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, mode: "pickup" } }, t);
    const shK = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", oK.data.order.num);
    assert.equal((await c("PATCH", `/api/seller/shipments/${shK.id}`, { delivery_price: 1000 }, seller)).data.error, "not_store_delivery");
    // pickup with cash still works too
    const o2 = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, mode: "pickup" } }, t); assert.equal(o2.status, 200); assert.equal(o2.data.order.d.delivery_by, undefined);
    // money the platform never touches cannot be discounted or sold: promo codes, bundles, installation and bonus points are ignored when the buyer pays the store
    const qOnline = (await c("POST", "/api/quote", { lines: [{ id: 30, store: "santex", q: 1 }], form: { ...form, pay: "payme" }, promo: "IMORAT5", services: [30] }, t)).data.quote;
    assert.ok(qOnline.pd > 0 && qOnline.svc > 0, "the same cart paid by card does get the promo and the installation: " + JSON.stringify([qOnline.pd, qOnline.svc]));
    const q2 = (await c("POST", "/api/quote", { lines: [{ id: 30, store: "santex", q: 1 }], form, promo: "IMORAT5", services: [30], bundles: ["bath"], points: 5000 }, t)).data.quote;
    assert.equal(q2.pd, 0); assert.equal(q2.svc, 0); assert.equal(q2.disc, 0); assert.equal(q2.pts, 0); assert.equal(q2.promo, null); assert.deepEqual(q2.services, []); assert.equal(q2.total, q2.goods);
    assert.equal(q2.pay_at_store, true); assert.ok(q2.not_applied.includes("promo") && q2.not_applied.includes("services"), JSON.stringify(q2.not_applied));
    const o3 = await c("POST", "/api/orders", { lines: [{ id: 30, store: "santex", q: 1 }], form, promo: "IMORAT5", services: [30], expected_total: q2.total }, t);
    assert.equal(o3.status, 200, JSON.stringify(o3.data)); assert.equal(o3.data.order.total, o3.data.order.goods); assert.equal(o3.data.order.promo, null);
    assert.equal(a0.db.get("SELECT COUNT(*) n FROM promo_uses WHERE code='IMORAT5'").n, 0, "no promo use is recorded for a pay-at-store order");
    // the buyer cancels while the store packs: the store is told at once (a new message, not only an edit of the old card)
    const sh3 = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", o3.data.order.num);
    const seller2 = await lg("998901234569"); a0.db.run("UPDATE stores SET owner_id=(SELECT id FROM users WHERE phone='998901234569') WHERE id='santex'"); a0.db.run("UPDATE users SET store_id='santex', tg_chat='4343' WHERE phone='998901234569'");
    assert.equal((await c("PATCH", `/api/seller/shipments/${sh3.id}`, { status: "assembling" }, seller2)).status, 200);
    const n3 = tgSent.length;
    assert.equal((await c("POST", `/api/orders/${o3.data.order.num}/cancel`, {}, t)).status, 200);
    const told = await until(() => tgSent.slice(n3).find(m => m.m === "sendMessage" && String(m.chat_id) === "4343" && /отменён/.test(m.text || "")));
    assert.match(told.text, /покупатель отменил/);
    // cancelling a second time changes nothing and is refused
    assert.notEqual((await c("POST", `/api/orders/${o3.data.order.num}/cancel`, {}, t)).status, 200);
    // an admin cannot push a store-delivered shipment into the carrier flow
    const o4 = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form }, t); const sh4 = a0.db.get("SELECT * FROM shipments WHERE order_id=(SELECT id FROM orders WHERE num=?)", o4.data.order.num);
    assert.equal((await c("PATCH", `/api/admin/shipments/${sh4.id}`, { status: "searching" }, admin)).data.error, "bad_status");
    assert.equal((await c("PATCH", `/api/admin/shipments/${sh4.id}`, { status: "assembling" }, admin)).status, 200);
    // odd client data never becomes a 500: prototype names as a district, coordinates off the planet
    assert.notEqual((await c("PATCH", "/api/me", { district: "constructor" }, t)).status, 500);
    const qx = await c("POST", "/api/quote", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, district: "constructor", la: 1000, lo: -5000 } }, t); assert.equal(qx.status, 200, JSON.stringify(qx.data));
    const ox = await c("POST", "/api/orders", { lines: [{ id: 1, store: "usta", q: 1 }], form: { ...form, district: "__proto__", la: "91", lo: "abc" } }, t); assert.equal(ox.status, 200, JSON.stringify(ox.data));
    await new Promise(r => setTimeout(r, 400)); // let the status notifications finish before the database closes
  } finally { a0.stopJobs(); a0.close(); a0.closeAllConnections(); a0.db.raw.close(); rmSync(d0, { recursive: true, force: true }); }
});

test("Owner by login/password from .env, helper accounts the owner adds: moderation yes, money and analytics no", async () => {
  assert.ok(verifyPassword("Owner-Pass-123!", hashPassword("Owner-Pass-123!"))); assert.equal(verifyPassword("Owner-Pass-123!", hashPassword("Other-Pass-123!")), false); assert.equal(verifyPassword("x", null), false);
  assert.throws(() => hashPassword("short"), /weak_password|10 to 256/); assert.throws(() => hashPassword(1234567890123), /weak_password|must be a string/);
  // 1) wrong and right password; unknown login answers the same way
  assert.equal((await call("POST", "/api/auth/staff", { login: "umv_test", password: "nope-nope-nope" })).status, 401);
  assert.equal((await call("POST", "/api/auth/staff", { login: "nobody", password: "Owner-Pass-123!" })).data.error, "bad_login");
  const own = await call("POST", "/api/auth/staff", { login: "UMV_TEST", password: "Owner-Pass-123!" }); // the login is case-insensitive
  assert.equal(own.status, 200, JSON.stringify(own.data)); assert.equal(own.data.user.owner, true); assert.equal(own.data.user.admin, true); assert.equal(own.data.user.via, "password"); assert.equal(own.data.user.staff.login, "umv_test"); assert.equal(own.data.user.staff.env, true);
  const ownerRaw = own.data.token;
  assert.equal((await call("GET", "/api/me", null, ownerRaw)).data.user.owner, true);
  // the owner's panel still needs the authenticator code (ADMIN_MFA is on in this app)
  assert.equal((await call("GET", "/api/admin/staff", null, ownerRaw)).data.error, "mfa_setup_required");
  const setup = await call("POST", "/api/admin/mfa/setup", null, ownerRaw); const owner = (await call("POST", "/api/admin/mfa/verify", { code: totp(setup.data.secret, Date.now() + 30000) }, ownerRaw)).data.token; assert.ok(owner);
  const list0 = await call("GET", "/api/admin/staff", null, owner); assert.equal(list0.status, 200); assert.equal(list0.data.staff.length, 1); assert.equal(list0.data.staff[0].env, true); assert.equal(list0.data.owner_env, true);
  // 2) the owner adds a helper: a temporary password comes back once
  assert.equal((await call("POST", "/api/admin/staff", { login: "a b" }, owner)).data.error, "bad_login_name");
  assert.equal((await call("POST", "/api/admin/staff", { login: "umv_test" }, owner)).data.error, "login_taken");
  const mk = await call("POST", "/api/admin/staff", { login: "dilshod", name: "Дильшод", note: "друг, помогает с модерацией" }, owner);
  assert.equal(mk.status, 200, JSON.stringify(mk.data)); assert.equal(mk.data.staff.role, "admin"); assert.equal(mk.data.staff.must_change, true); assert.match(mk.data.password, /^[A-Za-z0-9]{14}$/);
  const hl = await call("POST", "/api/auth/staff", { login: "dilshod", password: mk.data.password });
  assert.equal(hl.status, 200); assert.equal(hl.data.user.admin, true); assert.equal(hl.data.user.owner, false); assert.equal(hl.data.user.staff.must_change, true); assert.equal(hl.data.user.name, "Дильшод");
  // 3) the helper must change the temporary password; weak or wrong-old attempts are refused
  assert.equal((await call("POST", "/api/me/password", { old: mk.data.password, password: "short" }, hl.data.token)).data.error, "weak_password");
  assert.equal((await call("POST", "/api/me/password", { old: "wrong-wrong", password: "Helper-Pass-456!" }, hl.data.token)).data.error, "bad_login");
  const ch = await call("POST", "/api/me/password", { old: mk.data.password, password: "Helper-Pass-456!" }, hl.data.token); assert.equal(ch.status, 200); assert.equal(ch.data.user.staff.must_change, false);
  assert.equal((await call("GET", "/api/me", null, hl.data.token)).status, 401, "the old session ended with the password change");
  const helperRaw = ch.data.token;
  // 4) the helper moderates (after setting up the authenticator) but sees no money and no analytics
  const hs = await call("POST", "/api/admin/mfa/setup", null, helperRaw); const helper = (await call("POST", "/api/admin/mfa/verify", { code: totp(hs.data.secret, Date.now() + 30000) }, helperRaw)).data.token; assert.ok(helper);
  assert.equal((await call("GET", "/api/admin/problems", null, helper)).status, 200);
  assert.equal((await call("GET", "/api/admin/stores", null, helper)).status, 200);
  for (const p of ["/api/admin/finance", "/api/admin/dashboard", "/api/admin/staff", "/api/admin/audit"]) assert.equal((await call("GET", p, null, helper)).data.error, "owner_only", p);
  assert.equal((await call("PATCH", "/api/admin/orders/IM-100001/pay", { pay_status: "paid" }, helper)).data.error, "owner_only");
  assert.equal((await call("POST", "/api/admin/staff", { login: "another" }, helper)).data.error, "owner_only", "a helper cannot add helpers");
  assert.equal((await call("GET", "/api/admin/finance", null, owner)).status, 200, "the owner does see the money");
  // 5) owner-side management: reset the password, disable, enable; the owner's own row is managed on the server
  const rs = await call("PATCH", `/api/admin/staff/${mk.data.staff.id}`, { reset_password: true }, owner); assert.match(rs.data.password, /^[A-Za-z0-9]{14}$/);
  assert.equal((await call("GET", "/api/me", null, helper)).status, 401, "a reset ends the helper's sessions");
  assert.equal((await call("POST", "/api/auth/staff", { login: "dilshod", password: "Helper-Pass-456!" })).status, 401);
  const hl2 = await call("POST", "/api/auth/staff", { login: "dilshod", password: rs.data.password }); assert.equal(hl2.status, 200);
  assert.equal((await call("PATCH", `/api/admin/staff/${mk.data.staff.id}`, { disabled: true }, owner)).data.staff.disabled, true);
  assert.equal((await call("POST", "/api/auth/staff", { login: "dilshod", password: rs.data.password })).status, 401, "a disabled helper cannot sign in");
  assert.equal((await call("GET", "/api/me", null, hl2.data.token)).status, 401);
  assert.equal((await call("PATCH", `/api/admin/staff/${mk.data.staff.id}`, { disabled: false }, owner)).data.staff.disabled, false);
  assert.equal((await call("PATCH", `/api/admin/staff/${list0.data.staff[0].id}`, { disabled: true }, owner)).data.error, "owner_env");
  assert.equal((await call("POST", "/api/me/password", { old: "Owner-Pass-123!", password: "New-Owner-Pass-1" }, ownerRaw)).data.error, "owner_env");
  assert.equal((await call("DELETE", "/api/me", { confirm: true }, ownerRaw)).data.error, "staff_account");
  // 6) a phone admin (ADMIN_PHONES) is an owner too; a buyer is neither
  assert.equal((await call("GET", "/api/me", null, globalThis.ADMIN)).data.user.owner, true);
  const buyer = (await login("998880099")).data.token; assert.equal((await call("GET", "/api/me", null, buyer)).data.user.owner, false); assert.equal((await call("GET", "/api/me", null, buyer)).data.user.admin, false);
  assert.equal((await call("POST", "/api/me/password", { old: "x", password: "Whatever-Pass-1" }, buyer)).data.error, "no_password");
  // 7) a temporary password opens nothing but the password form, even with the authenticator on
  const tmp = hl2.data.token; assert.equal((await call("GET", "/api/me", null, tmp)).status, 401, "disable+enable ended that session; sign in again");
  assert.equal((await call("PATCH", `/api/admin/staff/${mk.data.staff.id}`, { reset_mfa: true }, owner)).data.staff.mfa, false, "the owner resets a lost authenticator");
  const hl3 = await call("POST", "/api/auth/staff", { login: "dilshod", password: rs.data.password }); assert.equal(hl3.status, 200); assert.equal(hl3.data.user.staff.must_change, true);
  assert.equal((await call("GET", "/api/admin/problems", null, hl3.data.token)).data.error, "password_change_required");
  const rs2 = { data: { password: rs.data.password } };
  assert.equal((await call("POST", "/api/me/password", { old: rs2.data.password, password: rs2.data.password }, hl3.data.token)).data.error, "weak_password", "the temporary password cannot be kept");
  assert.equal((await call("POST", "/api/me/password", { old: rs2.data.password, password: 12345678901 }, hl3.data.token)).data.error, "weak_password", "a number is not a password");
  assert.equal((await call("POST", "/api/me/password", { old: ["x"], password: "Helper-Pass-789!" }, hl3.data.token)).data.error, "bad_login");
  const ch2 = await call("POST", "/api/me/password", { old: rs2.data.password, password: "Helper-Pass-789!" }, hl3.data.token); assert.equal(ch2.status, 200);
  const hs2 = await call("POST", "/api/admin/mfa/setup", null, ch2.data.token); const helper2 = (await call("POST", "/api/admin/mfa/verify", { code: totp(hs2.data.secret, Date.now() + 30000) }, ch2.data.token)).data.token; assert.ok(helper2, "a new authenticator after the reset");
  assert.equal((await call("GET", "/api/admin/problems", null, helper2)).status, 200);
  // 8) a staff account keeps its role and owns no store; a helper may not move a store or change its free months
  assert.equal((await call("PATCH", "/api/me", { role: "pro" }, helper2)).data.error, "staff_account");
  assert.equal((await call("PATCH", "/api/me", { name: "Дильшод Х." }, helper2)).status, 200, "the name still changes");
  assert.equal((await call("POST", "/api/seller/store", { name: "Магазин помощника", descr: "x".repeat(20), cats: ["build"], phone: "998712223344", addr: "ул. Такая, 1", district: "chil" }, helper2)).data.error, "staff_account");
  const anyStore = (await call("GET", "/api/admin/stores", null, helper2)).data.stores[0];
  assert.equal((await call("PATCH", `/api/admin/stores/${anyStore.id}`, { free_until: "" }, helper2)).data.error, "owner_only");
  assert.equal((await call("PATCH", `/api/admin/stores/${anyStore.id}`, { owner_phone: "998880099" }, helper2)).data.error, "owner_only");
  assert.equal((await call("PATCH", `/api/admin/stores/${anyStore.id}`, { note: "проверено" }, helper2)).status, 200, "moderation notes are the helper's job");
  // 9) brute force: FAILURES are counted per login+IP, so a stranger guessing the owner's login cannot lock the owner out; a success clears the count
  for (let i = 0; i < 8; i++) await call("POST", "/api/auth/staff", { login: "umv_test", password: "guess-" + i });
  assert.equal((await call("POST", "/api/auth/staff", { login: "umv_test", password: "Owner-Pass-123!" })).status, 200, "the owner still signs in after 8 failures from this address");
  let last; for (let i = 0; i < 12; i++) last = await call("POST", "/api/auth/staff", { login: "dilshod", password: "guess-" + i });
  assert.equal(last.status, 429);
  assert.equal((await call("POST", "/api/auth/staff", { login: ["dilshod"], password: { x: 1 } })).status, 401, "odd JSON types answer like a wrong password");
  // the audit trail names the sign-ins and the failures, and keeps only real-looking logins
  const log = (await call("GET", "/api/admin/audit", null, owner)).data.log; assert.ok(log.some(x => x.action === "staff.login_fail" && x.target === "dilshod")); assert.ok(log.some(x => x.action === "staff.create"));
  await call("POST", "/api/auth/staff", { login: "<script>alert(1)</script>", password: "x" }); assert.ok(!(await call("GET", "/api/admin/audit", null, owner)).data.log.some(x => /script/.test(x.target || "")));
});

test("Owner restart: a new password in .env ends old sessions, no OWNER_LOGIN disables the row, a helper on the owner's login is renamed", async () => {
  const d6 = mkdtempSync(join(tmpdir(), "imorat-own-"));
  const env = { JWT_SECRET: "x", DB_PATH: join(d6, "o.db"), UPLOADS_DIR: join(d6, "up"), ADMIN_PHONES: "998901111111", SMS_MODE: "dev", OTP_PER_IP_HOUR: "200" };
  const boot = async extra => { const a = createApp(loadConfig({ ...env, ...extra }), { info() {}, warn() {}, error: console.error }); await new Promise(r => a.listen(0, "127.0.0.1", r)); const b = `http://127.0.0.1:${a.address().port}`;
    return { a, c: async (method, path, body, token) => { const r = await fetch(b + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; }, stop() { a.stopJobs(); a.close(); a.closeAllConnections(); a.db.raw.close(); } }; };
  try {
    let s = await boot({ OWNER_LOGIN: "boss", OWNER_PASSWORD_HASH: hashPassword("First-Pass-123!") });
    const t1 = (await s.c("POST", "/api/auth/staff", { login: "boss", password: "First-Pass-123!" })).data.token; assert.ok(t1);
    // a helper is added under a login the owner will take later (the owner's env login wins on restart)
    const adm = (await s.c("POST", "/api/auth/otp/verify", { phone: "998901111111", code: (await s.c("POST", "/api/auth/otp/send", { phone: "998901111111" })).data.dev_code })).data.token;
    const setup = await s.c("POST", "/api/admin/mfa/setup", null, adm); const admM = (await s.c("POST", "/api/admin/mfa/verify", { code: totp(setup.data.secret, Date.now() + 30000) }, adm)).data.token;
    const mk = await s.c("POST", "/api/admin/staff", { login: "Chief" }, admM); assert.equal(mk.status, 200, JSON.stringify(mk.data));
    s.stop();
    // 1) the same login with a new hash: the old owner token is dead, the new password works
    s = await boot({ OWNER_LOGIN: "boss", OWNER_PASSWORD_HASH: hashPassword("Second-Pass-456!") });
    assert.equal((await s.c("GET", "/api/me", null, t1)).status, 401, "rotating the password in .env signs the owner out everywhere");
    assert.equal((await s.c("POST", "/api/auth/staff", { login: "boss", password: "First-Pass-123!" })).status, 401);
    const t2 = (await s.c("POST", "/api/auth/staff", { login: "boss", password: "Second-Pass-456!" })).data.token; assert.ok(t2);
    s.stop();
    // 2) OWNER_LOGIN renamed onto the helper's login (case differs): the helper row is renamed and disabled, the owner signs in, no crash
    s = await boot({ OWNER_LOGIN: "chief", OWNER_PASSWORD_HASH: hashPassword("Second-Pass-456!") });
    assert.equal((await s.c("GET", "/api/me", null, t2)).status, 401, "a new login is a new identity for old tokens too");
    const t3 = await s.c("POST", "/api/auth/staff", { login: "chief", password: "Second-Pass-456!" }); assert.equal(t3.status, 200); assert.equal(t3.data.user.owner, true);
    assert.equal((await s.c("POST", "/api/auth/staff", { login: "Chief", password: mk.data.password })).status, 401, "the helper's old login now belongs to the owner");
    const rows = s.a.db.all("SELECT login, disabled, from_env FROM staff ORDER BY from_env DESC"); assert.equal(rows[0].login, "chief"); assert.match(rows[1].login, /^Chief\.old-/); assert.equal(rows[1].disabled, 1);
    s.stop();
    // 3) no OWNER_LOGIN at all: the env row is disabled and its sessions end; phone admins still work
    s = await boot({});
    assert.equal((await s.c("GET", "/api/me", null, t3.data.token)).status, 401);
    assert.equal((await s.c("POST", "/api/auth/staff", { login: "chief", password: "Second-Pass-456!" })).status, 401);
    s.stop();
  } finally { rmSync(d6, { recursive: true, force: true }); }
});

test("App: push tokens, order notifications through FCM and APNs, dead tokens dropped, reviewers' fixed code, account deletion", async () => {
  // reviewers' account: fixed code, no SMS, any SMS mode
  const n0 = sms.length;
  assert.equal((await call("POST", "/api/auth/otp/send", { phone: "998900000001" })).data.dev_code, undefined, "the fixed code is never returned");
  assert.equal(sms.length, n0, "nothing was sent");
  assert.equal((await call("POST", "/api/auth/otp/verify", { phone: "998900000001", code: "000000" })).data.error, "otp_wrong");
  const rv = await call("POST", "/api/auth/otp/verify", { phone: "998900000001", code: "246810" }); assert.equal(rv.status, 200); assert.ok(rv.data.token);
  // a buyer registers two phones (Android + iPhone) and a dead one of each
  const buyer = (await login("998907000011")).data.token;
  assert.equal((await call("POST", "/api/me/devices", { platform: "web", token: "x".repeat(20) }, buyer)).status, 400);
  for (const [platform, token] of [["android", "android-token-1234567890abcdef"], ["ios", "ios-token-1234567890abcdef1234"], ["android", "android-dead-token-0000000000"], ["ios", "ios-dead-token-00000000000000"]])
    assert.equal((await call("POST", "/api/me/devices", { platform, token, lang: "uz", app_ver: "1.0.0" }, buyer)).data.push, true, platform);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM devices WHERE user_id=(SELECT id FROM users WHERE phone='998907000011')").n, 4);
  // the same token moving to another person is re-bound, not duplicated
  const other = (await login("998907000022")).data.token;
  await call("POST", "/api/me/devices", { platform: "android", token: "android-token-1234567890abcdef" }, other);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM devices WHERE token='android-token-1234567890abcdef'").n, 1);
  await call("POST", "/api/me/devices", { platform: "android", token: "android-token-1234567890abcdef" }, buyer);
  // a card-paid order → the "paid" notification reaches both phones with a link to the order; dead tokens are dropped
  const sid = app.db.get("SELECT id FROM stores WHERE status='active' AND id IN (SELECT store_id FROM offers WHERE product_id=1 AND stock>0) LIMIT 1").id;
  const f0 = fcmSent.length, a0 = apnsSent.length;
  const o = await call("POST", "/api/orders", { lines: [{ id: 1, store: sid, q: 1 }], form: { name: "Пуш", phone: "998907000011", mode: "pickup", pay: "payme" } }, buyer); assert.equal(o.status, 200, JSON.stringify(o.data));
  const rpc = (method, params) => fetch(base + "/api/pay/payme", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("Paycom:PAYME_SECRET").toString("base64") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  await rpc("CreateTransaction", { id: "push-1", time: Date.now(), amount: o.data.order.total * 100, account: { order: o.data.order.num } }); assert.equal((await rpc("PerformTransaction", { id: "push-1" })).result?.state, 2);
  await new Promise(r => setTimeout(r, 400));
  const fc = fcmSent.slice(f0), ap = apnsSent.slice(a0);
  assert.ok(fc.some(m => m.token === "android-token-1234567890abcdef" && m.notification.title.includes(o.data.order.num) && m.data.url.endsWith("#orders") && m.android.notification.channel_id === "orders"), JSON.stringify(fc));
  assert.ok(ap.some(m => m.path === "/3/device/ios-token-1234567890abcdef1234" && m.topic === "uz.imorat.app" && m.type === "alert" && m.body.aps.alert.title.includes(o.data.order.num) && m.body.url.endsWith("#orders") && /^bearer /.test(m.auth)), JSON.stringify(ap));
  assert.equal(app.db.get("SELECT COUNT(*) n FROM devices WHERE token LIKE '%dead%'").n, 0, "tokens the providers rejected are gone");
  // sign out everywhere clears the phones; deleting the account wipes personal data but keeps the order's accounting trail
  assert.equal((await call("DELETE", "/api/me/devices", { token: "ios-token-1234567890abcdef1234" }, buyer)).status, 200);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM devices WHERE user_id=(SELECT id FROM users WHERE phone='998907000011')").n, 1);
  assert.equal((await call("DELETE", "/api/me", {}, buyer)).data.error, "confirm");
  assert.equal((await call("DELETE", "/api/me", { confirm: true }, buyer)).data.error, "active_orders", "a paid order is still with the store");
  const sh = (await call("GET", `/api/orders/${o.data.order.num}`, null, buyer)).data.order.ships[0].id;
  for (const st of ["assembling", "ready", "picked"]) assert.equal((await call("PATCH", `/api/admin/shipments/${sh}`, { status: st }, globalThis.ADMIN)).status, 200);
  assert.equal((await call("DELETE", "/api/me", { confirm: true }, buyer)).status, 200);
  assert.equal((await call("GET", "/api/me", null, buyer)).status, 401, "old sessions are dead");
  const row = app.db.get("SELECT * FROM users WHERE id=(SELECT user_id FROM orders WHERE num=?)", o.data.order.num);
  assert.match(row.phone, /^deleted:/); assert.equal(row.name, ""); assert.ok(row.deleted_at);
  const of = JSON.parse(app.db.get("SELECT form FROM orders WHERE num=?", o.data.order.num).form); assert.equal(of.phone, ""); assert.equal(of.name, ""); assert.equal(of.deleted, true);
  assert.equal(app.db.get("SELECT goods FROM orders WHERE num=?", o.data.order.num).goods, o.data.order.goods, "sums stay for the accounting");
  assert.equal(app.db.get("SELECT COUNT(*) n FROM devices WHERE user_id=?", row.id).n, 0);
  const again = (await login("998907000011")).data; assert.ok(again.token); assert.equal(again.is_new, true, "the same phone starts a fresh account");
});

test("Support chat: a person writes, the team sees the thread and answers, the answer reaches Telegram; helpers see it, strangers do not", async () => {
  const u = (await login("998881234")).data.token;
  assert.equal((await call("GET", "/api/support")).status, 401, "signed-in only");
  assert.equal((await call("POST", "/api/support", { text: "" }, u)).data.error, "bad_text");
  const m1 = await call("POST", "/api/support", { text: "Где мой заказ? Жду с утра", topic: "order", order: "IM-000000" }, u);
  assert.equal(m1.status, 200); assert.equal(m1.data.messages.length, 1); assert.equal(m1.data.messages[0].order, null, "someone else's / unknown order number is dropped");
  await until(() => tgSent.some(x => /Поддержка/.test(x.text) && /Где мой заказ/.test(x.text)));
  const other = (await login("998881235")).data.token;
  assert.equal((await call("GET", "/api/support", null, other)).data.messages.length, 0, "each person sees only their own thread");
  assert.equal((await call("GET", "/api/admin/support", null, other)).status, 403);
  const list = await call("GET", "/api/admin/support", null, globalThis.ADMIN); assert.equal(list.status, 200);
  const uid = (await call("GET", "/api/me", null, u)).data.user.id;
  const th = list.data.threads.find(t => t.user === uid); assert.ok(th, JSON.stringify(list.data)); assert.equal(th.unread, 1);
  const open = await call("GET", `/api/admin/support/${th.user}`, null, globalThis.ADMIN); assert.equal(open.data.messages[0].text, "Где мой заказ? Жду с утра");
  assert.equal((await call("GET", "/api/admin/support", null, globalThis.ADMIN)).data.threads.find(t => t.user === th.user).unread, 0, "opening marks it read");
  const ans = await call("POST", `/api/admin/support/${th.user}`, { text: "Заказ у магазина, курьер выедет до 14:00" }, globalThis.ADMIN);
  assert.equal(ans.status, 200); assert.equal(ans.data.messages.at(-1).from, "staff");
  assert.equal((await call("GET", "/api/support?peek=1", null, u)).data.unread, 1);
  const mine = await call("GET", "/api/support", null, u); assert.equal(mine.data.messages.length, 2); assert.equal(mine.data.messages[1].text, "Заказ у магазина, курьер выедет до 14:00");
  assert.equal((await call("GET", "/api/support?peek=1", null, u)).data.unread, 0);
  assert.equal((await call("POST", `/api/admin/support/${(await call("GET", "/api/me", null, other)).data.user.id}`, { text: "привет" }, globalThis.ADMIN)).data.error, "no_thread", "the team answers threads, it does not start them");
  // a visitor without an account writes from the site: name and phone with the first message; the team answers into the same chat
  const key = "guestkey_" + "x".repeat(24);
  assert.equal((await call("POST", "/api/support/guest/send", { guest: "short", text: "привет", name: "Аня", phone: "901112233" })).data.error, "bad_guest");
  assert.equal((await call("POST", "/api/support/guest/send", { guest: key, text: "Есть ли доставка в Чирчик?" })).data.error, "bad_name", "the first message needs a name");
  assert.equal((await call("POST", "/api/support/guest/send", { guest: key, text: "Есть ли доставка в Чирчик?", name: "Аня", phone: "12" })).data.error, "bad_phone");
  const g1 = await call("POST", "/api/support/guest/send", { guest: key, text: "Есть ли доставка в Чирчик?", name: "Аня", phone: "90 111 22 33" }); assert.equal(g1.status, 200); assert.equal(g1.data.messages.length, 1);
  await until(() => tgSent.some(x => /без входа/.test(x.text) && /Чирчик/.test(x.text)));
  assert.equal((await call("POST", "/api/support/guest/send", { guest: key, text: "И сколько стоит?" })).status, 200, "later messages need no name again");
  const gt = (await call("GET", "/api/admin/support", null, globalThis.ADMIN)).data.threads.find(t => t.guest && t.name === "Аня"); assert.ok(gt); assert.equal(gt.phone, "998901112233"); assert.equal(gt.unread, 2);
  assert.equal((await call("POST", `/api/admin/support/${gt.user}`, { text: "Да, доставляем, 60 000 сум" }, globalThis.ADMIN)).status, 200);
  const gr = await call("POST", "/api/support/guest", { guest: key, peek: true }); assert.equal(gr.data.unread, 1); assert.equal(gr.data.messages.at(-1).text, "Да, доставляем, 60 000 сум");
  assert.equal((await call("POST", "/api/support/guest", { guest: "guestkey_" + "y".repeat(24) })).data.messages.length, 0, "another key sees nothing");
});

test("Moderation: a store's new product and a review text wait for the team; rejection needs a note; approval publishes", async () => {
  CFG.productAutoApprove = false;
  try {
    const seller = (await login("997770001")).data.token;
    const st = await call("POST", "/api/seller/store", { name: "Moder Test", descr: "Магазин для проверки модерации товаров", cats: ["build"], phone: "71 200 30 41", addr: "ул. Тестовая, 1", district: "chil" }, seller);
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal((await call("PATCH", `/api/admin/stores/${st.data.store.id}`, { status: "active" }, globalThis.ADMIN)).status, 200);
    const np = await call("POST", "/api/seller/products", { ru: "Клей плиточный Moder, 25 кг", cat: "build", sub: "dry", unit: "bag50", price: 41000, stock: 30, kg: 25 }, seller);
    assert.equal(np.status, 200); assert.equal(np.data.product.review, "pending");
    const pid = np.data.product.id;
    assert.ok(!(await call("GET", "/api/catalog")).data.products.some(p => p.id === pid), "not in the catalogue before the check");
    const q = await call("POST", "/api/quote", { lines: [{ id: pid, store: st.data.store.id, q: 1 }], form: { mode: "pickup", district: "chil", name: "x", phone: "x" } }, seller);
    assert.equal(q.data.quote.ships.length, 0, "not orderable before the check"); assert.ok(q.data.problems?.some(x => x.id === pid && x.reason === "unavailable") ?? true);
    await until(() => tgSent.some(x => /Новые товары на проверке/.test(x.text) && /Клей плиточный Moder/.test(x.text)));
    const mod = await call("GET", "/api/admin/moderation", null, globalThis.ADMIN); assert.ok(mod.data.products.some(p => p.id === pid && p.store_name === "Moder Test"));
    assert.equal((await call("GET", "/api/admin/moderation", null, seller)).status, 403);
    assert.equal((await call("POST", `/api/admin/products/${pid}/review`, { ok: false }, globalThis.ADMIN)).data.error, "note_required");
    const summary = (await call("GET", "/api/seller/summary", null, seller)).data.products.find(p => p.id === pid); assert.equal(summary.review, "pending", "the store sees the status");
    assert.equal((await call("POST", `/api/admin/products/${pid}/review`, { ok: true }, globalThis.ADMIN)).status, 200);
    assert.ok((await call("GET", "/api/catalog")).data.products.some(p => p.id === pid), "published after approval");
    assert.equal((await call("POST", `/api/admin/products/${pid}/review`, { ok: false, note: "x x x" }, globalThis.ADMIN)).data.error, "already_decided");
    const np2 = await call("POST", "/api/seller/products", { ru: "Гвозди непонятные", cat: "build", sub: "dry", unit: "bag50", price: 1000, stock: 3, kg: 1 }, seller);
    assert.equal((await call("POST", `/api/admin/products/${np2.data.product.id}/review`, { ok: false, note: "Нет описания и фото, неверная категория" }, globalThis.ADMIN)).status, 200);
    assert.equal((await call("GET", "/api/seller/summary", null, seller)).data.products.find(p => p.id === np2.data.product.id).review_note, "Нет описания и фото, неверная категория");
    // a review text waits; its author sees it, others do not
    const buyer = (await login("997770002")).data.token, bid = (await call("GET", "/api/me", null, buyer)).data.user.id;
    const rid = Number(app.db.run("INSERT INTO product_reviews(product_id,user_id,stars,text,created_at,mod) VALUES(?,?,?,?,?,?)", pid, bid, 5, "Отличный клей", Date.now(), "pending").lastInsertRowid);
    assert.equal((await call("GET", `/api/products/${pid}/reviews`)).data.reviews.length, 0);
    assert.equal((await call("GET", `/api/products/${pid}/reviews`, null, buyer)).data.reviews[0].pending, true);
    assert.ok((await call("GET", "/api/admin/moderation", null, globalThis.ADMIN)).data.reviews.some(r => r.kind === "product" && r.id === rid));
    assert.equal((await call("POST", `/api/admin/reviews/product/${rid}`, { ok: true }, globalThis.ADMIN)).status, 200);
    assert.equal((await call("GET", `/api/products/${pid}/reviews`)).data.reviews[0].text, "Отличный клей");
  } finally { CFG.productAutoApprove = true; }
});
