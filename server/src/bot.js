import { escHtml as h } from "./telegram.js";
import { createSearch } from "./search.js";
import { newUserId } from "./auth.js";

/* The Imorat Go Telegram bot for people and masters.
   Everyone: product search in plain words (typos, Uzbek, synonyms), masters by trade with a request
   in three taps, orders and bonuses, sign-in by sharing the phone number, RU / UZ.
   Masters: requests arrive with Accept / Decline / Done buttons, list of open requests, pause button.
   Buyers rate the master with stars right after the job. Sellers keep their order buttons (app.js). */
const SPEC = { tile: ["🧱", "Плиточник", "Kafelçi"], elec: ["⚡", "Электрик", "Elektrik"], plumb: ["🚿", "Сантехник", "Santexnik"], paint: ["🎨", "Маляр-штукатур", "Böyoqçi-suvoqçi"], floor: ["🪵", "Полы и ламинат", "Pol va laminat"],
  drywall: ["📐", "Гипсокартон", "Gipsokarton"], weld: ["🔥", "Сварщик", "Payvandçi"], roof: ["🏠", "Кровельщик", "Tom yopuvçi"], furn: ["🪑", "Сборка мебели и кухонь", "Mebel va oşxona yiğiş"], ac: ["❄️", "Кондиционеры", "Konditsionerlar"], door: ["🚪", "Двери и окна", "Eşik va derazalar"] };
const UNIT = { job: ["за работу", "iş uçun"], m2: ["за м²", "m² uçun"], hour: ["в час", "soatiga"], day: ["в день", "kuniga"], pt: ["за точку", "nuqta uçun"] };
const WHEN = { today: ["Сегодня", "Bugun"], tomorrow: ["Завтра", "Ertaga"], week: ["На этой неделе", "Şu hafta"], talk: ["Договоримся по телефону", "Telefonda kelişamiz"] };
const SHIP = { new: ["🆕 ждёт подтверждения магазина", "🆕 dökon tasdiqlaşini kutmoqda"], assembling: ["🛠 магазин собирает", "🛠 dökon yiğmoqda"], searching: ["🚚 ищем курьера", "🚚 kuryer qidirilmoqda"], to_store: ["🚚 курьер едет в магазин", "🚚 kuryer dökonga ketmoqda"],
  on_way: ["🚚 в пути к вам", "🚚 sizga kelmoqda"], delivered: ["✅ доставлен", "✅ yetkazildi"], ready: ["📦 готов к выдаче", "📦 olib ketişga tayyor"], picked: ["✅ выдан", "✅ topşirildi"], cancelled: ["❌ отменён", "❌ bekor qilindi"] };
