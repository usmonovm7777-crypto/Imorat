/* Smart product search for the Telegram bot — the same rules as the website search:
   Cyrillic and Uzbek Latin written one way (цемент = sement), endings cut, everyday synonyms
   (кран → смеситель, кафель → плитка), small typos forgiven (семент, перфаратор). */
const SK = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "s", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ў: "o", қ: "k", ғ: "g", ҳ: "h" };
export function skel(t) {
  let s = String(t || "").toLowerCase().replace(/[‘ʻ'`’ʼ]/g, "").replace(/ö/g, "o").replace(/ğ/g, "g").replace(/ş/g, "sh").replace(/ç/g, "ch");
  s = s.replace(/(\d)\s*[×xх*]\s*(?=\d)/g, "$1×").replace(/(\d),(?=\d)/g, "$1.");
  s = s.replace(/[а-яёўқғҳ]/g, c => SK[c] ?? c);
  return s.replace(/ts/g, "s").replace(/c(?!h)/g, "s").replace(/q/g, "k").replace(/x/g, "h").replace(/w/g, "v").replace(/yo/g, "e");
}
const END = ["iyami", "yami", "ami", "ogo", "ego", "omu", "emu", "imi", "iyah", "yah", "ah", "aya", "yaya", "iya", "oe", "ee", "ie", "ye", "iy", "yy", "oy", "uyu", "yuyu", "om", "em", "am", "yam", "ov", "ev", "ey", "ya", "yu", "a", "e", "i", "o", "u", "y"];
export function stem(w) {
  if (/\d/.test(w)) return w;
  w = w.replace(/^(.{3,}[aeiou])gi$/, "$1k");
  const m = w.match(/^(.{4,}?)(larining|larini|larni|larga|larda|lardan|lari|lar|ning|dan|ga|da|ni)$/); if (m) w = m[1];
  for (const e of END) if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
  return w;
}
export const tokens = t => skel(t).split(/[^a-z0-9×.]+/).map(x => x.replace(/^\.+|\.+$/g, "")).filter(Boolean);
const STOP = new Set(["dlya", "i", "v", "vo", "na", "s", "so", "pod", "po", "iz", "ot", "do", "k", "ko", "mne", "nujen", "nujna", "nujno", "nujni", "kupit", "hochu", "kakoy", "kakaya", "kakie", "gde", "est", "li", "ili", "va", "uchun", "kerak", "menga", "bilan", "sotib", "olish", "olmokchiman", "kerakli", "shtuk", "sht", "dona"]);
const SYN = [
  "кран смеситель aralashtirgich jomrak", "кафель плитка kafel plitka", "шпатлевка шпаклевка shpaklyovka shpatlyovka", "гкл гипсокартон гипрок gipsokarton",
  "минвата утеплитель вата базальт izolyatsiya issiklik", "провод кабель sim kabel", "лампочка лампа lampa", "люстра qandil kandil", "светильник фонарь chiroq",
  "болгарка ушм шлифмашина bolgarka", "шуруповерт шуруповёрт shurupovert", "дрель перфоратор drel", "саморез шуруп винт shurup samorez", "гвоздь mih",
  "батарея радиатор batareya radiator", "кондей кондиционер konditsioner kondisioner", "котел котёл kotel kozon", "бойлер водонагреватель колонка boyler suvisitgich isitgich",
  "унитаз туалет толчок unitaz hojathona", "раковина умывальник rakovina", "мойка moyka", "ванна vanna vannahona", "душ душевая dush", "труба quvur truba kuvur",
  "краска эмаль kraska boyok", "грунт грунтовка gruntovka", "клей yelim kley", "пена ko'pik kopik pena", "герметик силикон germetik", "обои gulkogoz gulqogoz oboi",
  "ламинат laminat", "линолеум linoleum", "паркет parket", "дверь eshik dver", "окно deraza okno стеклопакет", "замок qulf kulf zamok", "розетка rozetka",
  "выключатель ochirgich vyklyuchatel", "автомат автоматический avtomat", "удлинитель переноска uzaytirgich", "цемент sement", "кирпич gisht kirpich",
  "газоблок пеноблок блок gazoblok", "арматура armatura", "профнастил профлист", "черепица металлочерепица cherepitsa", "брус доска taxta tahta yogoch",
  "осп osb", "лестница стремянка narvon", "перчатки qolqop kolkop", "каска шлем kaska", "лопата belkurak", "шланг shlang", "мангал гриль mangal",
  "камера видеонаблюдение kamera", "штукатурка suvok shtukaturka", "стяжка наливной", "затирка fuga zatirka", "уровень нивелир daraja", "молоток bolga molotok",
  "отвертка отвёртка otvertka", "кухня oshhona kuhnya", "шкаф shkaf", "полка tokcha", "кровать karavot", "диван divan", "стол stol", "стул stul",
  "ковер ковёр gilam", "шторы занавески parda", "вытяжка tortgich", "столешница stoleshnitsa", "сетка setka", "профиль profil", "уголок ugolok"
].map(g => [...new Set(tokens(g).map(stem))]);
const SYNOF = new Map(); SYN.forEach(g => g.forEach(w => SYNOF.set(w, g)));
function dl(a, b, lim) {
  if (Math.abs(a.length - b.length) > lim) return lim + 1;
  const d = []; for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) { let row = 1e9; for (let j = 1; j <= b.length; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1); d[i][j] = v; row = Math.min(row, v); } if (row > lim) return lim + 1; }
  return d[a.length][b.length];
}
function index(p, cats) {
  const words = (txt, w) => String(txt || "").replace(/(\d),(?=\d)/g, "$1.").split(/[\s,;:()«»"/+–—-]+/).filter(Boolean).flatMap(o => tokens(o).map(t => ({ s: stem(t), t, o: o.replace(/[.,]+$/, ""), w })));
  const c = cats.find(x => x.id === p.cat) || {}, sub = c.subs?.find(s => s[0] === p.sub);
  return { w: [...words(p.ru, 1), ...words(p.uz, 1), ...words(c.ru, .55), ...words(c.uz, .55), ...words(sub?.[1], .7), ...words(sub?.[2], .7)], full: skel(`${p.ru} ${p.uz}`) };
}
function tok(q, idx) {
  const syn = SYNOF.get(q) || (q.length >= 4 ? SYN.find(g => g.some(w => w.length >= 4 && (w.startsWith(q) || q.startsWith(w)))) : null);
  const lim = syn ? 0 : q.length >= 8 ? 2 : q.length >= 5 ? 1 : 0, num = /\d/.test(q);
  let best = 0, fix = null;
  for (const h of idx.w) {
    let s = 0, f = null;
    if (num) { if (h.t === q || h.s === q) s = 3; else if (h.t.length > q.length && (h.t.startsWith(q) || h.t.endsWith(q))) s = 1.8; }
    else if (h.s === q) s = 3;
    else if (q.length >= 2 && h.s.startsWith(q)) s = 2.5;
    else if (h.s.length >= 4 && q.startsWith(h.s)) s = 2;
    else if (syn && syn.some(w => h.s === w || (w.length >= 3 && h.s.startsWith(w)))) s = 2.8;
    else if (lim && h.s.length >= 3 && Math.min(dl(q, h.s, lim), h.s.length > q.length ? dl(q, h.s.slice(0, q.length), lim) : 9) <= lim) { s = 1.2; f = h.o; }
    s *= h.w;
    if (s > best) { best = s; fix = f; }
  }
  return [best, fix];
}
/* products: [{id, ru, uz, cat, sub, hit, rating, reviews}] → [{p, score}] best first, plus a "did you mean" hint */
export function createSearch(cats) {
  const cache = new Map();
  const idx = p => { let x = cache.get(p.id); if (!x || x.ru !== p.ru) { x = { ru: p.ru, i: index(p, cats) }; cache.set(p.id, x); } return x.i; };
  return function search(q, products, limit = 8) {
    const toks = [...new Set(tokens(q).filter(t => !STOP.has(t)).map(stem))], phrase = skel(q).trim();
    if (!toks.length) return { list: [], loose: false, fix: "" };
    const rows = [];
    for (const p of products) {
      const ix = idx(p); let sum = 0, hit = 0; const fx = [];
      toks.forEach((t, i) => { const [s, f] = tok(t, ix); if (s > 0) { sum += i ? s : s * 1.25; hit++; if (f) fx.push([t, f]); } });
      if (!hit) continue;
      if (phrase.length > 3 && ix.full.includes(phrase)) sum += 2;
      rows.push({ p, sum: sum + hit * 2, hit, fx });
    }
    let ok = rows.filter(r => r.hit === toks.length), loose = false;
    if (!ok.length && toks.length > 1) { const need = Math.ceil(toks.length / 2); ok = rows.filter(r => r.hit >= need); loose = ok.length > 0; }
    const pop = p => (p.hit ? 1000 : 0) + (p.rating || 0) * (p.reviews || 0);
    ok.sort((a, b) => b.sum - a.sum || pop(b.p) - pop(a.p));
    let fix = "";
    if (ok.length && ok.every(r => r.fx.length)) { const m = new Map(ok[0].fx); fix = q.split(/\s+/).map(w => { const f = m.get(stem(tokens(w)[0] || "")); return f ? f.toLowerCase() : w; }).join(" "); if (fix === q) fix = ""; }
    return { list: ok.slice(0, limit).map(r => ({ p: r.p, score: r.sum })), total: ok.length, loose, fix };
  };
}
