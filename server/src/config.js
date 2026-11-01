import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { loadNativePushConfig } from "./push_native.js";

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
  // "eskiz" sends real SMS; "telegram" = no SMS contract yet, people sign in only through the Telegram bot (it asks for the
  // contact, which confirms the number) — safe for production; "dev" returns the code in the API response (testing only)
  const smsMode = env.SMS_MODE || (env.ESKIZ_EMAIL ? "eskiz" : "dev");
  if (!["eskiz", "telegram", "dev"].includes(smsMode)) throw new Error("SMS_MODE must be eskiz, telegram or dev");
  if (smsMode === "telegram" && !env.TELEGRAM_BOT_TOKEN) throw new Error("SMS_MODE=telegram needs TELEGRAM_BOT_TOKEN: sign-in goes through the bot");
  // In production a forgotten ESKIZ_* would hand out sign-in codes in API responses; refuse to start unless this is a declared test server
  if (prod && smsMode === "dev" && env.ALLOW_DEV_SMS !== "1") throw new Error("SMS is in dev mode: set ESKIZ_EMAIL/ESKIZ_PASSWORD, or ALLOW_DEV_SMS=1 on a test server only");
  if (prod && env.COURIER_SIMULATION === "1") throw new Error("COURIER_SIMULATION is for test servers only: a production server shows real courier coordinates or none");
  return {
    prod,
    port: Number(env.PORT) || 8787,
    host: env.HOST || "0.0.0.0",
    dbPath: env.DB_PATH || "data/imorat.db",
    catalogPath: env.CATALOG_PATH || new URL("../data/catalog.json", import.meta.url).pathname,
    // DEMO_STORES=0 on the real site: the 9 sample stores and their prices are not seeded (and are removed if they were); only real stores sell
    demoStores: env.DEMO_STORES !== "0",
    // orders are paid by card on the site; ALLOW_PAY_AT_STORE=1 re-enables "pay the store on pickup" (tests, special launches)
    allowPayAtStore: env.ALLOW_PAY_AT_STORE === "1",
    uploadsDir: env.UPLOADS_DIR || "uploads",
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    /* The mobile app's WebView runs at https://localhost (Android, androidScheme https) and capacitor://localhost (iOS):
       those origins are always allowed, otherwise the installed app could not call the API at all. */
    origins: [...new Set([...list(env.ALLOWED_ORIGINS || "https://usmonovm7777-crypto.github.io,http://localhost:8080,http://127.0.0.1:8080"), "https://localhost", "capacitor://localhost", "http://localhost"])],
    jwtSecret: env.JWT_SECRET || randomBytes(32).toString("hex"),
    admins: list(env.ADMIN_PHONES).map(normPhone),
    vipFree: env.VIP_FREE !== "0",
    sms: {
      mode: smsMode, // "eskiz" sends real SMS, "dev" returns the code in the API response (testing only)
      eskizUrl: (env.ESKIZ_URL || "https://notify.eskiz.uz/api").replace(/\/$/, ""),
      eskizEmail: env.ESKIZ_EMAIL || "",
      eskizPassword: env.ESKIZ_PASSWORD || "",
      eskizFrom: env.ESKIZ_FROM || "4546",
      template: env.SMS_TEMPLATE || "Imorat Go: tasdiqlash kodi {code}. Kodni hech kimga bermang."
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
    /* COURIER_SIMULATION=1 (test servers only): without a Yandex token the buyer's map shows a pretend courier moving along the route.
       Off by default — a working server shows only real coordinates and says "courier location unavailable" when there are none. */
    courierSim: env.COURIER_SIMULATION === "1",
    /* maps on the site: the Yandex "JavaScript API и HTTP Геокодер" key draws the real Yandex map and finds addresses;
       without it the site shows OpenStreetMap tiles and asks Nominatim for addresses */
    maps: { jsKey: env.YANDEX_MAPS_KEY || "", geocoderKey: env.YANDEX_GEOCODER_KEY || env.YANDEX_MAPS_KEY || "", geocoderUrl: (env.YANDEX_GEOCODER_URL || "https://geocode-maps.yandex.ru/1.x/").replace(/\/$/, "") + "/", nominatim: (env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "") },
    telegram: { token: env.TELEGRAM_BOT_TOKEN || "", name: env.TELEGRAM_BOT_NAME || "imoratGo_bot", url: (env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, ""), pollTimeout: env.TELEGRAM_POLL_TIMEOUT != null ? Number(env.TELEGRAM_POLL_TIMEOUT) : 25 },
    pushSubject: env.VAPID_SUBJECT || "mailto:support@imorat.uz",
    siteUrl: (env.SITE_URL || "https://usmonovm7777-crypto.github.io/Imorat/").replace(/\/?$/, "/"),
    // Seller deadlines (minutes): reminder, SMS, auto-cancel if not accepted; hours to hand the order over
    timers: { remind: Number(env.ACCEPT_REMIND_MIN) || 5, sms: Number(env.ACCEPT_SMS_MIN) || 10, cancel: Number(env.ACCEPT_TIMEOUT_MIN) || 20, handover: Number(env.HANDOVER_HOURS) || 4 },
    /* What a store pays on a card-paid order, from the goods money:
       - Imorat Go's own commission by category, %: "*:1" (a category may differ: "build:1,*:2")
       - the Payme/Click acquiring fee that the bank charges on the payment, passed on as it is: 2%
       - a new store's first PROMO_MONTHS after approval: Imorat Go's part is 0%, the acquiring fee stays */
    commission: Object.fromEntries(String(env.COMMISSION || "*:1").split(",").map(x => x.split(":")).filter(x => x.length === 2).map(([k, v]) => [k.trim(), Math.round(Math.max(0, Number(v) || 0) * 1e4) / 1e6])),
    // "2" = the same for every provider; "payme:2,click:1.8" = each provider's contract rate (the one without a name is the default)
    ...(() => { const by = {}; let def = null; for (const x of String(env.ACQUIRING_PERCENT ?? "2").split(",").map(v => v.trim()).filter(Boolean)) { const [k, v] = x.includes(":") ? x.split(":") : ["*", x]; const n = Math.round(Math.max(0, Number(v) || 0) * 1e4) / 1e6; if (k.trim() === "*") def = n; else by[k.trim()] = n; }
      const acquiring = def ?? (Object.keys(by).length ? Math.max(...Object.values(by)) : 0.02); return { acquiring, acquiringBy: by, acquiringOf: p => by[p] ?? acquiring }; })(),
    promoMonths: Math.max(0, Math.round(Number(env.PROMO_MONTHS ?? 3) || 0)),
    adminMfa: env.ADMIN_MFA !== "0",
    backupDir: env.BACKUP_DIR || "",
    supportPhone: String(env.SUPPORT_PHONE || "").replace(/[^\d+]/g, ""), // emergency contact handed to the Yandex courier (defaults to the buyer's phone)
    nativePush: loadNativePushConfig(env), // FCM / APNs keys for the Android and iPhone app (see push_native.js)
    // sign-in for app-store reviewers: "998900000000:123456" — the code is fixed, no SMS is sent; several pairs separated by commas
    reviewAccounts: Object.fromEntries(String(env.REVIEW_ACCOUNTS || "").split(",").map(x => x.trim().split(":")).filter(x => x.length === 2 && /^998\d{9}$/.test(x[0]) && /^\d{4,8}$/.test(x[1]))),
    smsSellerTemplate: env.SMS_SELLER_TEMPLATE || "Imorat Go: yangi buyurtma {num}. Iltimos, qabul qiling.",
    channel: { chat: env.TELEGRAM_CHANNEL ?? "@imoratgo", hour: Number(env.CHANNEL_HOUR ?? 10), dropPct: Number(env.CHANNEL_DROP_PCT ?? 0.05) },
    // Mobile operators in Uzbekistan put many phones behind one IP (CGNAT), so per-IP limits are generous;
    // the real protection is per phone number (5 codes an hour) and per account.
    otpPerIpHour: Number(env.OTP_PER_IP_HOUR || 150),
    ratePerIpMin: Number(env.RATE_PER_IP_MIN || 3000),
    /* the points programme is switched off until the owner turns it on (BONUS_ON=1): no cashback, no spending, no referral rewards */
    bonus: { enabled: env.BONUS_ON === "1", rate: Number(env.BONUS_RATE ?? 0.01), ratePro: Number(env.BONUS_RATE_PRO ?? 0.02), rateVip: Number(env.BONUS_RATE_VIP ?? 0.03), maxShare: Number(env.BONUS_MAX_SHARE ?? 0.2), referral: Number(env.BONUS_REFERRAL ?? 30000), welcome: Number(env.BONUS_WELCOME ?? 30000), maxCashback: Number(env.BONUS_MAX_CASHBACK ?? 200000), maxInvites: Number(env.BONUS_MAX_INVITES ?? 20), monthlyBudget: Math.max(0, Number(env.BONUS_MONTHLY_BUDGET ?? 0) || 0) },
    smsMasterTemplate: env.SMS_MASTER_TEMPLATE ?? "Imorat Go: sizga ustalik uchun yangi so‘rov keldi. Saytda qabul qiling.",
    // Online card payment: a provider is offered once its keys are set; PAYMENTS (e.g. "payme") can narrow the list
    payme: { id: env.PAYME_MERCHANT_ID || "", key: env.PAYME_KEY || "", testKey: env.PAYME_TEST_KEY || "", url: (env.PAYME_CHECKOUT_URL || "https://checkout.paycom.uz").replace(/\/$/, "") },
    click: { serviceId: env.CLICK_SERVICE_ID || "", merchantId: env.CLICK_MERCHANT_ID || "", secret: env.CLICK_SECRET_KEY || "", userId: env.CLICK_MERCHANT_USER_ID || "" },
    payTimeoutMin: Number(env.PAY_TIMEOUT_MIN || 30),
    /* "stage 0": no payment provider yet and pay-at-store allowed — buyers pay the store on receipt, the platform holds no money */
    get payOnReceipt() { return this.allowPayAtStore && !this.paymentsOnline.length; },
    /* who delivers: Yandex when its token is set; in stage 0 (pay on receipt) the store itself with its own courier, price
       agreed with the buyer; with card payments but no Yandex yet — Imorat Go arranges the courier by hand at the tariff price */
    get deliveryBy() { return this.yandex.token ? "yandex" : this.payOnReceipt ? "store" : "platform"; },
    get paymentsOnline() { const have = [...(this.payme.id && this.payme.key ? ["payme"] : []), ...(this.click.serviceId && this.click.secret ? ["click"] : [])]; const want = list(env.PAYMENTS); return want.length ? have.filter(p => want.includes(p)) : have; }
  };
}
