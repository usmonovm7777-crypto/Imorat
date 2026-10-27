import { HttpError, bad } from "./http.js";

/* Usta AI: proxies the chat to the Anthropic Messages API with the live catalog as context.
   The API key stays on the server; the browser receives plain text chunks as they are generated. */
const RULES = `Ты — Usta AI, консультант-мастер маркетплейса стройматериалов Imorat в Ташкенте (Узбекистан). Помогаешь покупателю понять, что купить для ремонта, сравнить варианты и посчитать количество.

Язык: отвечай на том языке, на котором пишет пользователь (русский или узбекский). Узбекский пиши новой латиницей (закон 2026 г.): ö, ğ, ş, ç вместо oʻ, gʻ, sh, ch — например «Özbekiston», «şpaklyovka».

Правила:
- Рекомендуй ТОЛЬКО товары из каталога ниже. Ссылайся на товар токеном [[ID]] или [[ID:количество]], например [[1:10]]. Страница превратит токен в карточку с ценой и кнопкой «В корзину». Не выдумывай товары, цены и магазины.
- Если нужного товара нет в каталоге, честно скажи и предложи ближайшую замену или что спросить в магазине.
- Считай количество с запасом (плитка и ламинат +7–10%, краска 0,12 л/м² на слой, плиточный клей ~5 кг/м², штукатурка ~9 кг/м² на 1 см слоя). Покажи расчёт одной строкой.
- Когда сравниваешь варианты, назови лучший выбор для задачи пользователя и почему (1–2 причины).
- Пиши коротко: 2–6 предложений или короткий список через «- ». Без таблиц и заголовков. Жирным (**…**) выделяй максимум 1–2 ключевые вещи.
- Газ, электрощит, несущие стены: советуй специалиста; у товаров с пометкой «установка» можно заказать мастера в карточке товара.
- Доставка: Яндекс, тариф по общему весу из магазина: до 15 кг — курьер (40–60 мин), до 500 кг — грузовой малый кузов (Chevrolet Labo, 1–2 ч), тяжелее — большой кузов (Isuzu NQR). Из разных магазинов — отдельные доставки.
- В меню ☰ слева есть калькуляторы: подвал, ленточный фундамент, бетон и раствор, кладка, штукатурка, покраска, обои, гипсокартон, плитка, стяжка, наливной пол, ламинат, кровля, утепление, радиаторы и котёл, кондиционер. Для бетона на 1 м³ (цемент М400): М200 — 245 кг, М250 — 290 кг, М300 — 330 кг цемента; кладочный раствор 1:4 — 330 кг; стяжка 1:3 — 420 кг. Для несущих конструкций (подвал, фундамент) советуй проверить расчёт у инженера.
- Есть AI-дизайнер комнаты (кнопка «Спроектировать комнату в 3D» на главной): фото и размеры → 3D-комната с мебелью и сметой. Если человек хочет обустроить или обставить комнату — предложи его. В каталоге есть мебель: кровати, диваны, кресла, столы, стулья, детская мебель, ковры и шторы, мебель для прихожей и ванной. Дизайнер умеет ванную (плитка на стены, сантехника) и стену-акцент другого цвета.
- Есть комплекты со скидкой 5%: «Ванная под ключ», «Покраска комнаты», «Электрика квартиры», «Тёплый дом к зиме». Есть рассрочка на 12 месяцев и VIP-доставка к точному часу.
- Отвечай только на темы ремонта, строительства, товаров и заказов Imorat. На посторонние просьбы вежливо откажись.`;

let catCache = { rev: null, text: "" };
function catalogText(db, ref) {
  const rev = db.meta("catalog_rev");
  if (catCache.rev === rev) return catCache.text;
  const CAT = Object.fromEntries(ref.cats.map(c => [c.id, c]));
  const UN = ref.units;
  const rows = db.all(`SELECT p.id,p.ru,p.cat,p.sub,p.unit,p.kg,p.rating, MIN(o.price) price, GROUP_CONCAT(s.name, ', ') stores
    FROM products p JOIN offers o ON o.product_id=p.id JOIN stores s ON s.id=o.store_id AND s.status='active'
    WHERE p.active=1 GROUP BY p.id ORDER BY p.id`);
  const text = rows.map(p => {
    const sub = CAT[p.cat]?.subs.find(x => x[0] === p.sub)?.[1] || p.sub;
    const svc = ref.service[p.sub];
    return `${p.id} | ${p.ru} | ${CAT[p.cat]?.ru || p.cat} / ${sub} | от ${p.price} сум за ${(UN[p.unit] || UN.pcs)[0]} | ${p.kg} кг | ${p.stores} | ★${Number(p.rating).toFixed(1)}${svc ? ` | установка ${svc} сум/ед.` : ""}`;
  }).join("\n");
  catCache = { rev, text };
  return text;
}

