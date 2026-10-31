import { escHtml as h } from "./telegram.js";
import { createSearch } from "./search.js";
import { newUserId } from "./auth.js";

/* The Imorat Go Telegram bot for people and masters.
   Everyone: product search in plain words (typos, Uzbek, synonyms), masters by trade with a request
   in three taps, orders and bonuses, sign-in by sharing the phone number, RU / UZ / EN (picked from the Telegram UI language, changeable with /lang).
   Masters: requests arrive with Accept / Decline / Done buttons, list of open requests, pause button.
   Buyers rate the master with stars right after the job. Sellers keep their order buttons (app.js). */
const SPEC = { tile: ["🧱", "Плиточник", "Kafelçi", "Tiler"], elec: ["⚡", "Электрик", "Elektrik", "Electrician"], plumb: ["🚿", "Сантехник", "Santexnik", "Plumber"], paint: ["🎨", "Маляр-штукатур", "Böyoqçi-suvoqçi", "Painter & plasterer"], floor: ["🪵", "Полы и ламинат", "Pol va laminat", "Floors & laminate"],
  drywall: ["📐", "Гипсокартон", "Gipsokarton", "Drywall"], weld: ["🔥", "Сварщик", "Payvandçi", "Welder"], roof: ["🏠", "Кровельщик", "Tom yopuvçi", "Roofer"], furn: ["🪑", "Сборка мебели и кухонь", "Mebel va oşxona yiğiş", "Furniture & kitchen assembly"], ac: ["❄️", "Кондиционеры", "Konditsionerlar", "Air conditioners"], door: ["🚪", "Двери и окна", "Eşik va derazalar", "Doors & windows"],
  mason: ["🧱", "Каменщик", "Ğişt teruvçi", "Bricklayer"], concrete: ["🪣", "Бетонщик, фундамент", "Betonçi, poydevor", "Concrete & foundations"], demol: ["🔨", "Демонтаж", "Demontaj", "Demolition"], labor: ["👷", "Разнорабочие", "Mardikorlar", "General labourers"],
  excav: ["🚜", "Экскаватор", "Ekskavator", "Excavator"], tractor: ["🚜", "Тракторист, бульдозер", "Traktorçi, buldozer", "Tractor & bulldozer"], crane: ["🏗️", "Автокран, манипулятор", "Avtokran, manipulyator", "Crane & manipulator truck"], truck: ["🚛", "Самосвал, песок и щебень", "Samosval, qum va şağal", "Dump truck, sand & gravel"], mixer: ["🚚", "Миксер, доставка бетона", "Mikser, beton yetkaziş", "Concrete mixer truck"] };
const UNIT = { job: ["за работу", "iş uçun", "per job"], m2: ["за м²", "m² uçun", "per m²"], hour: ["в час", "soatiga", "per hour"], day: ["в день", "kuniga", "per day"], pt: ["за точку", "nuqta uçun", "per point"], shift: ["за смену", "smena uçun", "per shift"], trip: ["за рейс", "reys uçun", "per trip"], m3: ["за м³", "m³ uçun", "per m³"] };
const WHEN = { today: ["Сегодня", "Bugun", "Today"], tomorrow: ["Завтра", "Ertaga", "Tomorrow"], week: ["На этой неделе", "Şu hafta", "This week"], talk: ["Договоримся по телефону", "Telefonda kelişamiz", "We will agree by phone"] };
const SHIP = { unpaid: ["💳 ждёт оплаты картой", "💳 karta bilan tölovni kutmoqda", "💳 waiting for card payment"], new: ["🆕 ждёт подтверждения магазина", "🆕 dökon tasdiqlaşini kutmoqda", "🆕 waiting for the store to confirm"], assembling: ["🛠 магазин собирает", "🛠 dökon yiğmoqda", "🛠 the store is packing"], searching: ["🚚 ищем курьера", "🚚 kuryer qidirilmoqda", "🚚 looking for a courier"], to_store: ["🚚 курьер едет в магазин", "🚚 kuryer dökonga ketmoqda", "🚚 courier on the way to the store"],
  on_way: ["🚚 в пути к вам", "🚚 sizga kelmoqda", "🚚 on the way to you"], delivered: ["✅ доставлен", "✅ yetkazildi", "✅ delivered"], ready: ["📦 готов к выдаче", "📦 olib ketişga tayyor", "📦 ready for pickup"], picked: ["✅ выдан", "✅ topşirildi", "✅ picked up"], cancelled: ["❌ отменён", "❌ bekor qilindi", "❌ cancelled"] };
