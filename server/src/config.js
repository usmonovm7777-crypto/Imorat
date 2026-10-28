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
    yandex: { token: env.YANDEX_DELIVERY_TOKEN || "", url: (env.YANDEX_DELIVERY_URL || "https://b2b.taxi.yandex.net").replace(/\/$/, "") },
    telegram: { token: env.TELEGRAM_BOT_TOKEN || "", name: env.TELEGRAM_BOT_NAME || "imoratGo_bot", url: (env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, ""), pollTimeout: env.TELEGRAM_POLL_TIMEOUT != null ? Number(env.TELEGRAM_POLL_TIMEOUT) : 25 },
    pushSubject: env.VAPID_SUBJECT || "mailto:support@imorat.uz",
    siteUrl: (env.SITE_URL || "https://usmonovm7777-crypto.github.io/Imorat/").replace(/\/?$/, "/"),
    // Seller deadlines (minutes): reminder, SMS, auto-cancel if not accepted; hours to hand the order over
    timers: { remind: Number(env.ACCEPT_REMIND_MIN) || 5, sms: Number(env.ACCEPT_SMS_MIN) || 10, cancel: Number(env.ACCEPT_TIMEOUT_MIN) || 20, handover: Number(env.HANDOVER_HOURS) || 4 },
    // Commission by category, %: "build:5,metal:5,fasten:5,*:10"
    commission: Object.fromEntries(String(env.COMMISSION || "build:5,metal:5,fasten:5,*:10").split(",").map(x => x.split(":")).filter(x => x.length === 2).map(([k, v]) => [k.trim(), Number(v) / 100])),
    adminMfa: env.ADMIN_MFA !== "0",
    backupDir: env.BACKUP_DIR || "",
    smsSellerTemplate: env.SMS_SELLER_TEMPLATE || "Imorat: yangi buyurtma {num}. Iltimos, qabul qiling.",
    channel: { chat: env.TELEGRAM_CHANNEL || "", hour: Number(env.CHANNEL_HOUR ?? 10), dropPct: Number(env.CHANNEL_DROP_PCT ?? 0.05) },
    // Mobile operators in Uzbekistan put many phones behind one IP (CGNAT), so per-IP limits are generous;
    // the real protection is per phone number (5 codes an hour) and per account.
    otpPerIpHour: Number(env.OTP_PER_IP_HOUR || 150),
    ratePerIpMin: Number(env.RATE_PER_IP_MIN || 3000),
    bonus: { rate: Number(env.BONUS_RATE ?? 0.01), ratePro: Number(env.BONUS_RATE_PRO ?? 0.02), maxShare: Number(env.BONUS_MAX_SHARE ?? 0.2), referral: Number(env.BONUS_REFERRAL ?? 30000), welcome: Number(env.BONUS_WELCOME ?? 30000) },
    smsMasterTemplate: env.SMS_MASTER_TEMPLATE ?? "Imorat: sizga ustalik uchun yangi so‘rov keldi. Saytda qabul qiling.",
    paymentsOnline: list(env.PAYMENTS) // e.g. "click,payme" once the company and contracts exist
  };
}