const uzNew = t => String(t || "").replace(/O[‘ʻ'`]/g, "Ö").replace(/o[‘ʻ'`]/g, "ö").replace(/G[‘ʻ'`]/g, "Ğ").replace(/g[‘ʻ'`]/g, "ğ").replace(/SH/g, "Ş").replace(/Sh/g, "Ş").replace(/sh/g, "ş").replace(/CH/g, "Ç").replace(/Ch/g, "Ç").replace(/ch/g, "ç");
const money = (n, uz) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ") + (uz ? " söm" : " сум");
const digits = v => String(v || "").replace(/\D/g, "");
/* every button label in both languages, so the menu works after switching language */
const BTN = {
  search: ["🔎 Найти товар", "🔎 Mahsulot qidiriş"], masters: ["🧰 Мастера", "🧰 Ustalar"], orders: ["📦 Мои заказы", "📦 Buyurtmalarim"], bonus: ["🎁 Бонусы", "🎁 Bonuslar"],
  requests: ["📋 Мои заявки", "📋 Arizalarim"], pause: ["⏸ Пауза для заявок", "⏸ Arizalarni töxtatiş"], resume: ["▶️ Снова принимать заявки", "▶️ Arizalarni qayta qabul qiliş"],
  login: ["📱 Войти по номеру телефона", "📱 Telefon raqam bilan kiriş"], lang: ["🌐 Özbekça", "🌐 Русский"], help: ["ℹ️ Помощь", "ℹ️ Yordam"], site: ["🌐 Сайт", "🌐 Sayt"]
};

export function registerBot({ db, cfg, ref, tg, bonus, masters, log = console }) {
  const site = cfg.siteUrl.replace(/#.*$/, "");
  const channel = (cfg.channel?.chat || "").replace(/^@/, "");
  const search = createSearch(ref.cats || []);
  const safe = p => Promise.resolve(p).catch(e => log.warn("[bot]", e.message));
  const hits = new Map(); // simple flood guard: 40 messages a minute per chat
  const flood = chat => { const now = Date.now(), a = (hits.get(chat) || []).filter(t => now - t < 60000); a.push(now); hits.set(chat, a);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
    return a.length > 40; };

  /* ---------- chat state ---------- */
  function chatOf(id, from) {
    const chat = String(id);
    let c = db.get("SELECT * FROM tg_chats WHERE chat=?", chat);
    if (!c) {
      const u0 = db.get("SELECT lang FROM users WHERE tg_chat=?", chat);
      const lang = u0?.lang === "uz" || (!u0 && /^uz/.test(from?.language_code || "")) ? "uz" : "ru";
      db.run("INSERT OR IGNORE INTO tg_chats(chat,lang,updated_at) VALUES(?,?,?)", chat, lang, Date.now());
      c = db.get("SELECT * FROM tg_chats WHERE chat=?", chat);
    }
    if (c.state && Date.now() - (c.updated_at || 0) > 2 * 3600000) { db.run("UPDATE tg_chats SET state=NULL, data=NULL WHERE chat=?", chat); c = { ...c, state: null, data: null }; }
    const user = db.get("SELECT * FROM users WHERE tg_chat=?", chat);
    const uz = c.lang === "uz", L = (ru, uzT) => (uz ? uzNew(uzT) : ru);
    return { id: chat, c, user, uz, L, b: k => BTN[k][uz ? 1 : 0], data: c.data ? JSON.parse(c.data) : {} };
  }
  const setState = (ch, state, data = {}) => db.run("UPDATE tg_chats SET state=?, data=?, updated_at=? WHERE chat=?", state, JSON.stringify(data), Date.now(), ch.id);
  const masterOf = u => u && db.get("SELECT * FROM masters WHERE user_id=?", u.id);

  function keyboard(ch) {
    const m = masterOf(ch.user), rows = [[ch.b("search"), ch.b("masters")], [ch.b("orders"), ch.b("bonus")]];
    if (m && m.status === "active") rows.push([ch.b("requests"), m.busy ? ch.b("resume") : ch.b("pause")]);
    if (!ch.user) rows.push([{ text: ch.b("login"), request_contact: true }]);
    rows.push([ch.b("lang"), ch.b("help")]);
    return rows.map(r => r.map(x => (typeof x === "string" ? { text: x } : x)));
  }
  const menu = (ch, text, inline) => tg.sendKb(ch.id, text, keyboard(ch), inline);
  const siteBtn = ch => ({ text: ch.b("site"), url: site + (ch.uz ? "?lang=uz" : "") });

  /* ---------- texts ---------- */
  function welcome(ch, from) {
    const name = h(from?.first_name || ch.user?.name?.split(" ")[0] || "");
    return ch.L(`Ассалому алейкум${name ? ", " + name : ""}! 👋\n\nЯ бот <b>Imorat Go</b> — стройматериалы из магазинов Ташкента и мастера для ремонта.\n\n🔎 <b>Напишите, что ищете</b> — «цемент м400», «кран для ванны», «ламинат дуб» — я найду и покажу цены.\n🧰 <b>Мастера</b> — плиточники, электрики, сантехники: выберите и отправьте заявку.\n📦 Статусы заказов и ответы мастеров приходят сюда.${ch.user ? "" : "\n\n📱 Чтобы оформлять заявки и видеть заказы, нажмите «Войти по номеру телефона» внизу."}`,
      `Assalomu alaykum${name ? ", " + name : ""}! 👋\n\nMen <b>Imorat Go</b> botiman — Toşkent dökonlaridan quriliş mollari va ta’mir ustalari.\n\n🔎 <b>Nima kerakligini yozing</b> — «sement m400», «laminat», «aralaştirgiç» — topib, narxlarini körsataman.\n🧰 <b>Ustalar</b> — kafelçi, elektrik, santexnik: tanlang va ariza yuboring.\n📦 Buyurtma holati va ustalar javobi şu yerga keladi.${ch.user ? "" : "\n\n📱 Ariza beriş va buyurtmalarni köriş uçun pastdagi «Telefon raqam bilan kiriş» tugmasini bosing."}`);
  }
  const helpText = ch => ch.L(`<b>Что умеет бот</b>\n\n🔎 Просто напишите название товара — можно с ошибками, по-русски или по-узбекски.\n🧰 /masters — мастера по специальностям и заявка в три шага.\n📦 /orders — ваши заказы и где они сейчас.\n🎁 /bonus — бонусы и код для друзей.${masterOf(ch.user) ? "\n📋 /requests — ваши заявки как мастера, кнопки «Принять» и «Выполнено»." : ""}\n🌐 /lang — Özbekça / Русский.\n\nМагазинам: заказы с кнопками приходят сюда после «Подключить Telegram» в кабинете продавца.${channel ? `\n\n📣 Скидки и товар дня — в канале @${channel}` : ""}`,
    `<b>Bot nimalar qila oladi</b>\n\n🔎 Mahsulot nomini yozing — xato bilan ham, özbekça yoki rusça.\n🧰 /masters — ustalar va uç qadamda ariza.\n📦 /orders — buyurtmalaringiz va ular qayerda.\n🎁 /bonus — bonuslar va döstlar uçun kod.${masterOf(ch.user) ? "\n📋 /requests — usta sifatida arizalaringiz, «Qabul qiliş» va «Bajarildi» tugmalari." : ""}\n🌐 /lang — Русский / Özbekça.\n\nDökonlarga: sotuvçi kabinetida «Telegramni ulaş» dan keyin buyurtmalar şu yerga keladi.${channel ? `\n\n📣 Çegirmalar va kun mahsuloti — @${channel} kanalida` : ""}`);
  const needLogin = ch => menu(ch, ch.L("Сначала войдите — нажмите «📱 Войти по номеру телефона» внизу. Это безопасно: Telegram сам подтверждает, что номер ваш.", "Avval kiring — pastdagi «📱 Telefon raqam bilan kiriş» tugmasini bosing. Bu xavfsiz: raqam sizniki ekanini Telegram özi tasdiqlaydi."));

  /* ---------- product search ---------- */
  let prodCache = { t: 0, list: [] };
  function products() {
    if (Date.now() - prodCache.t < 60000) return prodCache.list;
    const offers = db.all("SELECT o.product_id id, MIN(o.price) min, COUNT(*) n FROM offers o JOIN stores s ON s.id=o.store_id WHERE s.status='active' GROUP BY o.product_id");
    const by = new Map(offers.map(o => [o.id, o]));
    const list = db.all("SELECT id, ru, uz, cat, sub, hit, rating, reviews FROM products WHERE active=1").filter(p => by.has(p.id)).map(p => ({ ...p, min: by.get(p.id).min, n: by.get(p.id).n }));
    prodCache = { t: Date.now(), list }; return list;
  }
  async function doSearch(ch, q) {
    q = q.trim().slice(0, 120);
    if (q.length < 2) return menu(ch, ch.L("Напишите название товара, например: <i>цемент м400</i>", "Mahsulot nomini yozing, masalan: <i>sement m400</i>"));
    safe(tg.typing(ch.id));
    const r = search(q, products(), 6), aiUrl = `${site}?${ch.uz ? "lang=uz&" : ""}ai=${encodeURIComponent(q)}`;
    if (!r.list.length) return tg.send(ch.id, ch.L(`По запросу «${h(q)}» ничего не нашли 🤔\nПопробуйте другое слово или опишите задачу Usta AI — он подберёт материалы и посчитает количество.`, `«${h(q)}» böyiça heç narsa topilmadi 🤔\nBoşqa söz bilan yozing yoki vazifani Usta AI ga tuşuntiring — u materiallarni tanlab, miqdorini hisoblaydi.`),
      [[{ text: ch.L("🤖 Спросить Usta AI", "🤖 Usta AI dan söraş"), url: aiUrl }], ...[ch.L("цемент", "sement"), ch.L("ламинат", "laminat"), ch.L("смеситель", "aralaştirgiç")].map(x => [{ text: "🔎 " + x, callback_data: "s:" + x.slice(0, 28) }])]);
    const name = p => (ch.uz ? uzNew(p.uz) : p.ru);
    const head = r.fix ? ch.L(`Исправили опечатку: <b>${h(r.fix)}</b>\n`, `Xato tuzatildi: <b>${h(r.fix)}</b>\n`) : r.loose ? ch.L("Точных совпадений нет — вот похожее:\n", "Aniq mos kelmadi — öxşaşlari:\n") : "";
    const lines = r.list.map(({ p }, i) => `${i + 1}. <b>${h(name(p))}</b>\n    ${ch.L("от", "")} ${money(p.min, ch.uz)}${ch.uz ? "dan" : ""} · ${p.n} ${ch.L(p.n === 1 ? "магазин" : p.n < 5 ? "магазина" : "магазинов", "dökon")}`).join("\n");
    const btns = r.list.map(({ p }, i) => [{ text: `${i + 1}. ${name(p).slice(0, 34)} — ${money(p.min, ch.uz)}`, url: `${site}${ch.uz ? "?lang=uz" : ""}#p-${p.id}` }]);
    btns.push([{ text: ch.L(`🌐 Все результаты (${r.total})`, `🌐 Barça natijalar (${r.total})`), url: `${site}?${ch.uz ? "lang=uz&" : ""}q=${encodeURIComponent(q)}` }]);
    btns.push([{ text: ch.L("🤖 Спросить Usta AI: сколько нужно?", "🤖 Usta AI: qança kerak?"), url: aiUrl }]);
    return tg.send(ch.id, `${head}🔎 ${ch.L("Нашли", "Topildi")}: <b>${r.total}</b>\n\n${lines}\n\n${ch.L("Нажмите на товар — откроется карточка с ценами всех магазинов и доставкой.", "Mahsulotni bosing — barça dökonlar narxi va yetkaziş bilan kartoçka oçiladi.")}`, btns);
  }

  /* ---------- masters for people ---------- */
  const specMenu = ch => tg.send(ch.id, ch.L("🧰 <b>Какой мастер нужен?</b>\nВсе мастера проверены модератором, у каждого — отзывы клиентов Imorat Go.", "🧰 <b>Qanday usta kerak?</b>\nBarça ustalar moderator tomonidan tekşirilgan, har birida Imorat Go mijozlari şarhlari bor."),
    [...chunk(Object.entries(SPEC).map(([k, v]) => ({ text: `${v[0]} ${ch.uz ? v[2] : v[1]}`, callback_data: "ms:" + k })), 2), [{ text: ch.L("🧑‍🔧 Я мастер — разместить анкету", "🧑‍🔧 Men ustaman — anketa joylaş"), url: `${site}${ch.uz ? "?lang=uz" : ""}#masters` }]]);
  function mastersBySpec(ch, spec) {
    const st = masters.stats(), D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
    const list = db.all("SELECT * FROM masters WHERE status='active' AND busy=0").map(m => masters.pub(m, st[m.id])).filter(m => m.specs.includes(spec))
      .sort((a, b) => (b.stars || 0) - (a.stars || 0) || b.done - a.done).slice(0, 6);
    const sp = SPEC[spec];
    if (!list.length) return tg.send(ch.id, ch.L(`Пока нет свободных мастеров «${sp[1]}». Загляните позже или посмотрите на сайте.`, `Hozirça boş «${sp[2]}» ustalari yöq. Keyinroq qarang yoki saytda köring.`), [[{ text: ch.L("🧰 Все мастера на сайте", "🧰 Saytdagi barça ustalar"), url: `${site}${ch.uz ? "?lang=uz" : ""}#masters` }], [{ text: ch.L("← Другие специальности", "← Boşqa kasblar"), callback_data: "mm" }]]);
    const txt = list.map(m => `👷 <b>${h(m.name)}</b>${m.stars ? ` ⭐ ${String(m.stars).replace(".", ",")} (${m.reviews})` : ""}${m.done ? ` · ${m.done} ${ch.L("работ", "iş")}` : ""}\n📍 ${m.districts.slice(0, 3).map(d => h(ch.uz ? uzNew(D[d]?.uz || d) : D[d]?.ru || d)).join(", ")}${m.districts.length > 3 ? " +" + (m.districts.length - 3) : ""}${m.exp ? ` · ${m.exp} ${ch.L("лет опыта", "yil tajriba")}` : ""}\n💰 ${m.price ? `${ch.L("от", "")} ${money(m.price, ch.uz)}${ch.uz ? "dan" : ""} ${UNIT[m.price_unit]?.[ch.uz ? 1 : 0] || ""}` : ch.L("цена по договорённости", "narx kelişiladi")}${m.about ? `\n<i>${h(m.about.slice(0, 110))}${m.about.length > 110 ? "…" : ""}</i>` : ""}`).join("\n\n");
    return tg.send(ch.id, `${sp[0]} <b>${ch.uz ? sp[2] : sp[1]}</b>\n\n${txt}`, [...list.map(m => [{ text: ch.L(`📩 Позвать: ${m.name}`, `📩 Çaqiriş: ${m.name}`).slice(0, 60), callback_data: "mq:" + m.id }]), [{ text: ch.L("← Другие специальности", "← Boşqa kasblar"), callback_data: "mm" }]]);
  }
  function startRequest(ch, mid) {
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", mid);
    if (!m) return tg.send(ch.id, ch.L("Мастер сейчас недоступен — выберите другого: /masters", "Usta hozir mavjud emas — boşqasini tanlang: /masters"));
    if (!ch.user) { setState(ch, "pend_mq", { mid }); return needLogin(ch); }
    if (m.user_id === ch.user.id) return tg.send(ch.id, ch.L("Это ваша анкета 🙂", "Bu sizning anketangiz 🙂"));
    setState(ch, "mreq_text", { mid });
    return tg.send(ch.id, ch.L(`📩 Заявка мастеру <b>${h(m.name)}</b>\n\n<b>Опишите работу</b> одним сообщением: что сделать, сколько м² или точек, есть ли материалы.\n<i>Например: положить плитку в ванной 6 м², плитка уже куплена.</i>`, `📩 Usta <b>${h(m.name)}</b> ga ariza\n\n<b>Işni bitta xabarda yozing</b>: nima qiliş kerak, neça m² yoki nuqta, materiallar bormi.\n<i>Masalan: vannaxonaga 6 m² kafel yotqiziş, kafel olingan.</i>`), [[{ text: ch.L("✖️ Отмена", "✖️ Bekor qiliş"), callback_data: "x" }]]);
  }
  function finishRequest(ch, d) {
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", d.mid), u = ch.user;
    setState(ch, null);
    if (!m || !u) return tg.send(ch.id, ch.L("Мастер сейчас недоступен — выберите другого: /masters", "Usta hozir mavjud emas — boşqasini tanlang: /masters"));
    const day = db.get("SELECT COUNT(*) n FROM master_requests WHERE user_id=? AND created_at>?", u.id, Date.now() - 86400000).n;
    if (day >= 10) return tg.send(ch.id, ch.L("Сегодня отправлено уже 10 заявок. Попробуйте завтра.", "Bugun allaqaçon 10 ta ariza yuborildi. Ertaga urinib köring."));
    if (!u.phone) return needLogin(ch);
    const id = masters.createRequest(u, m, { text: d.text, when: WHEN[d.when]?.[0] || "как можно скорее", district: d.district || null, street: "" });
    return menu(ch, ch.L(`✅ Заявка №${id} отправлена мастеру <b>${h(m.name)}</b>.\nКогда мастер примет — пришлём сюда его номер телефона.`, `✅ №${id} ariza usta <b>${h(m.name)}</b> ga yuborildi.\nUsta qabul qilganda telefon raqamini şu yerga yuboramiz.`));
  }

  /* ---------- masters: their requests ---------- */
  function myRequests(ch) {
    const m = masterOf(ch.user);
    if (!m) return tg.send(ch.id, ch.L("У вас ещё нет анкеты мастера. Разместите её на сайте — после проверки клиенты начнут присылать заявки.", "Sizda hali usta anketasi yöq. Saytda joylaştiring — tekşiruvdan keyin mijozlar ariza yubora boşlaydi."), [[{ text: ch.L("🧑‍🔧 Разместить анкету", "🧑‍🔧 Anketa joylaş"), url: `${site}#masters` }]]);
    if (m.status !== "active") return tg.send(ch.id, ch.L("Анкета на проверке у модератора — как только одобрим, сообщим сюда.", "Anketa moderator tekşiruvida — tasdiqlanişi bilan şu yerga xabar beramiz."));
    const list = db.all("SELECT * FROM master_requests WHERE master_id=? AND status IN ('new','accepted') ORDER BY id DESC LIMIT 6", m.id);
    if (!list.length) return menu(ch, ch.L(`Открытых заявок нет.${m.busy ? "\n⏸ Сейчас вы на паузе — новые клиенты вас не видят." : ""}`, `Oçiq arizalar yöq.${m.busy ? "\n⏸ Hozir pauzadasiz — yangi mijozlar sizni körmaydi." : ""}`));
    return list.reduce((p, q) => p.then(() => { const c = masters.masterCard(q); return tg.send(ch.id, c.text, c.buttons); }), Promise.resolve());
  }
  function togglePause(ch, busy) {
    const m = masterOf(ch.user); if (!m) return myRequests(ch);
    db.run("UPDATE masters SET busy=? WHERE id=?", busy ? 1 : 0, m.id);
    return menu(chatOf(ch.id), busy ? ch.L("⏸ Пауза включена: новые клиенты не видят вашу анкету. Открытые заявки остаются — их можно выполнить.", "⏸ Pauza yoqildi: yangi mijozlar anketangizni körmaydi. Oçiq arizalar qoladi.") : ch.L("▶️ Вы снова принимаете заявки — анкета видна клиентам.", "▶️ Yana ariza qabul qilyapsiz — anketa mijozlarga körinadi."));
  }

  /* ---------- orders and bonuses ---------- */
  function myOrders(ch) {
    if (!ch.user) return needLogin(ch);
    const os = db.all("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5", ch.user.id);
    if (!os.length) return tg.send(ch.id, ch.L("Заказов пока нет. Напишите, что нужно купить — я найду 🔎", "Hozirça buyurtmalar yöq. Nima oliş kerakligini yozing — topaman 🔎"), [[siteBtn(ch)]]);
    const names = Object.fromEntries(db.all("SELECT id, name FROM stores").map(s => [s.id, s.name]));
    const txt = os.map(o => { const ships = db.all("SELECT store_id, status FROM shipments WHERE order_id=?", o.id); const d = new Date(o.created_at + 5 * 3600000).toISOString(); return `🧾 <b>${h(o.num)}</b> · ${d.slice(8, 10)}.${d.slice(5, 7)} · ${money(o.total, ch.uz)}\n${ships.map(s => `   ${h(names[s.store_id] || s.store_id)}: ${SHIP[s.status]?.[ch.uz ? 1 : 0] || s.status}`).join("\n")}`; }).join("\n\n");
    return tg.send(ch.id, `${ch.L("<b>Ваши заказы</b>", "<b>Buyurtmalaringiz</b>")}\n\n${txt}\n\n${ch.L("Когда статус изменится — напишу сюда.", "Holat özgarsa — şu yerga yozaman.")}`, [[siteBtn(ch)]]);
  }
  function myBonus(ch) {
    if (!ch.user) return needLogin(ch);
    const u = db.get("SELECT * FROM users WHERE id=?", ch.user.id), code = bonus.codeFor(u), link = `${site}?ref=${code}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(ch.L(`Стройматериалы из магазинов Ташкента с доставкой — Imorat Go. По моей ссылке ${cfg.bonus?.referral ? money(cfg.bonus.referral) + " бонусов" : "бонус"} на первый заказ`, `Toşkent dökonlaridan quriliş mollari yetkaziş bilan — Imorat Go. Havolam orqali birinçi buyurtmaga ${cfg.bonus?.referral ? money(cfg.bonus.referral, true) + " bonus" : "bonus"}`))}`;
    return tg.send(ch.id, ch.L(`🎁 <b>Бонусы: ${money(u.points || 0)}</b>\nКешбэк приходит после получения заказа. Бонусами можно оплатить до 20% товаров.\n\n👫 Ваш код для друзей: <code>${code}</code>\nДругу — бонус сразу, вам — после его первого заказа.`, `🎁 <b>Bonuslar: ${money(u.points || 0, true)}</b>\nKeşbek buyurtma olinganidan keyin keladi. Bonus bilan mahsulotlarning 20% gaça tölaş mumkin.\n\n👫 Döstlar uçun kodingiz: <code>${code}</code>\nDöstga — bonus darhol, sizga — uning birinçi buyurtmasidan keyin.`),
      [[{ text: ch.L("📤 Отправить другу", "📤 Döstga yuboriş"), url: share }]]);
  }

  /* ---------- sign in by sharing the phone number ---------- */
  function signIn(ch, msg) {
    const ct = msg.contact;
    if (!ct || ct.user_id !== msg.from?.id) return menu(ch, ch.L("Отправьте именно свой номер — кнопкой «📱 Войти по номеру телефона» внизу.", "Aynan öz raqamingizni yuboring — pastdagi «📱 Telefon raqam bilan kiriş» tugmasi orqali."));
    let p = digits(ct.phone_number); if (p.length === 9) p = "998" + p;
    if (!/^998\d{9}$/.test(p)) return menu(ch, ch.L("Пока работаем только с номерами Узбекистана (+998).", "Hozirça faqat Özbekiston raqamlari (+998) bilan işlaymiz."));
    let u = db.get("SELECT * FROM users WHERE phone=?", p), isNew = false;
    if (!u) { isNew = true; db.run("INSERT INTO users(id,phone,name,email,role,district,created_at,lang) VALUES(?,?,?,'', 'buyer', 'mirob', ?, ?)", newUserId(), p, [ct.first_name, ct.last_name].filter(Boolean).join(" ").slice(0, 80), Date.now(), ch.uz ? "uz" : "ru"); u = db.get("SELECT * FROM users WHERE phone=?", p); }
    db.run("UPDATE users SET tg_chat=NULL WHERE tg_chat=?", ch.id);
    db.run("UPDATE users SET tg_chat=?, lang=? WHERE id=?", ch.id, ch.uz ? "uz" : "ru", u.id);
    db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", u.id, "tg.contact_login", u.id, JSON.stringify({ isNew }), "telegram", Date.now());
    const ch2 = chatOf(ch.id), pend = ch.c.state === "pend_mq" ? ch.data.mid : null;
    const st = u.store_id && db.get("SELECT name FROM stores WHERE id=?", u.store_id);
    menu(ch2, ch.L(`✅ Вы вошли${u.name ? ", " + h(u.name.split(" ")[0]) : ""}. Статусы заказов, ответы мастеров${st ? ` и заказы магазина «${h(st.name)}»` : ""} будут приходить сюда.${isNew ? "\nНа сайте войдите по этому же номеру — увидите всё то же самое." : ""}`, `✅ Kirdingiz${u.name ? ", " + h(u.name.split(" ")[0]) : ""}. Buyurtma holati, ustalar javobi${st ? ` va «${h(st.name)}» dökoni buyurtmalari` : ""} şu yerga keladi.${isNew ? "\nSaytga şu raqam bilan kiring — hammasi bir xil körinadi." : ""}`));
    if (pend) return startRequest(ch2, pend);
  }

  /* ---------- incoming updates ---------- */
  tg.on("ready", () => {
    const cmds = (uz) => [["start", uz ? "Boşlaş" : "Начать"], ["masters", uz ? "Ustalar" : "Мастера для ремонта"], ["orders", uz ? "Buyurtmalarim" : "Мои заказы"], ["requests", uz ? "Usta arizalari" : "Заявки (для мастеров)"], ["bonus", uz ? "Bonuslar" : "Бонусы"], ["lang", "Özbekça / Русский"], ["help", uz ? "Yordam" : "Помощь"]].map(([command, description]) => ({ command, description }));
    safe(tg.call("setMyCommands", { commands: cmds(false) }));
    safe(tg.call("setMyCommands", { commands: cmds(true), language_code: "uz" }));
  });
  tg.on("start", async (chat, token, from) => {
    const ch0 = chatOf(chat, from);
    const l = token && db.get("SELECT * FROM tg_links WHERE token=? AND expires_at>?", token, Date.now());
    if (l) {
      db.run("UPDATE users SET tg_chat=NULL WHERE tg_chat=?", String(chat));
      db.run("UPDATE users SET tg_chat=? WHERE id=?", String(chat), l.user_id);
      db.run("DELETE FROM tg_links WHERE token=?", token);
      const u = db.get("SELECT * FROM users WHERE id=?", l.user_id), st = u.store_id && db.get("SELECT name FROM stores WHERE id=?", u.store_id), ch = chatOf(chat, from);
      return menu(ch, st ? ch.L(`✅ Telegram подключён к магазину <b>${h(st.name)}</b>. Новые заказы будут приходить сюда с кнопками «Принять» и «Нет в наличии».`, `✅ Telegram <b>${h(st.name)}</b> dökoniga ulandi. Yangi buyurtmalar «Qabul qiliş» va «Mavjud emas» tugmalari bilan şu yerga keladi.`)
        : ch.L(`✅ Telegram подключён, ${h(u.name || "")}. Сюда будут приходить статусы заказов и ответы мастеров.\n\nА ещё здесь можно искать товары — просто напишите название.`, `✅ Telegram ulandi, ${h(u.name || "")}. Bu yerga buyurtma holati va ustalar javobi keladi.\n\nBu yerda mahsulot ham qidiriş mumkin — nomini yozing.`));
    }
    if (/^q_/.test(token || "")) return doSearch(ch0, decodeURIComponent(token.slice(2)).replace(/_/g, " "));
    if (token === "masters") return specMenu(ch0);
    setState(ch0, null);
    return menu(ch0, welcome(ch0, from));
  });
  tg.on("message", async msg => {
    const ch = chatOf(msg.chat.id, msg.from);
    if (flood(ch.id)) return;
    if (msg.contact) return signIn(ch, msg);
    const text = String(msg.text || "").trim();
    if (!text) return tg.send(ch.id, ch.L("Напишите текстом, что ищете 🙂", "Nima qidirayotganingizni matn bilan yozing 🙂"));
    const is = k => BTN[k].includes(text), cmd = (text.match(/^\/(\w+)/) || [])[1];
    // menu buttons and commands always win over an unfinished step
    if (is("lang") || cmd === "lang") { const uz = !ch.uz; db.run("UPDATE tg_chats SET lang=? WHERE chat=?", uz ? "uz" : "ru", ch.id); if (ch.user) db.run("UPDATE users SET lang=? WHERE id=?", uz ? "uz" : "ru", ch.user.id); const c2 = chatOf(ch.id); return menu(c2, c2.L("Язык: русский 🇷🇺", "Til: özbekça 🇺🇿")); }
    if (is("help") || cmd === "help") return menu(ch, helpText(ch), [[siteBtn(ch)], ...(channel ? [[{ text: "📣 @" + channel, url: "https://t.me/" + channel }]] : [])]);
    if (is("masters") || cmd === "masters") { setState(ch, null); return specMenu(ch); }
    if (is("orders") || cmd === "orders") return myOrders(ch);
    if (is("bonus") || cmd === "bonus") return myBonus(ch);
    if (is("requests") || cmd === "requests") return myRequests(ch);
    if (is("pause")) return togglePause(ch, true);
    if (is("resume")) return togglePause(ch, false);
    if (is("login")) return needLogin(ch);
    if (is("search") || cmd === "search") { setState(ch, null); return tg.send(ch.id, ch.L("Напишите, что ищете — например: <i>цемент м400</i>, <i>кран для кухни</i>, <i>ламинат дуб</i>.", "Nima kerakligini yozing — masalan: <i>sement m400</i>, <i>oşxona aralaştirgiçi</i>, <i>laminat</i>.")); }
    if (cmd === "menu") return menu(ch, ch.L("Меню 👇", "Menyu 👇"));
    if (cmd) return menu(ch, helpText(ch));
    // steps of a request to a master and of a review
    if (ch.c.state === "mreq_text") {
      if (text.length < 5) return tg.send(ch.id, ch.L("Опишите работу чуть подробнее 🙂", "Işni sal batafsilroq yozing 🙂"));
      setState(ch, "mreq_when", { ...ch.data, text: text.slice(0, 1000) });
      return tg.send(ch.id, ch.L("🕒 <b>Когда нужно?</b>", "🕒 <b>Qaçon kerak?</b>"), [...chunk(Object.entries(WHEN).map(([k, v]) => ({ text: ch.uz ? v[1] : v[0], callback_data: "wh:" + k })), 2), [{ text: ch.L("✖️ Отмена", "✖️ Bekor qiliş"), callback_data: "x" }]]);
    }
    if (ch.c.state === "review_text") { db.run("UPDATE master_requests SET review=? WHERE id=? AND user_id=?", text.slice(0, 1000), ch.data.rid, ch.user?.id || ""); setState(ch, null); masters.reviewed(ch.data.rid); return menu(ch, ch.L("Спасибо за отзыв! 🙏", "Şarh uçun rahmat! 🙏")); }
    return doSearch(ch, text);
  });
  /* returns true when the button belongs to the bot (not a seller's order button) */
  async function callback(q) {
    const data = String(q.data || ""), chat = q.message?.chat?.id, mid = q.message?.message_id;
    if (!/^(s|ms|mm|mq|wh|di|x|mr|rv|rvs)(:|$)/.test(data) || !chat || q.message?.chat?.type === "channel") return false;
    const ch = chatOf(chat, q.from), [a, b, c] = data.split(":");
    if (flood("cb:" + chat)) { safe(tg.answer(q.id)); return true; }
    if (a === "x") { setState(ch, null); await tg.answer(q.id, ch.L("Отменено", "Bekor qilindi")); safe(tg.editButtons(chat, mid, [])); return true; }
    if (a === "s") { await tg.answer(q.id); await doSearch(ch, data.slice(2)); return true; }
    if (a === "mm") { await tg.answer(q.id); await specMenu(ch); return true; }
    if (a === "ms") { await tg.answer(q.id); if (SPEC[b]) await mastersBySpec(ch, b); return true; }
    if (a === "mq") { await tg.answer(q.id); await startRequest(ch, b); return true; }
    if (a === "wh") {
      if (ch.c.state !== "mreq_when") { await tg.answer(q.id, ch.L("Начните заново: /masters", "Qaytadan boşlang: /masters")); return true; }
      await tg.answer(q.id); safe(tg.editButtons(chat, mid, []));
      setState(ch, "mreq_district", { ...ch.data, when: WHEN[b] ? b : "talk" });
      const ds = ref.districts.map(d => ({ text: ch.uz ? uzNew(d.uz) : d.ru, callback_data: "di:" + d.id }));
      await tg.send(ch.id, ch.L("📍 <b>Район?</b>", "📍 <b>Qaysi tuman?</b>"), [...chunk(ds, 3), [{ text: ch.L("Пропустить", "Ötkazib yuboriş"), callback_data: "di:-" }]]);
      return true;
    }
    if (a === "di") {
      if (ch.c.state !== "mreq_district") { await tg.answer(q.id, ch.L("Начните заново: /masters", "Qaytadan boşlang: /masters")); return true; }
      await tg.answer(q.id); safe(tg.editButtons(chat, mid, []));
      await finishRequest(ch, { ...ch.data, district: ref.districts.some(d => d.id === b) ? b : null });
      return true;
    }
    if (a === "mr") {
      const r = db.get("SELECT q.*, m.user_id muid, m.name mname, m.phone mphone FROM master_requests q JOIN masters m ON m.id=q.master_id WHERE q.id=?", Number(c));
      if (!r || !ch.user || r.muid !== ch.user.id) { await tg.answer(q.id, ch.L("Это не ваша заявка", "Bu sizning arizangiz emas")); return true; }
      const target = { acc: "accepted", dec: "declined", done: "done" }[b];
      if (!(masters.REQ_MOVES.master[r.status] || []).includes(target)) { await tg.answer(q.id, ch.L("Статус уже изменён", "Holat allaqaçon özgargan")); }
      else { masters.moveRequest(r, "master", target); await tg.answer(q.id, { accepted: ch.L("Принято! Клиент получил ваш номер", "Qabul qilindi! Mijoz raqamingizni oldi"), declined: ch.L("Отказ отправлен клиенту", "Rad javobi yuborildi"), done: ch.L("Отлично! Клиент сможет поставить оценку", "Ajoyib! Mijoz endi baho qöya oladi") }[target]); }
      const card = masters.masterCard(db.get("SELECT * FROM master_requests WHERE id=?", r.id));
      safe(tg.edit(chat, mid, card.text, card.buttons));
      return true;
    }
    if (a === "rv") {
      const r = db.get("SELECT * FROM master_requests WHERE id=?", Number(b)), stars = Math.min(5, Math.max(1, Number(c) || 0));
      if (!r || !ch.user || r.user_id !== ch.user.id || r.status !== "done") { await tg.answer(q.id, ch.L("Оценку поставить нельзя", "Baho qöyib bölmaydi")); return true; }
      if (r.stars) { await tg.answer(q.id, ch.L("Вы уже оценили", "Allaqaçon baholagansiz")); return true; }
      db.run("UPDATE master_requests SET stars=? WHERE id=?", stars, r.id);
      await tg.answer(q.id, "⭐".repeat(stars)); safe(tg.editButtons(chat, mid, []));
      setState(ch, "review_text", { rid: r.id });
      await tg.send(ch.id, ch.L(`Спасибо! ${"⭐".repeat(stars)}\nНапишите пару слов о работе мастера — это поможет другим людям.`, `Rahmat! ${"⭐".repeat(stars)}\nUstaning işi haqida bir-ikki söz yozing — boşqalarga yordam beradi.`), [[{ text: ch.L("Пропустить", "Ötkazib yuboriş"), callback_data: "rvs:" + r.id }]]);
      return true;
    }
    if (a === "rvs") {
      const mr = db.get("SELECT user_id FROM master_requests WHERE id=?", Number(b));
      if (!mr || !ch.user || mr.user_id !== ch.user.id) { await tg.answer(q.id); return true; }
      setState(ch, null); await tg.answer(q.id); safe(tg.editButtons(chat, mid, [])); masters.reviewed(Number(b)); await menu(ch, ch.L("Спасибо! 🙏", "Rahmat! 🙏")); return true;
    }
    return false;
  }
  return { callback };
}
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