const uzNew = t => String(t || "").replace(/O[‘ʻ'`]/g, "Ö").replace(/o[‘ʻ'`]/g, "ö").replace(/G[‘ʻ'`]/g, "Ğ").replace(/g[‘ʻ'`]/g, "ğ").replace(/SH/g, "Ş").replace(/Sh/g, "Ş").replace(/sh/g, "ş").replace(/CH/g, "Ç").replace(/Ch/g, "Ç").replace(/ch/g, "ç");
const money = (n, lang) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ") + (lang === true || lang === "uz" ? " söm" : lang === "en" ? " UZS" : " сум");
const LI = { ru: 0, uz: 1, en: 2 }; // index of a language in the text tables
const DIST_EN = { chil: "Chilanzar", yunus: "Yunusabad", serg: "Sergeli", mirzo: "Mirzo Ulugbek", yakka: "Yakkasaray", shayx: "Shaykhantakhur", mirob: "Mirabad", olmaz: "Almazar", ucht: "Uchtepa", yash: "Yashnabad", bekt: "Bektemir", yangi: "Yangihayot" };
const distName = (ch, d) => (ch.uz ? uzNew(d.uz || d.id) : ch.lang === "en" ? (DIST_EN[d.id] || d.ru || d.id) : d.ru || d.id);
const digits = v => String(v || "").replace(/\D/g, "");
/* every button label in both languages, so the menu works after switching language */
const BTN = {
  search: ["🔎 Найти товар", "🔎 Mahsulot qidiriş", "🔎 Find a product"], masters: ["🧰 Мастера", "🧰 Ustalar", "🧰 Pros"], orders: ["📦 Мои заказы", "📦 Buyurtmalarim", "📦 My orders"], bonus: ["🎁 Бонусы", "🎁 Bonuslar", "🎁 Bonuses"],
  requests: ["📋 Мои заявки", "📋 Arizalarim", "📋 My requests"], pause: ["⏸ Пауза для заявок", "⏸ Arizalarni töxtatiş", "⏸ Pause requests"], resume: ["▶️ Снова принимать заявки", "▶️ Arizalarni qayta qabul qiliş", "▶️ Accept requests again"],
  login: ["📱 Войти по номеру телефона", "📱 Telefon raqam bilan kiriş", "📱 Sign in with my phone number"], lang: ["🌐 Язык", "🌐 Til", "🌐 Language"], help: ["ℹ️ Помощь", "ℹ️ Yordam", "ℹ️ Help"], site: ["🌐 Сайт", "🌐 Sayt", "🌐 Website"]
};
const LANGS = { ru: "Русский 🇷🇺", uz: "Özbekça 🇺🇿", en: "English 🇬🇧" };

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
      const lc = from?.language_code || "";
      const lang = LI[u0?.lang] != null ? u0.lang : /^uz/.test(lc) ? "uz" : /^(ru|uk|be|kk|ky|tg|az|hy|ka|tk|mo)/.test(lc) || !lc ? "ru" : "en"; // Telegram UI language picks the start language
      db.run("INSERT OR IGNORE INTO tg_chats(chat,lang,updated_at) VALUES(?,?,?)", chat, lang, Date.now());
      c = db.get("SELECT * FROM tg_chats WHERE chat=?", chat);
    }
    if (c.state && Date.now() - (c.updated_at || 0) > 2 * 3600000) { db.run("UPDATE tg_chats SET state=NULL, data=NULL WHERE chat=?", chat); c = { ...c, state: null, data: null }; }
    const user = db.get("SELECT * FROM users WHERE tg_chat=?", chat);
    const lang = LI[c.lang] != null ? c.lang : "ru", uz = lang === "uz", L = (ru, uzT, en) => (uz ? uzNew(uzT) : lang === "en" && en != null ? en : ru);
    return { id: chat, c, user, uz, lang, L, b: k => BTN[k][LI[lang]], t: arr => arr[LI[lang]] ?? arr[0], q: (amp = false) => (lang === "ru" ? "" : (amp ? `lang=${lang}&` : `?lang=${lang}`)), data: c.data ? JSON.parse(c.data) : {} };
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
  const siteBtn = ch => ({ text: ch.b("site"), url: site + ch.q() });

  /* ---------- texts ---------- */
  function welcome(ch, from) {
    const name = h(from?.first_name || ch.user?.name?.split(" ")[0] || "");
    return ch.L(`Ассалому алейкум${name ? ", " + name : ""}! 👋\n\nЯ бот <b>Imorat Go</b> — стройматериалы из магазинов Ташкента и мастера для ремонта.\n\n🔎 <b>Напишите, что ищете</b> — «цемент м400», «кран для ванны», «ламинат дуб» — я найду и покажу цены.\n🧰 <b>Мастера</b> — плиточники, электрики, сантехники: выберите и отправьте заявку.\n📦 Статусы заказов и ответы мастеров приходят сюда.${ch.user ? "" : "\n\n📱 Чтобы оформлять заявки и видеть заказы, нажмите «Войти по номеру телефона» внизу."}`,
      `Assalomu alaykum${name ? ", " + name : ""}! 👋\n\nMen <b>Imorat Go</b> botiman — Toşkent dökonlaridan quriliş mollari va ta’mir ustalari.\n\n🔎 <b>Nima kerakligini yozing</b> — «sement m400», «laminat», «aralaştirgiç» — topib, narxlarini körsataman.\n🧰 <b>Ustalar</b> — kafelçi, elektrik, santexnik: tanlang va ariza yuboring.\n📦 Buyurtma holati va ustalar javobi şu yerga keladi.${ch.user ? "" : "\n\n📱 Ariza beriş va buyurtmalarni köriş uçun pastdagi «Telefon raqam bilan kiriş» tugmasini bosing."}`,
      `Hello${name ? ", " + name : ""}! 👋\n\nI am the <b>Imorat Go</b> bot — building materials from Tashkent stores and pros for your renovation.\n\n🔎 <b>Type what you need</b> — "cement m400", "bath tap", "oak laminate" — I will find it and show prices.\n🧰 <b>Pros</b> — tilers, electricians, plumbers: pick one and send a request.\n📦 Order statuses and replies from pros arrive here.${ch.user ? "" : "\n\n📱 To send requests and see your orders, tap \"Sign in with my phone number\" below."}`);
  }
  const helpText = ch => ch.L(`<b>Что умеет бот</b>\n\n🔎 Просто напишите название товара — можно с ошибками, по-русски или по-узбекски.\n🧰 /masters — мастера по специальностям и заявка в три шага.\n📦 /orders — ваши заказы и где они сейчас.\n🎁 /bonus — бонусы и код для друзей.${masterOf(ch.user) ? "\n📋 /requests — ваши заявки как мастера, кнопки «Принять» и «Выполнено»." : ""}\n🌐 /lang — Русский / Özbekça / English.\n\nМагазинам: заказы с кнопками приходят сюда после «Подключить Telegram» в кабинете продавца.${channel ? `\n\n📣 Скидки и товар дня — в канале @${channel}` : ""}`,
    `<b>Bot nimalar qila oladi</b>\n\n🔎 Mahsulot nomini yozing — xato bilan ham, özbekça yoki rusça.\n🧰 /masters — ustalar va uç qadamda ariza.\n📦 /orders — buyurtmalaringiz va ular qayerda.\n🎁 /bonus — bonuslar va döstlar uçun kod.${masterOf(ch.user) ? "\n📋 /requests — usta sifatida arizalaringiz, «Qabul qiliş» va «Bajarildi» tugmalari." : ""}\n🌐 /lang — Русский / Özbekça / English.\n\nDökonlarga: sotuvçi kabinetida «Telegramni ulaş» dan keyin buyurtmalar şu yerga keladi.${channel ? `\n\n📣 Çegirmalar va kun mahsuloti — @${channel} kanalida` : ""}`,
    `<b>What the bot can do</b>\n\n🔎 Just type a product name — typos are fine, in Russian, Uzbek or English.\n🧰 /masters — pros by trade and a request in three steps.\n📦 /orders — your orders and where they are now.\n🎁 /bonus — bonuses and a code for friends.${masterOf(ch.user) ? "\n📋 /requests — your requests as a pro, with Accept and Done buttons." : ""}\n🌐 /lang — Русский / Özbekça / English.\n\nFor stores: orders with buttons arrive here after \"Connect Telegram\" in the seller cabinet.${channel ? `\n\n📣 Deals and the product of the day — in the channel @${channel}` : ""}`);
  const needLogin = ch => menu(ch, ch.L("Сначала войдите — нажмите «📱 Войти по номеру телефона» внизу. Это безопасно: Telegram сам подтверждает, что номер ваш.", "Avval kiring — pastdagi «📱 Telefon raqam bilan kiriş» tugmasini bosing. Bu xavfsiz: raqam sizniki ekanini Telegram özi tasdiqlaydi.", "Sign in first — tap \"📱 Sign in with my phone number\" below. It is safe: Telegram itself confirms the number is yours."));

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
    if (q.length < 2) return menu(ch, ch.L("Напишите название товара, например: <i>цемент м400</i>", "Mahsulot nomini yozing, masalan: <i>sement m400</i>", "Type a product name, for example: <i>cement m400</i>"));
    safe(tg.typing(ch.id));
    const r = search(q, products(), 6), aiUrl = `${site}?${ch.q(true)}ai=${encodeURIComponent(q)}`;
    if (!r.list.length) return tg.send(ch.id, ch.L(`По запросу «${h(q)}» ничего не нашли 🤔\nПопробуйте другое слово или опишите задачу Usta AI — он подберёт материалы и посчитает количество.`, `«${h(q)}» böyiça heç narsa topilmadi 🤔\nBoşqa söz bilan yozing yoki vazifani Usta AI ga tuşuntiring — u materiallarni tanlab, miqdorini hisoblaydi.`, `Nothing found for "${h(q)}" 🤔\nTry another word or describe the job to Usta AI — it picks the materials and works out quantities.`),
      [[{ text: ch.L("🤖 Спросить Usta AI", "🤖 Usta AI dan söraş", "🤖 Ask Usta AI"), url: aiUrl }], ...[ch.L("цемент", "sement", "cement"), ch.L("ламинат", "laminat", "laminate"), ch.L("смеситель", "aralaştirgiç", "tap")].map(x => [{ text: "🔎 " + x, callback_data: "s:" + x.slice(0, 28) }])]);
    const name = p => (ch.uz ? uzNew(p.uz) : ch.lang === "en" && p.en ? p.en : p.ru);
    const from = v => ch.L(`от ${money(v)}`, `${money(v, "uz")}dan`, `from ${money(v, "en")}`);
    const head = r.fix ? ch.L(`Исправили опечатку: <b>${h(r.fix)}</b>\n`, `Xato tuzatildi: <b>${h(r.fix)}</b>\n`, `Corrected the typo: <b>${h(r.fix)}</b>\n`) : r.loose ? ch.L("Точных совпадений нет — вот похожее:\n", "Aniq mos kelmadi — öxşaşlari:\n", "No exact match — similar items:\n") : "";
    const lines = r.list.map(({ p }, i) => `${i + 1}. <b>${h(name(p))}</b>\n    ${from(p.min)} · ${p.n} ${ch.L(p.n === 1 ? "магазин" : p.n < 5 ? "магазина" : "магазинов", "dökon", p.n === 1 ? "store" : "stores")}`).join("\n");
    const btns = r.list.map(({ p }, i) => [{ text: `${i + 1}. ${name(p).slice(0, 34)} — ${money(p.min, ch.lang)}`, url: `${site}${ch.q()}#p-${p.id}` }]);
    btns.push([{ text: ch.L(`🌐 Все результаты (${r.total})`, `🌐 Barça natijalar (${r.total})`, `🌐 All results (${r.total})`), url: `${site}?${ch.q(true)}q=${encodeURIComponent(q)}` }]);
    btns.push([{ text: ch.L("🤖 Спросить Usta AI: сколько нужно?", "🤖 Usta AI: qança kerak?", "🤖 Ask Usta AI: how much do I need?"), url: aiUrl }]);
    return tg.send(ch.id, `${head}🔎 ${ch.L("Нашли", "Topildi", "Found")}: <b>${r.total}</b>\n\n${lines}\n\n${ch.L("Нажмите на товар — откроется карточка с ценами всех магазинов и доставкой.", "Mahsulotni bosing — barça dökonlar narxi va yetkaziş bilan kartoçka oçiladi.", "Tap a product to open its page with every store's price and delivery.")}`, btns);
  }

  /* ---------- masters for people ---------- */
  const specName = (ch, sp) => sp[1 + LI[ch.lang]] || sp[1];
  const specMenu = ch => tg.send(ch.id, ch.L("🧰 <b>Какой мастер нужен?</b>\nВсе мастера проверены модератором, у каждого — отзывы клиентов Imorat Go.", "🧰 <b>Qanday usta kerak?</b>\nBarça ustalar moderator tomonidan tekşirilgan, har birida Imorat Go mijozlari şarhlari bor.", "🧰 <b>Which pro do you need?</b>\nEvery pro is checked by a moderator and has reviews from Imorat Go customers."),
    [...chunk(Object.entries(SPEC).map(([k, v]) => ({ text: `${v[0]} ${specName(ch, v)}`, callback_data: "ms:" + k })), 2), [{ text: ch.L("🧑‍🔧 Я мастер — разместить анкету", "🧑‍🔧 Men ustaman — anketa joylaş", "🧑‍🔧 I am a pro — list my profile"), url: `${site}${ch.q()}#masters` }]]);
  function mastersBySpec(ch, spec) {
    const st = masters.stats(), D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
    const list = db.all("SELECT * FROM masters WHERE status='active' AND busy=0").map(m => masters.pub(m, st[m.id])).filter(m => m.specs.includes(spec))
      .sort((a, b) => (b.stars || 0) - (a.stars || 0) || b.done - a.done).slice(0, 6);
    const sp = SPEC[spec];
    if (!list.length) return tg.send(ch.id, ch.L(`Пока нет свободных мастеров «${sp[1]}». Загляните позже или посмотрите на сайте.`, `Hozirça boş «${sp[2]}» ustalari yöq. Keyinroq qarang yoki saytda köring.`, `No available pros for "${sp[3]}" right now. Check back later or look on the website.`), [[{ text: ch.L("🧰 Все мастера на сайте", "🧰 Saytdagi barça ustalar", "🧰 All pros on the website"), url: `${site}${ch.q()}#masters` }], [{ text: ch.L("← Другие специальности", "← Boşqa kasblar", "← Other trades"), callback_data: "mm" }]]);
    const dn = d => h(D[d] ? distName(ch, D[d]) : d);
    const txt = list.map(m => `👷 <b>${h(m.name)}</b>${m.stars ? ` ⭐ ${String(m.stars).replace(".", ch.lang === "en" ? "." : ",")} (${m.reviews})` : ""}${m.done ? ` · ${m.done} ${ch.L("работ", "iş", m.done === 1 ? "job" : "jobs")}` : ""}\n📍 ${m.districts.slice(0, 3).map(dn).join(", ")}${m.districts.length > 3 ? " +" + (m.districts.length - 3) : ""}${m.exp ? ` · ${m.exp} ${ch.L("лет опыта", "yil tajriba", m.exp === 1 ? "year of experience" : "years of experience")}` : ""}\n💰 ${m.price ? `${ch.L(`от ${money(m.price)}`, `${money(m.price, "uz")}dan`, `from ${money(m.price, "en")}`)} ${ch.t(UNIT[m.price_unit] || [""])}` : ch.L("цена по договорённости", "narx kelişiladi", "price by agreement")}${m.about ? `\n<i>${h(m.about.slice(0, 110))}${m.about.length > 110 ? "…" : ""}</i>` : ""}`).join("\n\n");
    return tg.send(ch.id, `${sp[0]} <b>${specName(ch, sp)}</b>\n\n${txt}`, [...list.map(m => [{ text: ch.L(`📩 Позвать: ${m.name}`, `📩 Çaqiriş: ${m.name}`, `📩 Request: ${m.name}`).slice(0, 60), callback_data: "mq:" + m.id }]), [{ text: ch.L("← Другие специальности", "← Boşqa kasblar", "← Other trades"), callback_data: "mm" }]]);
  }
  function startRequest(ch, mid) {
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", mid);
    if (!m) return tg.send(ch.id, ch.L("Мастер сейчас недоступен — выберите другого: /masters", "Usta hozir mavjud emas — boşqasini tanlang: /masters", "This pro is not available right now — choose another: /masters"));
    if (!ch.user) { setState(ch, "pend_mq", { mid }); return needLogin(ch); }
    if (m.user_id === ch.user.id) return tg.send(ch.id, ch.L("Это ваша анкета 🙂", "Bu sizning anketangiz 🙂", "That is your own profile 🙂"));
    setState(ch, "mreq_text", { mid });
    return tg.send(ch.id, ch.L(`📩 Заявка мастеру <b>${h(m.name)}</b>\n\n<b>Опишите работу</b> одним сообщением: что сделать, сколько м² или точек, есть ли материалы.\n<i>Например: положить плитку в ванной 6 м², плитка уже куплена.</i>`, `📩 Usta <b>${h(m.name)}</b> ga ariza\n\n<b>Işni bitta xabarda yozing</b>: nima qiliş kerak, neça m² yoki nuqta, materiallar bormi.\n<i>Masalan: vannaxonaga 6 m² kafel yotqiziş, kafel olingan.</i>`, `📩 Request to <b>${h(m.name)}</b>\n\n<b>Describe the job</b> in one message: what to do, how many m² or points, whether you have the materials.\n<i>For example: tile a 6 m² bathroom, tiles already bought.</i>`), [[{ text: ch.L("✖️ Отмена", "✖️ Bekor qiliş", "✖️ Cancel"), callback_data: "x" }]]);
  }
  function finishRequest(ch, d) {
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", d.mid), u = ch.user;
    setState(ch, null);
    if (!m || !u) return tg.send(ch.id, ch.L("Мастер сейчас недоступен — выберите другого: /masters", "Usta hozir mavjud emas — boşqasini tanlang: /masters", "This pro is not available right now — choose another: /masters"));
    const day = db.get("SELECT COUNT(*) n FROM master_requests WHERE user_id=? AND created_at>?", u.id, Date.now() - 86400000).n;
    if (day >= 10) return tg.send(ch.id, ch.L("Сегодня отправлено уже 10 заявок. Попробуйте завтра.", "Bugun allaqaçon 10 ta ariza yuborildi. Ertaga urinib köring.", "You have already sent 10 requests today. Try again tomorrow."));
    if (!u.phone) return needLogin(ch);
    const id = masters.createRequest(u, m, { text: d.text, when: WHEN[d.when]?.[0] || "как можно скорее", district: d.district || null, street: "" });
    return menu(ch, ch.L(`✅ Заявка №${id} отправлена мастеру <b>${h(m.name)}</b>.\nКогда мастер примет — пришлём сюда его номер телефона.`, `✅ №${id} ariza usta <b>${h(m.name)}</b> ga yuborildi.\nUsta qabul qilganda telefon raqamini şu yerga yuboramiz.`, `✅ Request #${id} sent to <b>${h(m.name)}</b>.\nWhen the pro accepts, we will send you their phone number here.`));
  }

  /* ---------- masters: their requests ---------- */
  function myRequests(ch) {
    const m = masterOf(ch.user);
    if (!m) return tg.send(ch.id, ch.L("У вас ещё нет анкеты мастера. Разместите её на сайте — после проверки клиенты начнут присылать заявки.", "Sizda hali usta anketasi yöq. Saytda joylaştiring — tekşiruvdan keyin mijozlar ariza yubora boşlaydi.", "You do not have a pro profile yet. List it on the website — after moderation, customers will start sending requests."), [[{ text: ch.L("🧑‍🔧 Разместить анкету", "🧑‍🔧 Anketa joylaş", "🧑‍🔧 List my profile"), url: `${site}${ch.q()}#masters` }]]);
    if (m.status !== "active") return tg.send(ch.id, ch.L("Анкета на проверке у модератора — как только одобрим, сообщим сюда.", "Anketa moderator tekşiruvida — tasdiqlanişi bilan şu yerga xabar beramiz.", "Your profile is being reviewed by a moderator — we will tell you here as soon as it is approved."));
    const list = db.all("SELECT * FROM master_requests WHERE master_id=? AND status IN ('new','accepted') ORDER BY id DESC LIMIT 6", m.id);
    if (!list.length) return menu(ch, ch.L(`Открытых заявок нет.${m.busy ? "\n⏸ Сейчас вы на паузе — новые клиенты вас не видят." : ""}`, `Oçiq arizalar yöq.${m.busy ? "\n⏸ Hozir pauzadasiz — yangi mijozlar sizni körmaydi." : ""}`, `No open requests.${m.busy ? "\n⏸ You are paused — new customers do not see you." : ""}`));
    return list.reduce((p, q) => p.then(() => { const c = masters.masterCard(q); return tg.send(ch.id, c.text, c.buttons); }), Promise.resolve());
  }
  function togglePause(ch, busy) {
    const m = masterOf(ch.user); if (!m) return myRequests(ch);
    db.run("UPDATE masters SET busy=? WHERE id=?", busy ? 1 : 0, m.id);
    return menu(chatOf(ch.id), busy ? ch.L("⏸ Пауза включена: новые клиенты не видят вашу анкету. Открытые заявки остаются — их можно выполнить.", "⏸ Pauza yoqildi: yangi mijozlar anketangizni körmaydi. Oçiq arizalar qoladi.", "⏸ Paused: new customers do not see your profile. Open requests stay and can still be completed.") : ch.L("▶️ Вы снова принимаете заявки — анкета видна клиентам.", "▶️ Yana ariza qabul qilyapsiz — anketa mijozlarga körinadi.", "▶️ You accept requests again — your profile is visible to customers."));
  }

  /* ---------- orders and bonuses ---------- */
  function myOrders(ch) {
    if (!ch.user) return needLogin(ch);
    const os = db.all("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5", ch.user.id);
    if (!os.length) return tg.send(ch.id, ch.L("Заказов пока нет. Напишите, что нужно купить — я найду 🔎", "Hozirça buyurtmalar yöq. Nima oliş kerakligini yozing — topaman 🔎", "No orders yet. Tell me what you need to buy — I will find it 🔎"), [[siteBtn(ch)]]);
    const names = Object.fromEntries(db.all("SELECT id, name FROM stores").map(s => [s.id, s.name]));
    const txt = os.map(o => { const ships = db.all("SELECT store_id, status FROM shipments WHERE order_id=?", o.id); const d = new Date(o.created_at + 5 * 3600000).toISOString(); return `🧾 <b>${h(o.num)}</b> · ${d.slice(8, 10)}.${d.slice(5, 7)} · ${money(o.total, ch.lang)}\n${ships.map(s => `   ${h(names[s.store_id] || s.store_id)}: ${SHIP[s.status] ? ch.t(SHIP[s.status]) : s.status}`).join("\n")}`; }).join("\n\n");
    return tg.send(ch.id, `${ch.L("<b>Ваши заказы</b>", "<b>Buyurtmalaringiz</b>", "<b>Your orders</b>")}\n\n${txt}\n\n${ch.L("Когда статус изменится — напишу сюда.", "Holat özgarsa — şu yerga yozaman.", "I will write here when a status changes.")}`, [[siteBtn(ch)]]);
  }
  function myBonus(ch) {
    if (!ch.user) return needLogin(ch);
    const u = db.get("SELECT * FROM users WHERE id=?", ch.user.id), code = bonus.codeFor(u), link = `${site}?ref=${code}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(ch.L(`Стройматериалы из магазинов Ташкента с доставкой — Imorat Go. По моей ссылке ${cfg.bonus?.referral ? money(cfg.bonus.referral) + " бонусов" : "бонус"} на первый заказ`, `Toşkent dökonlaridan quriliş mollari yetkaziş bilan — Imorat Go. Havolam orqali birinçi buyurtmaga ${cfg.bonus?.referral ? money(cfg.bonus.referral, true) + " bonus" : "bonus"}`, `Building materials from Tashkent stores with delivery — Imorat Go. With my link you get ${cfg.bonus?.referral ? money(cfg.bonus.referral, "en") + " in bonuses" : "a bonus"} on your first order`))}`;
    return tg.send(ch.id, ch.L(`🎁 <b>Бонусы: ${money(u.points || 0)}</b>\nКешбэк приходит после получения заказа. Бонусами можно оплатить до 20% товаров.\n\n👫 Ваш код для друзей: <code>${code}</code>\nДругу — бонус сразу, вам — после его первого заказа.`, `🎁 <b>Bonuslar: ${money(u.points || 0, true)}</b>\nKeşbek buyurtma olinganidan keyin keladi. Bonus bilan mahsulotlarning 20% gaça tölaş mumkin.\n\n👫 Döstlar uçun kodingiz: <code>${code}</code>\nDöstga — bonus darhol, sizga — uning birinçi buyurtmasidan keyin.`, `🎁 <b>Bonuses: ${money(u.points || 0, "en")}</b>\nCashback arrives after you receive the order. Bonuses pay for up to 20% of the goods.\n\n👫 Your code for friends: <code>${code}</code>\nYour friend gets a bonus right away, you — after their first order.`),
      [[{ text: ch.L("📤 Отправить другу", "📤 Döstga yuboriş", "📤 Send to a friend"), url: share }]]);
  }

  /* ---------- sign in by sharing the phone number ---------- */
  function signIn(ch, msg) {
    const ct = msg.contact;
    if (!ct || ct.user_id !== msg.from?.id) return menu(ch, ch.L("Отправьте именно свой номер — кнопкой «📱 Войти по номеру телефона» внизу.", "Aynan öz raqamingizni yuboring — pastdagi «📱 Telefon raqam bilan kiriş» tugmasi orqali.", "Share your own number — with the \"📱 Sign in with my phone number\" button below."));
    let p = digits(ct.phone_number); if (p.length === 9) p = "998" + p;
    if (!/^998\d{9}$/.test(p)) return menu(ch, ch.L("Пока работаем только с номерами Узбекистана (+998).", "Hozirça faqat Özbekiston raqamlari (+998) bilan işlaymiz.", "For now we work only with Uzbekistan numbers (+998)."));
    let u = db.get("SELECT * FROM users WHERE phone=?", p), isNew = false;
    if (!u) { isNew = true; db.run("INSERT INTO users(id,phone,name,email,role,district,created_at,lang) VALUES(?,?,?,'', 'buyer', 'mirob', ?, ?)", newUserId(), p, [ct.first_name, ct.last_name].filter(Boolean).join(" ").slice(0, 80), Date.now(), ch.lang); u = db.get("SELECT * FROM users WHERE phone=?", p); }
    db.run("UPDATE users SET tg_chat=NULL WHERE tg_chat=?", ch.id);
    db.run("UPDATE users SET tg_chat=?, lang=? WHERE id=?", ch.id, ch.lang, u.id);
    db.run("INSERT INTO audit(user_id,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?)", u.id, "tg.contact_login", u.id, JSON.stringify({ isNew }), "telegram", Date.now());
    const ch2 = chatOf(ch.id), pend = ch.c.state === "pend_mq" ? ch.data.mid : null;
    const st = u.store_id && db.get("SELECT name FROM stores WHERE id=?", u.store_id);
    menu(ch2, ch.L(`✅ Вы вошли${u.name ? ", " + h(u.name.split(" ")[0]) : ""}. Статусы заказов, ответы мастеров${st ? ` и заказы магазина «${h(st.name)}»` : ""} будут приходить сюда.${isNew ? "\nНа сайте войдите по этому же номеру — увидите всё то же самое." : ""}`, `✅ Kirdingiz${u.name ? ", " + h(u.name.split(" ")[0]) : ""}. Buyurtma holati, ustalar javobi${st ? ` va «${h(st.name)}» dökoni buyurtmalari` : ""} şu yerga keladi.${isNew ? "\nSaytga şu raqam bilan kiring — hammasi bir xil körinadi." : ""}`, `✅ You are signed in${u.name ? ", " + h(u.name.split(" ")[0]) : ""}. Order statuses, replies from pros${st ? ` and orders for the store "${h(st.name)}"` : ""} will arrive here.${isNew ? "\nSign in on the website with the same number to see the same things there." : ""}`));
    if (pend) return startRequest(ch2, pend);
  }

  /* ---------- incoming updates ---------- */
  tg.on("ready", () => {
    const cmds = (lang) => [["start", ["Начать", "Boşlaş", "Start"]], ["masters", ["Мастера для ремонта", "Ustalar", "Pros for your renovation"]], ["orders", ["Мои заказы", "Buyurtmalarim", "My orders"]], ["requests", ["Заявки (для мастеров)", "Usta arizalari", "Requests (for pros)"]], ["bonus", ["Бонусы", "Bonuslar", "Bonuses"]], ["lang", ["Язык / Til / Language", "Til / Язык / Language", "Language / Язык / Til"]], ["help", ["Помощь", "Yordam", "Help"]]].map(([command, d]) => ({ command, description: d[LI[lang]] }));
    safe(tg.call("setMyCommands", { commands: cmds("ru") }));
    safe(tg.call("setMyCommands", { commands: cmds("uz"), language_code: "uz" }));
    safe(tg.call("setMyCommands", { commands: cmds("en"), language_code: "en" }));
  });
  tg.on("start", async (chat, token, from) => {
    const ch0 = chatOf(chat, from);
    const l = token && db.get("SELECT * FROM tg_links WHERE token=? AND expires_at>?", token, Date.now());
    if (l) {
      db.run("UPDATE users SET tg_chat=NULL WHERE tg_chat=?", String(chat));
      db.run("UPDATE users SET tg_chat=? WHERE id=?", String(chat), l.user_id);
      db.run("DELETE FROM tg_links WHERE token=?", token);
      const u = db.get("SELECT * FROM users WHERE id=?", l.user_id), st = u.store_id && db.get("SELECT name FROM stores WHERE id=?", u.store_id), ch = chatOf(chat, from);
      return menu(ch, st ? ch.L(`✅ Telegram подключён к магазину <b>${h(st.name)}</b>. Новые заказы будут приходить сюда с кнопками «Принять» и «Нет в наличии».`, `✅ Telegram <b>${h(st.name)}</b> dökoniga ulandi. Yangi buyurtmalar «Qabul qiliş» va «Mavjud emas» tugmalari bilan şu yerga keladi.`, `✅ Telegram is connected to the store <b>${h(st.name)}</b>. New orders will arrive here with "Accept" and "Out of stock" buttons.`)
        : ch.L(`✅ Telegram подключён, ${h(u.name || "")}. Сюда будут приходить статусы заказов и ответы мастеров.\n\nА ещё здесь можно искать товары — просто напишите название.`, `✅ Telegram ulandi, ${h(u.name || "")}. Bu yerga buyurtma holati va ustalar javobi keladi.\n\nBu yerda mahsulot ham qidiriş mumkin — nomini yozing.`, `✅ Telegram is connected, ${h(u.name || "")}. Order statuses and replies from pros will arrive here.\n\nYou can also search for products here — just type a name.`));
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
    if (!text) return tg.send(ch.id, ch.L("Напишите текстом, что ищете 🙂", "Nima qidirayotganingizni matn bilan yozing 🙂", "Type what you are looking for 🙂"));
    const is = k => BTN[k].includes(text), cmd = (text.match(/^\/(\w+)/) || [])[1];
    // menu buttons and commands always win over an unfinished step
    if (is("lang") || cmd === "lang") return tg.send(ch.id, ch.L("🌐 Выберите язык", "🌐 Tilni tanlang", "🌐 Choose a language"), [Object.entries(LANGS).filter(([k]) => k !== ch.lang).map(([k, v]) => ({ text: v, callback_data: "lg:" + k }))]);
    if (is("help") || cmd === "help") return menu(ch, helpText(ch), [[siteBtn(ch)], ...(channel ? [[{ text: "📣 @" + channel, url: "https://t.me/" + channel }]] : [])]);
    if (is("masters") || cmd === "masters") { setState(ch, null); return specMenu(ch); }
    if (is("orders") || cmd === "orders") return myOrders(ch);
    if (is("bonus") || cmd === "bonus") return myBonus(ch);
    if (is("requests") || cmd === "requests") return myRequests(ch);
    if (is("pause")) return togglePause(ch, true);
    if (is("resume")) return togglePause(ch, false);
    if (is("login")) return needLogin(ch);
    if (is("search") || cmd === "search") { setState(ch, null); return tg.send(ch.id, ch.L("Напишите, что ищете — например: <i>цемент м400</i>, <i>кран для кухни</i>, <i>ламинат дуб</i>.", "Nima kerakligini yozing — masalan: <i>sement m400</i>, <i>oşxona aralaştirgiçi</i>, <i>laminat</i>.", "Type what you need — for example: <i>cement m400</i>, <i>kitchen tap</i>, <i>oak laminate</i>.")); }
    if (cmd === "menu") return menu(ch, ch.L("Меню 👇", "Menyu 👇", "Menu 👇"));
    if (cmd) return menu(ch, helpText(ch));
    // steps of a request to a master and of a review
    if (ch.c.state === "mreq_text") {
      if (text.length < 5) return tg.send(ch.id, ch.L("Опишите работу чуть подробнее 🙂", "Işni sal batafsilroq yozing 🙂", "Describe the job in a little more detail 🙂"));
      setState(ch, "mreq_when", { ...ch.data, text: text.slice(0, 1000) });
      return tg.send(ch.id, ch.L("🕒 <b>Когда нужно?</b>", "🕒 <b>Qaçon kerak?</b>", "🕒 <b>When do you need it?</b>"), [...chunk(Object.entries(WHEN).map(([k, v]) => ({ text: ch.t(v), callback_data: "wh:" + k })), 2), [{ text: ch.L("✖️ Отмена", "✖️ Bekor qiliş", "✖️ Cancel"), callback_data: "x" }]]);
    }
    if (ch.c.state === "review_text") { db.run("UPDATE master_requests SET review=? WHERE id=? AND user_id=?", text.slice(0, 1000), ch.data.rid, ch.user?.id || ""); setState(ch, null); masters.reviewed(ch.data.rid); return menu(ch, ch.L("Спасибо за отзыв! 🙏", "Şarh uçun rahmat! 🙏", "Thank you for the review! 🙏")); }
    return doSearch(ch, text);
  });
  /* returns true when the button belongs to the bot (not a seller's order button) */
  async function callback(q) {
    const data = String(q.data || ""), chat = q.message?.chat?.id, mid = q.message?.message_id;
    if (!/^(s|ms|mm|mq|wh|di|x|mr|rv|rvs|lg)(:|$)/.test(data) || !chat || q.message?.chat?.type === "channel") return false;
    const ch = chatOf(chat, q.from), [a, b, c] = data.split(":");
    if (flood("cb:" + chat)) { safe(tg.answer(q.id)); return true; }
    if (a === "x") { setState(ch, null); await tg.answer(q.id, ch.L("Отменено", "Bekor qilindi", "Cancelled")); safe(tg.editButtons(chat, mid, [])); return true; }
    if (a === "lg") {
      const lang = LI[b] != null ? b : "ru";
      db.run("UPDATE tg_chats SET lang=? WHERE chat=?", lang, ch.id); if (ch.user) db.run("UPDATE users SET lang=? WHERE id=?", lang, ch.user.id);
      await tg.answer(q.id); safe(tg.editButtons(chat, mid, []));
      const c2 = chatOf(ch.id); await menu(c2, c2.L("Язык: русский 🇷🇺", "Til: özbekça 🇺🇿", "Language: English 🇬🇧")); return true;
    }
    if (a === "s") { await tg.answer(q.id); await doSearch(ch, data.slice(2)); return true; }
    if (a === "mm") { await tg.answer(q.id); await specMenu(ch); return true; }
    if (a === "ms") { await tg.answer(q.id); if (SPEC[b]) await mastersBySpec(ch, b); return true; }
    if (a === "mq") { await tg.answer(q.id); await startRequest(ch, b); return true; }
    if (a === "wh") {
      if (ch.c.state !== "mreq_when") { await tg.answer(q.id, ch.L("Начните заново: /masters", "Qaytadan boşlang: /masters", "Start again: /masters")); return true; }
      await tg.answer(q.id); safe(tg.editButtons(chat, mid, []));
      setState(ch, "mreq_district", { ...ch.data, when: WHEN[b] ? b : "talk" });
      const ds = ref.districts.map(d => ({ text: distName(ch, d), callback_data: "di:" + d.id }));
      await tg.send(ch.id, ch.L("📍 <b>Район?</b>", "📍 <b>Qaysi tuman?</b>", "📍 <b>Which district?</b>"), [...chunk(ds, 3), [{ text: ch.L("Пропустить", "Ötkazib yuboriş", "Skip"), callback_data: "di:-" }]]);
      return true;
    }
    if (a === "di") {
      if (ch.c.state !== "mreq_district") { await tg.answer(q.id, ch.L("Начните заново: /masters", "Qaytadan boşlang: /masters", "Start again: /masters")); return true; }
      await tg.answer(q.id); safe(tg.editButtons(chat, mid, []));
      await finishRequest(ch, { ...ch.data, district: ref.districts.some(d => d.id === b) ? b : null });
      return true;
    }
    if (a === "mr") {
      const r = db.get("SELECT q.*, m.user_id muid, m.name mname, m.phone mphone FROM master_requests q JOIN masters m ON m.id=q.master_id WHERE q.id=?", Number(c));
      if (!r || !ch.user || r.muid !== ch.user.id) { await tg.answer(q.id, ch.L("Это не ваша заявка", "Bu sizning arizangiz emas", "This is not your request")); return true; }
      const target = { acc: "accepted", dec: "declined", done: "done" }[b];
      if (!(masters.REQ_MOVES.master[r.status] || []).includes(target)) { await tg.answer(q.id, ch.L("Статус уже изменён", "Holat allaqaçon özgargan", "The status has already changed")); }
      else { masters.moveRequest(r, "master", target); await tg.answer(q.id, { accepted: ch.L("Принято! Клиент получил ваш номер", "Qabul qilindi! Mijoz raqamingizni oldi", "Accepted! The customer has your number"), declined: ch.L("Отказ отправлен клиенту", "Rad javobi yuborildi", "The customer has been told you declined"), done: ch.L("Отлично! Клиент сможет поставить оценку", "Ajoyib! Mijoz endi baho qöya oladi", "Great! The customer can now rate the job") }[target]); }
      const card = masters.masterCard(db.get("SELECT * FROM master_requests WHERE id=?", r.id));
      safe(tg.edit(chat, mid, card.text, card.buttons));
      return true;
    }
    if (a === "rv") {
      const r = db.get("SELECT * FROM master_requests WHERE id=?", Number(b)), stars = Math.min(5, Math.max(1, Number(c) || 0));
      if (!r || !ch.user || r.user_id !== ch.user.id || r.status !== "done") { await tg.answer(q.id, ch.L("Оценку поставить нельзя", "Baho qöyib bölmaydi", "This job cannot be rated")); return true; }
      if (r.stars) { await tg.answer(q.id, ch.L("Вы уже оценили", "Allaqaçon baholagansiz", "You have already rated it")); return true; }
      db.run("UPDATE master_requests SET stars=? WHERE id=?", stars, r.id);
      await tg.answer(q.id, "⭐".repeat(stars)); safe(tg.editButtons(chat, mid, []));
      setState(ch, "review_text", { rid: r.id });
      await tg.send(ch.id, ch.L(`Спасибо! ${"⭐".repeat(stars)}\nНапишите пару слов о работе мастера — это поможет другим людям.`, `Rahmat! ${"⭐".repeat(stars)}\nUstaning işi haqida bir-ikki söz yozing — boşqalarga yordam beradi.`, `Thank you! ${"⭐".repeat(stars)}\nWrite a few words about the pro's work — it helps other people.`), [[{ text: ch.L("Пропустить", "Ötkazib yuboriş", "Skip"), callback_data: "rvs:" + r.id }]]);
      return true;
    }
    if (a === "rvs") {
      const mr = db.get("SELECT user_id FROM master_requests WHERE id=?", Number(b));
      if (!mr || !ch.user || mr.user_id !== ch.user.id) { await tg.answer(q.id); return true; }
      setState(ch, null); await tg.answer(q.id); safe(tg.editButtons(chat, mid, [])); masters.reviewed(Number(b)); await menu(ch, ch.L("Спасибо! 🙏", "Rahmat! 🙏", "Thank you! 🙏")); return true;
    }
    return false;
  }
  return { callback };
}
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
