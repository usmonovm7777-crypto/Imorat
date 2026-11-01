/* Copies the built website into www/ for the app and writes the app's config.js.
   Settings come from the PUBLIC site settings only (../config.js and the environment):
     IMORAT_API        address of the server, e.g. https://api.imorat.uz   (env wins over config.js)
     IMORAT_YMAPS_KEY  Yandex Maps JavaScript key — a public, domain-restricted key, safe inside the app
     IMORAT_SITE_URL   public address of the website (legal pages, the way back from the bank page)
   Server secrets (server/.env: JWT, Payme/Click keys, bot token, service accounts) are never read here and never
   end up in the app: everything the app needs from them goes through the API.
   --release (or APP_RELEASE=1): a store build — refuses an empty or non-HTTPS API, so a demo can never be shipped
   as the real app. Without it the build is a test build and may run in the clearly marked demo mode. */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."), app = join(root, "app"), www = join(app, "www");
const release = process.argv.includes("--release") || process.env.APP_RELEASE === "1";
const siteCfg = existsSync(join(root, "config.js")) ? readFileSync(join(root, "config.js"), "utf8") : "";
const fromSite = key => (siteCfg.match(new RegExp(`window\\.${key}\\s*=\\s*"([^"]*)"`)) || [])[1] ?? "";
const api = (process.env.IMORAT_API || fromSite("IMORAT_API")).replace(/\/+$/, ""); // an empty variable (CI without the setting) falls back to config.js
const ymaps = process.env.IMORAT_YMAPS_KEY || fromSite("IMORAT_YMAPS_KEY");
// the website address is an explicit setting (env, else ../config.js); it is never derived from the API domain.
// Empty in a test build = the app takes the server's SITE_URL from /api/config at run time.
let siteUrl = (process.env.IMORAT_SITE_URL || fromSite("IMORAT_SITE_URL")).trim();
if (siteUrl) siteUrl = siteUrl.replace(/\/?$/, "/");
const version = JSON.parse(readFileSync(join(app, "version.json"), "utf8"));

if (release) {
  const problems = [], warnings = [];
  if (!api) problems.push("IMORAT_API is empty — a store build must talk to the real server (set it in ../config.js or the IMORAT_API variable)");
  else if ((!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(api) || /localhost|127\.0\.0\.1|\.local$/i.test(api)) && process.env.IMORAT_SELFTEST_HTTP !== "1") problems.push(`IMORAT_API looks wrong for a store build: ${api} (needs https:// and a public domain)`);
  if (siteUrl && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(siteUrl)) problems.push(`IMORAT_SITE_URL must be an https address of the website: ${siteUrl}`);
  /* The address alone proves nothing: the server must answer, be an Imorat Go server, speak the API contract this website
     was built for, and be configured for real use. Otherwise the app in the store would open onto an error screen. */
  if (api && !problems.length) {
    const page = existsSync(join(root, "index.html")) ? readFileSync(join(root, "index.html"), "utf8") : "";
    const clientContract = Number((page.match(/const API_CONTRACT = (\d+)/) || [])[1] || 0);
    if (!clientContract) problems.push("could not read API_CONTRACT from ../index.html — build the website first (python3 tools/build_site.py)");
    const get = async path => { try { const r = await fetch(api + path, { signal: AbortSignal.timeout(12000), headers: { accept: "application/json" } }); return { status: r.status, json: await r.json().catch(() => null) }; } catch (e) { return { error: e.cause?.code || e.name || String(e) }; } };
    const h = await get("/api/health"), c = await get("/api/config");
    if (h.error || !h.json) problems.push(`the server does not answer at ${api}/api/health (${h.error || "HTTP " + h.status}) — start it, open the firewall or fix the address before building the store app`);
    else if (h.json.ok !== true || h.json.name !== "imorat-api") problems.push(`${api}/api/health is not an Imorat Go server (got ${JSON.stringify(h.json).slice(0, 120)})`);
    else if (clientContract && ((h.json.contract ?? 1) < clientContract || (h.json.min_client ?? 1) > clientContract)) problems.push(`API contract mismatch: the website expects contract ${clientContract}, the server has ${h.json.contract} (serves clients ≥ ${h.json.min_client}) — update the server (imorat update) or the website so both match`);
    if (!c.error && c.json) {
      if (c.json.sms === "dev") problems.push("the server is in SMS dev mode (sign-in codes are returned in API responses) — set SMS_MODE=eskiz or telegram before shipping an app");
      if (c.json.demo && process.env.ALLOW_DEMO_STORES !== "1") problems.push("the server still seeds the 9 sample stores (DEMO_STORES is on) — real buyers would order from stores that do not exist; set DEMO_STORES=0 (or ALLOW_DEMO_STORES=1 for a test-track build)");
      if (!Array.isArray(c.json.payments) || !c.json.payments.length) warnings.push("no payment provider is connected on the server: the app will show \"payment coming soon\" and take no orders until Payme/Click keys are set");
      if (!siteUrl && c.json.site_url) { siteUrl = String(c.json.site_url).replace(/\/?$/, "/"); console.log(`IMORAT_SITE_URL taken from the server's SITE_URL: ${siteUrl}`); }
    } else if (!h.error) problems.push(`the server answered /api/health but not /api/config (${c.error || "HTTP " + c.status})`);
    if (h.json?.version) console.log(`server: imorat-api ${h.json.version}, contract ${h.json.contract}, payments ${(c.json?.payments || []).join("+") || "none"}, sms ${c.json?.sms || "?"}`);
  }
  if (!siteUrl) problems.push("IMORAT_SITE_URL is empty — set the public website address explicitly (../config.js, the IMORAT_SITE_URL variable or SITE_URL on the server); it is not guessed from the API domain");
  for (const w of warnings) console.warn("! " + w);
  if (problems.length) { console.error("\n✗ release build refused:\n  - " + problems.join("\n  - ") + "\n"); process.exit(2); }
}

rmSync(www, { recursive: true, force: true }); mkdirSync(www, { recursive: true });
for (const f of ["index.html", "manifest.webmanifest", "favicon.ico"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(www, f));
for (const d of ["img", "icons", "templates", "legal"]) if (existsSync(join(root, d))) cpSync(join(root, d), join(www, d), { recursive: true });
// Inside the app there is no service worker; notifications come natively (FCM / APNs) and through Telegram
writeFileSync(join(www, "config.js"), [
  "/* generated by app/scripts/prepare-www.mjs — public settings only */",
  `window.IMORAT_API = ${JSON.stringify(api)};`,
  "window.IMORAT_SITE = false;",
  "window.IMORAT_APP = true;",
  `window.IMORAT_APP_VERSION = ${JSON.stringify(version.versionName)};`,
  `window.IMORAT_SITE_URL = ${JSON.stringify(siteUrl)};`,
  `window.IMORAT_YMAPS_KEY = ${JSON.stringify(ymaps)};`,
  ""
].join("\n"));
console.log(`www ready: ${release ? "RELEASE" : "test"} build v${version.versionName} (${version.versionCode}), API = ${api || "(none — demo mode, test builds only)"}, site = ${siteUrl || "(from the server's /api/config at run time)"}, Yandex Maps key ${ymaps ? "set" : "empty"}`);
