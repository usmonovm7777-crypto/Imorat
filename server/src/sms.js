import { HttpError } from "./http.js";

/* SMS through Eskiz (notify.eskiz.uz). In "dev" mode nothing is sent: the API returns the code instead. */
export function createSms(cfg, log = console) {
  let token = "", tokenAt = 0;
  async function login() {
    const fd = new FormData(); fd.set("email", cfg.eskizEmail); fd.set("password", cfg.eskizPassword);
    const r = await fetch(cfg.eskizUrl + "/auth/login", { method: "POST", body: fd, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.data?.token) { log.error("[sms] eskiz login failed", r.status, j?.message); throw new HttpError(502, "sms_failed", "SMS service is unavailable"); }
    token = j.data.token; tokenAt = Date.now();
  }
  async function sendOnce(phone, text) {
    const fd = new FormData(); fd.set("mobile_phone", phone); fd.set("message", text); fd.set("from", cfg.eskizFrom);
    return fetch(cfg.eskizUrl + "/message/sms/send", { method: "POST", body: fd, headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(10000) });
  }
  return {
    mode: cfg.mode,
    async sendText(phone, text) {
      if (cfg.mode !== "eskiz") { log.info(`[sms:dev] ${phone} → ${text}`); return { dev: true }; }
      if (!token || Date.now() - tokenAt > 25 * 86400_000) await login();
      let r = await sendOnce(phone, text);
      if (r.status === 401) { await login(); r = await sendOnce(phone, text); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { log.error("[sms] eskiz send failed", r.status, JSON.stringify(j).slice(0, 300)); throw new HttpError(502, "sms_failed", "Could not send SMS, try again later"); }
      return { id: j.id || null };
    },
    sendCode(phone, code) { return this.sendText(phone, cfg.template.replace("{code}", code)); }
  };
}
