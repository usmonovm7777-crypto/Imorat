"""Search-engine pages: one static HTML page per product and per category, in Russian and Uzbek,
plus sitemap.xml and robots.txt. Google and Yandex read these pages directly (the main site is a
single page that search engines index poorly). Each page links into the live site.

Data: server/data/catalog.json (the catalog the server is seeded with).
Site address: env SITE_URL, default the GitHub Pages address.
"""
import html, json, os, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = os.environ.get("SITE_URL", "https://usmonovm7777-crypto.github.io/Imorat/").rstrip("/") + "/"
cat = json.loads((ROOT / "server" / "data" / "catalog.json").read_text(encoding="utf-8"))
STORES = {s["id"]: s for s in cat["stores"]}
CATS = {c["id"]: c for c in cat["cats"]}
UNITS, DESC, DIST = cat["units"], cat["desc"], {d["id"]: d for d in cat["districts"]}
PRODUCTS = [p for p in cat["products"] if p.get("offers")]

def uz_new(t):
    t = re.sub(r"O[‘ʻ'`]", "Ö", t); t = re.sub(r"o[‘ʻ'`]", "ö", t); t = re.sub(r"G[‘ʻ'`]", "Ğ", t); t = re.sub(r"g[‘ʻ'`]", "ğ", t)
    for a, b in (("SH", "Ş"), ("Sh", "Ş"), ("sh", "ş"), ("CH", "Ç"), ("Ch", "Ç"), ("ch", "ç")):
        t = t.replace(a, b)
    return t

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))
def slug(t):
    t = "".join(TR.get(ch, ch) for ch in t.lower())
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:60] or "item"

def fmt(n): return f"{round(n):,}".replace(",", " ")
E = lambda s: html.escape(str(s), quote=True)
T = {
    "ru": dict(buy="Купить на Imorat", from_="от", sum="сум", city="в Ташкенте", stores="Цены в магазинах", store="Магазин", price="Цена", stock="Наличие",
               yes="в наличии", no="под заказ", delivery="Доставка Яндекс по Ташкенту: курьер до 15 кг, грузовое такси для тяжёлых заказов. Самовывоз из магазина бесплатно.",
               unit="Единица", kg="Вес", country="Страна", similar="Похожие товары", home="Главная", catalog="Каталог", all_in="Все товары", items="товаров",
               site="Imorat — маркетплейс строительных магазинов Ташкента", open="Открыть каталог", buy_title="купить", lang_other="Özbekça",
               desc_tail="Сравните цены {n} магазинов, закажите с доставкой Яндекс по Ташкенту."),
    "uz": dict(buy="Imoratda sotib olish", from_="dan", sum="so‘m", city="Toshkentda", stores="Do‘konlardagi narxlar", store="Do‘kon", price="Narx", stock="Mavjudligi",
               yes="bor", no="buyurtma asosida", delivery="Toshkent bo‘ylab Yandex yetkazib berish: 15 kg gacha kuryer, og‘ir buyurtmalar uchun yuk taksi. Do‘kondan olib ketish bepul.",
               unit="O‘lchov", kg="Vazni", country="Mamlakat", similar="O‘xshash mahsulotlar", home="Asosiy", catalog="Katalog", all_in="Barcha mahsulotlar", items="ta mahsulot",
               site="Imorat — Toshkent qurilish do‘konlari marketpleysi", open="Katalogni ochish", buy_title="sotib olish", lang_other="Русский",
               desc_tail="{n} ta do‘kon narxlarini solishtiring, Toshkent bo‘ylab Yandex yetkazib berish bilan buyurtma qiling."),
}
def tr(lang, key): v = T[lang][key]; return uz_new(v) if lang == "uz" else v
def name(p, lang): return uz_new(p["uz"]) if lang == "uz" else p["ru"]
def cname(c, lang): return uz_new(c["uz"]) if lang == "uz" else c["ru"]
def prefix(lang): return "uz/" if lang == "uz" else ""
def purl(p, lang): return f"{prefix(lang)}p/{p['id']}-{slug(p['ru'])}.html"
def curl(c, lang): return f"{prefix(lang)}c/{c['id']}.html"
def app_link(lang, h, depth): return "../" * depth + f"index.html?lang={lang}#{h}"
def min_price(p): return min(o["price"] for o in p["offers"])
def from_price(lang, v): return f"от {fmt(v)} сум" if lang == "ru" else f"{fmt(v)} so‘mdan"