const JSON_RULES = `Ты — AI-дизайнер интерьера маркетплейса Imorat (Ташкент). Тебе присылают описание комнаты, ответы клиента, списки товаров и, возможно, фото.
Отвечай СТРОГО одним JSON-объектом в формате, который указан в сообщении: без текста до и после, без markdown. Используй только id из присланных списков.
Тексты внутри JSON — на языке клиента (русский или узбекский новой латиницей: ö, ğ, ş, ç). Отвечай только на темы ремонта и интерьера.`;
export function buildRequest(db, ref, cfg, body, user) {
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const clean = msgs.map(m => ({ role: m?.role === "assistant" ? "assistant" : "user", content: String(m?.content || "").slice(0, body.mode === "json" ? 40000 : 4000) })).filter(m => m.content);
  while (clean.length && clean[0].role !== "user") clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== "user") throw bad("bad_messages", "The last message must be from the user");
  if (typeof body.image === "string" && body.image) {
    const m = body.image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad("bad_image", "Image must be a JPEG, PNG, WEBP or GIF data URL");
    const last = clean[clean.length - 1];
    last.content = [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }, { type: "text", text: last.content }];
  }
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const cart = (Array.isArray(body.cart) ? body.cart : []).slice(0, 60).map(l => {
    const p = db.get("SELECT ru FROM products WHERE id=?", Number(l?.id)); return p ? `${l.id} ${p.ru} × ${Number(l.q) || 1}` : null;
  }).filter(Boolean).join("; ") || "пусто";
  const district = D[body.district]?.ru || D[user?.district]?.ru || "не указан";
  const who = user ? `имя — ${user.name || "—"}; роль — ${user.role === "pro" ? "мастер/прораб (оптовые цены −3%)" : user.role === "seller" ? "представитель магазина" : "покупатель"}; ` : "";
  if (body.mode === "json") return { model: cfg.model, max_tokens: Math.max(cfg.maxTokens, 1500), stream: true, system: [{ type: "text", text: JSON_RULES }], messages: clean.map(m => typeof m.content === "string" ? { ...m, content: m.content.slice(0, 40000) } : m) };
  return {
    model: cfg.model, max_tokens: cfg.maxTokens, stream: true,
    system: [
      { type: "text", text: RULES + "\n\nКаталог (ID | название | категория | цена | вес | магазины | рейтинг):\n" + catalogText(db, ref), cache_control: { type: "ephemeral" } },
      { type: "text", text: `Контекст покупателя: ${who}район доставки — ${district}; VIP — ${user?.vip ? "да" : "нет"}; в корзине: ${cart}. Интерфейс: ${body.lang === "uz" ? "узбекский" : "русский"}.` }
    ],
    messages: clean
  };
}

/* Streams the model's text to `res`. Returns when the answer is complete. */
export async function streamChat(cfg, payload, res, log = console) {
  if (!cfg.key) throw new HttpError(503, "ai_not_configured", "Usta AI is not configured on the server");
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  const r = await fetch(cfg.url + "/v1/messages", {
    method: "POST", signal: ctl.signal,
    headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    log.error("[ai] upstream", r.status, t.slice(0, 300));
    throw new HttpError(r.status === 429 || r.status === 529 ? 503 : 502, r.status === 429 || r.status === 529 ? "ai_busy" : "ai_failed", "Usta AI could not answer right now");
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const dec = new TextDecoder(); let buf = "", stop = null;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") res.write(ev.delta.text);
      else if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === "error") { log.error("[ai] stream error", ev.error?.type); res.write("\n\n⚠️"); }
    }
  }
  if (stop === "max_tokens") res.write(" …");
  res.end();
}
