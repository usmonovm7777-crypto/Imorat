import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

/* ---- fake external services: Eskiz, Yandex, Anthropic, Google JWKS ---- */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const sms = [];
const fake = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/eskiz/auth/login") return json(200, { data: { token: "T" } });
  if (req.url === "/eskiz/message/sms/send") { sms.push(body); return json(200, { id: "1", status: "waiting" }); }
  if (req.url === "/ya/b2b/cargo/integration/v2/check-price") { const b = JSON.parse(body); return json(200, { price: b.requirements.taxi_class === "express" ? "21000.00" : "99000.00", eta: 30 }); }
  if (req.url === "/jwks") return json(200, { keys: [jwk] });
  if (req.url === "/ai/v1/messages") {
    const b = JSON.parse(body);
    assert.equal(req.headers["x-api-key"], "sk-test");
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
    GOOGLE_CLIENT_ID: "gid", GOOGLE_JWKS_URL: fakeBase + "/jwks", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_URL: fakeBase + "/ai", SMS_MODE: "dev"
  });
  app = createApp(cfg, { info() {}, warn() {}, error: console.error });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { app.close(); fake.close(); app.db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

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
  assert.equal(o.data.order.pay_status, "on_delivery");
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
  const admin = (await login("901111111")).data.token;
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
  a2.close(); a2.db.raw.close(); rmSync(d2, { recursive: true, force: true });
});