CSS = """:root{--bg:#F6F7F5;--sf:#fff;--ink:#131B1A;--mu:#5d6b67;--ln:#E0E5DF;--ac:#0B6E69;--ai:#fff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0E1312;--sf:#171E1D;--ink:#E9EEEC;--mu:#9CA7A3;--ln:#28312F;--ac:#3DB3AA;--ai:#06201E}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--ac)}header,main,footer{max-width:1040px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}.logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:20px;color:var(--ink);text-decoration:none}
.logo img{width:32px;height:32px;border-radius:8px}nav.bc{font-size:14px;color:var(--mu)}nav.bc a{color:var(--mu)}
h1{font-size:clamp(24px,4vw,34px);line-height:1.2;margin:8px 0 12px}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;align-items:start}
.ph{background:var(--sf);border:1px solid var(--ln);border-radius:18px;aspect-ratio:1;display:grid;place-items:center;overflow:hidden}.ph img{width:100%;height:100%;object-fit:contain}
.price{font-size:28px;font-weight:700}.btn{display:inline-block;background:var(--ac);color:var(--ai);padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--sf);border:1px solid var(--ln);border-radius:14px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid var(--ln);text-align:left;font-size:15px}th{color:var(--mu);font-weight:600;font-size:13px}td.r,th.r{text-align:right}
.mu{color:var(--mu)}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:0;list-style:none}.cards a{display:block;background:var(--sf);border:1px solid var(--ln);border-radius:14px;padding:10px;color:var(--ink);text-decoration:none;height:100%}
.cards img{width:100%;aspect-ratio:1;object-fit:contain}.cards b{display:block;font-size:14px;font-weight:600;margin:6px 0 2px}.cards span{color:var(--ac);font-weight:700}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:12px 0}dt{color:var(--mu)}dd{margin:0}footer{color:var(--mu);font-size:14px;border-top:1px solid var(--ln);margin-top:24px}
@media (max-width:720px){.grid{grid-template-columns:1fr}}"""

