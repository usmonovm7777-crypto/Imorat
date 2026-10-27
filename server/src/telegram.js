/* Telegram bot (long polling, no webhook needed): links accounts via t.me/<bot>?start=<token>,
   sends new orders to sellers with buttons and order statuses to buyers. */
export function createTelegram(cfg, log = console) {
  const enabled = !!cfg.token;
  const base = `${cfg.url}/bot${cfg.token}`;
  let username = cfg.name || "", offset = 0, stopped = false, handlers = { start: null, callback: null };
  async function call(method, body, timeoutMs = 10000) {
    if (!enabled) return null;
    try {
      const r = await fetch(`${base}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { log.warn(`[tg] ${method}: ${j.description || r.status}`); return null; }
      return j.result;
    } catch (e) { if (!stopped) log.warn(`[tg] ${method} failed: ${e.message}`); return null; }
  }
  async function poll() {
    while (!stopped) {
      const ups = await call("getUpdates", { offset, timeout: cfg.pollTimeout ?? 25, allowed_updates: ["message", "callback_query"] }, ((cfg.pollTimeout ?? 25) + 10) * 1000);
      if (!ups) { await new Promise(r => setTimeout(r, cfg.pollTimeout === 0 ? 200 : 3000)); continue; }
      for (const u of ups) {
        offset = u.update_id + 1;
        try {
          if (u.message?.text?.startsWith("/start")) await handlers.start?.(u.message.chat.id, u.message.text.split(" ")[1] || "", u.message.from);
          else if (u.callback_query) await handlers.callback?.(u.callback_query);
        } catch (e) { log.error("[tg] handler", e); }
      }
      if (cfg.pollTimeout === 0 && !ups.length) await new Promise(r => setTimeout(r, 100));
    }
  }
  return {
    enabled,
    get username() { return username; },
    on(name, fn) { handlers[name] = fn; },
    async start() {
      if (!enabled) return;
      const me = await call("getMe");
      if (me?.username) username = me.username;
      poll();
    },
    stop() { stopped = true; },
    send: (chat_id, text, buttons) => call("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }),
    sendPhoto: (chat_id, photo, caption, buttons) => call("sendPhoto", { chat_id, photo, caption, parse_mode: "HTML", ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }, 20000),
    edit: (chat_id, message_id, text, buttons) => call("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons || [] } }),
    answer: (id, text) => call("answerCallbackQuery", { callback_query_id: id, text: text || "", show_alert: false })
  };
}
export const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
