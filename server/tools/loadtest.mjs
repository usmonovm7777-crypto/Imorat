// Load test: many shoppers at once against a fresh server
import { createApp } from "/home/claude/imorat-site/server/src/app.js";
import { loadConfig } from "/home/claude/imorat-site/server/src/config.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import http from "node:http";
const mode = process.argv[2];
if (mode === "server") {
  const dir = mkdtempSync(join(tmpdir(), "load-"));
  const app = createApp(loadConfig({ JWT_SECRET: "x", DB_PATH: join(dir, "t.db"), UPLOADS_DIR: join(dir, "up"), SMS_MODE: "dev", ADMIN_PHONES: "", OTP_PER_IP_HOUR: "100000", RATE_PER_IP_MIN: "10000000" }), { info() {}, warn() {}, error: console.error });
  app.listen(8899, "127.0.0.1", () => console.log("ready"));
} else {
  const base = "http://127.0.0.1:8899", agent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
  const req = (method, path, body, token, headers = {}) => new Promise(res => {
    const t0 = performance.now(), data = body ? JSON.stringify(body) : null;
    const r = http.request(base + path, { method, agent, headers: { "content-type": "application/json", "accept-encoding": "gzip", ...(token ? { authorization: "Bearer " + token } : {}), ...headers } }, rs => { rs.resume(); rs.on("end", () => res({ s: rs.statusCode, ms: performance.now() - t0, etag: rs.headers.etag })); });
    r.on("error", () => res({ s: 0, ms: performance.now() - t0 })); if (data) r.write(data); r.end();
  });
  const users = [];
  for (let i = 0; i < 60; i++) { const ph = "97" + String(1000000 + i); const s = await (await fetch(base + "/api/auth/otp/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: ph }) })).json(); const v = await (await fetch(base + "/api/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: ph, code: s.dev_code }) })).json(); users.push(v.token); }
  const etag = (await req("GET", "/api/catalog")).etag;
  const form = { name: "Тест", phone: "998971000000", mode: "pickup", pay: "store" };
  const lines = [{ id: 1, store: "usta", q: 1 }, { id: 5, store: "usta", q: 20 }, { id: 30, store: "santex", q: 1 }];
  // one "shopper" step: mostly reading, sometimes ordering — roughly what a visitor does
  const step = async (u, k) => {
    const x = k % 20;
    if (x < 6) return ["catalog 304", await req("GET", "/api/catalog", null, null, { "if-none-match": etag })];
    if (x < 9) return ["events", await req("POST", "/api/events", { events: [{ t: "view", id: 1 + (k % 90) }, { t: "view", id: 2 }] })];
    if (x < 13) return ["quote", await req("POST", "/api/quote", { lines, form })];
    if (x < 15) return ["masters", await req("GET", "/api/masters")];
    if (x < 17) return ["me+orders", await req("GET", "/api/orders", null, users[u % users.length])];
    if (x < 18) return ["catalog full", await req("GET", "/api/catalog")];
    if (x < 19) return ["bonus", await req("GET", "/api/me/bonus", null, users[u % users.length])];
    return ["ORDER", await req("POST", "/api/orders", { lines: [{ id: 5, store: "usta", q: 1 }], form }, users[u % users.length])];
  };
  for (const conc of [50, 200, 500]) {
    const stats = {}, end = Date.now() + 12000; let k0 = 0;
    await Promise.all(Array.from({ length: conc }, async (_, u) => { let k = u * 7; while (Date.now() < end) { const [name, r] = await step(u, k++); const s = (stats[name] ||= { n: 0, err: 0, ms: [] }); s.n++; if (r.s >= 500 || r.s === 0 || r.s === 429) s.err++; s.ms.push(r.ms); k0++; } }));
    const all = Object.values(stats).flatMap(s => s.ms).sort((a, b) => a - b), q = p => Math.round(all[Math.floor(all.length * p)]);
    console.log(`\n=== ${conc} одновременных покупателей: ${Math.round(all.length / 12)} запросов/сек, p50 ${q(.5)} мс, p95 ${q(.95)} мс, p99 ${q(.99)} мс, ошибок ${Object.values(stats).reduce((a, s) => a + s.err, 0)}`);
    for (const [n, s] of Object.entries(stats)) { s.ms.sort((a, b) => a - b); console.log(`  ${n.padEnd(13)} ${String(s.n).padStart(6)}  p50 ${Math.round(s.ms[s.ms.length >> 1])} мс  p95 ${Math.round(s.ms[Math.floor(s.ms.length * .95)])} мс  ошибок ${s.err}`); }
  }
  process.exit(0);
}