def page(lang, depth, title, desc, canon, alt, body, ld, img=None):
    up = "../" * depth
    other = "ru" if lang == "uz" else "uz"
    og = f'<meta property="og:image" content="{E(SITE + img)}">' if img else ""
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
<link rel="canonical" href="{E(SITE + canon)}">
<link rel="alternate" hreflang="{lang}" href="{E(SITE + canon)}">
<link rel="alternate" hreflang="{other}" href="{E(SITE + alt)}">
<meta property="og:type" content="website"><meta property="og:title" content="{E(title)}"><meta property="og:description" content="{E(desc)}"><meta property="og:url" content="{E(SITE + canon)}">{og}
<link rel="icon" type="image/png" href="{up}icons/favicon-64.png">
<style>{CSS}</style>
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
</head>
<body>
<header><a class="logo" href="{up}index.html?lang={lang}"><img src="{up}icons/icon-192.png" alt="">imorat</a><a href="{up}{alt}" hreflang="{other}">{tr(lang, 'lang_other')}</a></header>
<main>
{body}
</main>
<footer>{E(tr(lang, 'site'))} · <a href="{up}index.html?lang={lang}">{E(tr(lang, 'open'))}</a></footer>
</body>
</html>
"""

def product_page(p, lang, by_sub):
    depth = 2 if lang == "uz" else 1
    up = "../" * depth
    c = CATS[p["cat"]]
    sub = next((s for s in c["subs"] if s[0] == p["sub"]), None)
    nm, mp = name(p, lang), min_price(p)
    offers = sorted(p["offers"], key=lambda o: o["price"])
    unit = UNITS.get(p["unit"], UNITS["pcs"])[1 if lang == "uz" else 0]
    d = DESC.get(p["sub"])
    desc_txt = uz_new(d[1]) if (d and lang == "uz") else (d[0] if d else "")
    title = f"{nm} — купить в Ташкенте {from_price(lang, mp)} | Imorat" if lang == "ru" else f"{nm} — Toshkentda {from_price(lang, mp)} sotib olish | Imorat"
    meta = f"{nm}: {fmt(mp)} {tr(lang, 'sum')}/{unit}. " + tr(lang, "desc_tail").format(n=len(offers))
    rows = "".join(f"<tr><td>{E(STORES[o['store']]['name'])}<br><small class=mu>{E(uz_new(DIST[STORES[o['store']]['d']]['uz']) if lang == 'uz' else DIST[STORES[o['store']]['d']]['ru'])}</small></td><td class=r><b>{fmt(o['price'])}</b> {tr(lang, 'sum')}</td><td>{tr(lang, 'yes') if o.get('stock', 0) > 0 else tr(lang, 'no')}</td></tr>" for o in offers if o["store"] in STORES)
    sim = [x for x in by_sub.get(p["sub"], []) if x["id"] != p["id"]][:8]
    cards = "".join(f'<li><a href="{up}{purl(x, lang)}"><img src="{up}{E(x["img"])}" alt="" loading="lazy" width="180" height="180"><b>{E(name(x, lang))}</b><span>{from_price(lang, min_price(x))}</span></a></li>' for x in sim)
    country = p.get("country") or ["", ""]
    body = f"""<nav class="bc"><a href="{up}index.html?lang={lang}">{tr(lang, 'home')}</a> › <a href="{up}{curl(c, lang)}">{E(cname(c, lang))}</a>{' › ' + E(uz_new(sub[2]) if lang == 'uz' else sub[1]) if sub else ''}</nav>
<h1>{E(nm)}</h1>
<div class="grid"><div class="ph"><img src="{up}{E(p['img'])}" alt="{E(nm)}" width="640" height="640"></div>
<div><p class="price">{from_price(lang, mp)} <small class="mu">/ {E(unit)}</small></p>
<p><a class="btn" href="{app_link(lang, f"p-{p['id']}", depth)}">{tr(lang, 'buy')}</a></p>
<p>{E(desc_txt)}</p>
<dl><dt>{tr(lang, 'unit')}</dt><dd>{E(unit)}</dd><dt>{tr(lang, 'kg')}</dt><dd>{p['kg']} kg</dd>{f"<dt>{tr(lang, 'country')}</dt><dd>{E(uz_new(country[1]) if lang == 'uz' else country[0])}</dd>" if country[0] else ''}</dl>
<p class="mu">{tr(lang, 'delivery')}</p></div></div>
<h2>{tr(lang, 'stores')}</h2>
<table><thead><tr><th>{tr(lang, 'store')}</th><th class=r>{tr(lang, 'price')}</th><th>{tr(lang, 'stock')}</th></tr></thead><tbody>{rows}</tbody></table>
{f'<h2>{tr(lang, "similar")}</h2><ul class="cards">{cards}</ul>' if cards else ''}"""
    ld = [{"@context": "https://schema.org", "@type": "Product", "name": nm, "image": SITE + p["img"], "description": desc_txt or meta, "sku": str(p["id"]),
           "category": cname(c, lang),
           "offers": {"@type": "AggregateOffer", "priceCurrency": "UZS", "lowPrice": mp, "highPrice": max(o["price"] for o in offers), "offerCount": len(offers),
                      "availability": "https://schema.org/InStock" if any(o.get("stock", 0) > 0 for o in offers) else "https://schema.org/PreOrder"}},
          {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
              {"@type": "ListItem", "position": 1, "name": tr(lang, "home"), "item": SITE + ("index.html?lang=uz" if lang == "uz" else "")},
              {"@type": "ListItem", "position": 2, "name": cname(c, lang), "item": SITE + curl(c, lang)},
              {"@type": "ListItem", "position": 3, "name": nm, "item": SITE + purl(p, lang)}]}]
    other = "ru" if lang == "uz" else "uz"
    return page(lang, depth, title, meta, purl(p, lang), purl(p, other), body, ld, p["img"])

def cat_page(c, lang, items):
    depth = 2 if lang == "uz" else 1
    up = "../" * depth
    cn = cname(c, lang)
    groups = ""
    for s in c["subs"]:
        xs = [p for p in items if p["sub"] == s[0]]
        if not xs: continue
        groups += f"<h2>{E(uz_new(s[2]) if lang == 'uz' else s[1])}</h2><ul class=cards>" + "".join(
            f'<li><a href="{up}{purl(x, lang)}"><img src="{up}{E(x["img"])}" alt="" loading="lazy" width="180" height="180"><b>{E(name(x, lang))}</b><span>{from_price(lang, min_price(x))}</span></a></li>' for x in xs) + "</ul>"
    title = f"{cn} {tr(lang, 'city')} — {len(items)} {tr(lang, 'items')} | Imorat"
    meta = f"{cn}: " + ", ".join(name(x, lang) for x in items[:6]) + ". " + tr(lang, "desc_tail").format(n=len({o['store'] for x in items for o in x['offers']}))
    body = f"""<nav class="bc"><a href="{up}index.html?lang={lang}">{tr(lang, 'home')}</a> › {E(cn)}</nav>
