import { loadDotEnv, loadConfig } from "./config.js";
import { createApp } from "./app.js";

loadDotEnv();
const cfg = loadConfig();
const log = { info: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), ...a), error: (...a) => console.error(new Date().toISOString(), ...a) };
const server = createApp(cfg, log);
server.listen(cfg.port, cfg.host, () => {
  log.info(`Imorat API on http://${cfg.host}:${cfg.port}`);
  log.info(`SMS: ${cfg.sms.mode}${cfg.sms.mode === "dev" ? " (codes are returned in the API response — testing only)" : ""} · AI: ${cfg.ai.key ? cfg.ai.model : "off"} · Yandex: ${cfg.yandex.token ? "on" : "estimate"} · Google: ${cfg.google.clientId ? "on" : "off"} · Apple: ${cfg.apple.clientId ? "on" : "off"}`);
  if (!process.env.JWT_SECRET) log.warn("JWT_SECRET is not set: sessions reset on every restart. Set it in .env");
  if (!cfg.admins.length) log.warn("ADMIN_PHONES is empty: nobody can approve new stores");
});
const stop = () => { server.close(() => { server.db.raw.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
