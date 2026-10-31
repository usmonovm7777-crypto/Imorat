/* Copies the built website into www/ for the app. API address: env IMORAT_API or the one in ../config.js */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."), www = join(root, "app", "www");
rmSync(www, { recursive: true, force: true }); mkdirSync(www, { recursive: true });
for (const f of ["index.html", "manifest.webmanifest"]) cpSync(join(root, f), join(www, f));
for (const d of ["img", "icons", "templates"]) cpSync(join(root, d), join(www, d), { recursive: true });
const siteCfg = existsSync(join(root, "config.js")) ? readFileSync(join(root, "config.js"), "utf8") : "";
const api = process.env.IMORAT_API ?? (siteCfg.match(/IMORAT_API\s*=\s*"([^"]*)"/) || [])[1] ?? "";
// Inside the app there is no service worker; notifications come through Telegram (and native push later)
writeFileSync(join(www, "config.js"), `window.IMORAT_API = ${JSON.stringify(api)};\nwindow.IMORAT_SITE = false;\nwindow.IMORAT_APP = true;\n`);
console.log("www ready, API =", api || "(demo mode)");