<h1>{E(cn)} {tr(lang, 'city')}</h1><p><a class="btn" href="{app_link(lang, 'cat-' + c['id'], depth)}">{tr(lang, 'open')}</a></p>{groups}"""
    ld = {"@context": "https://schema.org", "@type": "ItemList", "name": cn, "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": SITE + purl(x, lang)} for i, x in enumerate(items[:100])]}
    other = "ru" if lang == "uz" else "uz"
    return page(lang, depth, title, meta, curl(c, lang), curl(c, other), body, ld)

def build():
    for d in ("p", "c", "uz"):
        shutil.rmtree(ROOT / d, ignore_errors=True)
    by_sub = {}
    for p in PRODUCTS: by_sub.setdefault(p["sub"], []).append(p)
    urls = [(SITE, SITE + "index.html?lang=uz")]
    n = 0
    for lang in ("ru", "uz"):
        for p in PRODUCTS:
            f = ROOT / purl(p, lang); f.parent.mkdir(parents=True, exist_ok=True); f.write_text(product_page(p, lang, by_sub), encoding="utf-8"); n += 1
        for c in cat["cats"]:
            items = [p for p in PRODUCTS if p["cat"] == c["id"]]
            if not items: continue
            f = ROOT / curl(c, lang); f.parent.mkdir(parents=True, exist_ok=True); f.write_text(cat_page(c, lang, items), encoding="utf-8"); n += 1
    pairs = [(purl(p, "ru"), purl(p, "uz")) for p in PRODUCTS] + [(curl(c, "ru"), curl(c, "uz")) for c in cat["cats"] if any(p["cat"] == c["id"] for p in PRODUCTS)]
    def entry(loc, ru, uz):
        return (f"<url><loc>{E(loc)}</loc><xhtml:link rel=\"alternate\" hreflang=\"ru\" href=\"{E(ru)}\"/>"
                f"<xhtml:link rel=\"alternate\" hreflang=\"uz\" href=\"{E(uz)}\"/></url>")
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
           entry(SITE, SITE, SITE + "index.html?lang=uz")]
    for ru, uz in pairs:
        xml += [entry(SITE + ru, SITE + ru, SITE + uz), entry(SITE + uz, SITE + ru, SITE + uz)]
    xml.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(xml), encoding="utf-8")
    (ROOT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nDisallow: /server/\nDisallow: /app/\nSitemap: {SITE}sitemap.xml\n", encoding="utf-8")
    print(f"seo: {n} pages, sitemap with {len(pairs) * 2 + 1} urls")

if __name__ == "__main__":
    build()
