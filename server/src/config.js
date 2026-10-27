import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

/* Reads settings from environment variables (and an optional .env file next to package.json). */
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
export const normPhone = p => { const d = String(p || "").replace(/\D/g, ""); return d.length === 9 ? "998" + d : d; };

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === "production";
  if (prod && !env.JWT_SECRET) throw new Error("JWT_SECRET is required in production (any long random string)");
  const smsMode = env.SMS_MODE || (env.ESKIZ_EMAIL ? "eskiz" : "dev");
  return {
    prod,
    port: Number(env.PORT) || 8787,
    host: env.HOST || "0.0.0.0",
    dbPath: env.DB_PATH || "data/imorat.db",
    catalogPath: env.CATALOG_PATH || new URL("../data/catalog.json", import.meta.url).pathname,
    uploadsDir: env.UPLOADS_DIR || "uploads",
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    origins: list(env.ALLOWED_ORIGINS || "https://usmonovm7777-crypto.github.io,http://localhost:8080,http://127.0.0.1:8080"),
    jwtSecret: env.JWT_SECRET || randomBytes(32).toString("hex"),
    admins: list(env.ADMIN_PHONES).map(normPhone),
    vipFree: env.VIP_FREE !== "0",
    sms: {
      mode: smsMode, // "eskiz" sends real SMS, "dev" returns the code in the API response (testing only)
      eskizUrl: (env.ESKIZ_URL || "https://notify.eskiz.uz/api").replace(/\/$/, ""),
      eskizEmail: env.ESKIZ_EMAIL || "",
      eskizPassword: env.ESKIZ_PASSWORD || "",
      eskizFrom: env.ESKIZ_FROM || "4546",
      template: env.SMS_TEMPLATE || "Imorat: tasdiqlash kodi {code}. Kodni hech kimga bermang."
    },
    google: { clientId: env.GOOGLE_CLIENT_ID || "", jwksUrl: env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs" },
    apple: { clientId: env.APPLE_CLIENT_ID || "", redirectUri: env.APPLE_REDIRECT_URI || "", jwksUrl: env.APPLE_JWKS_URL || "https://appleid.apple.com/auth/keys" },
    ai: {
      key: env.ANTHROPIC_API_KEY || "",
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      url: (env.ANTHROPIC_URL || "https://api.anthropic.com").replace(/\/$/, ""),
      maxTokens: Number(env.AI_MAX_TOKENS) || 1200,
      dailyUser: Number(env.AI_DAILY_LIMIT) || 60,
      dailyGuest: Number(env.AI_GUEST_DAILY_LIMIT) || 15
    },
    yandex: { token: env.YANDEX_DELIVERY_TOKEN || "", url: (env.YANDEX_DELIVERY_URL || "https://b2b.taxi.yandex.net").replace(/\/$/, "") }
  };
}
