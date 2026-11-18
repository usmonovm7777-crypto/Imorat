"""Build the standalone website (index.html, app.js, en.js, sw.js) from src/page.html.

src/page.html is the page body as authored for the Claude artifact: it starts with <title>, meta and
font links, then <style>, markup and <script>. This script moves the head tags into a real <head>
and wraps everything in a complete HTML document, so the site runs on any static host
(GitHub Pages, Netlify, nginx).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "src" / "page.html").read_text(encoding="utf-8")
cut = src.index("<style>")
head_tags, body = src[:cut], src[cut:]
# The page's scripts must parse: a syntax error would ship a blank site. `node --check` runs on each inline <script>.
import subprocess, tempfile, os, sys
for _js in re.findall(r"<script>([\s\S]*?)</script>", body):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as _f: _f.write(_js); _tmp = _f.name
    try:
        _chk = subprocess.run(["node", "--check", _tmp], capture_output=True, text=True)
        if _chk.returncode: sys.exit("build aborted: the page script has a syntax error\n" + _chk.stderr.strip()[-600:])
    finally: os.unlink(_tmp)
RESET = (":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
         "body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}"
         "img{max-width:100%}[hidden]{display:none!important}")
meta = ('<meta name="description" content="Quriliş Go — маркетплейс строительных магазинов Ташкента: '
        'сравнение цен, Usta AI, калькуляторы ремонта и доставка Яндекс.">')
# Smaller page for phones: CSS without comments and indentation
def _css_min(m):
    css = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)
    css = re.sub(r"\s*\n\s*", "\n", css).strip()
    return "<style>" + css + "</style>"
body = re.sub(r"<style>(.*?)</style>", _css_min, body, count=1, flags=re.S)
_css_note = ""
def _css_esbuild(m):  # a few KB more with esbuild's CSS minifier; kept only if the result still has every rule's braces balanced
    global _css_note
    if os.environ.get("MINIFY", "1") == "0": return m.group(0)
    code = ("const e=require('esbuild');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>{"
            "const r=e.transformSync(s,{loader:'css',minify:true,charset:'utf8',legalComments:'none'});process.stdout.write(r.code.trim())})")
    np = os.pathsep.join(d for d in [os.environ.get("ESBUILD_NODE_PATH", ""), os.environ.get("NODE_PATH", ""), str(ROOT / "node_modules"), str(ROOT / "tools" / "node_modules"), str(ROOT / "app" / "node_modules"), "/opt/npm-tools/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"] if d)
    r = subprocess.run(["node", "-e", code], input=m.group(1), capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": np})
    out = r.stdout
    if r.returncode or not out or out.count("{") != out.count("}") or "</style" in out.lower(): return m.group(0)
    _css_note = f" styles −{(len(m.group(1).encode('utf-8')) - len(out.encode('utf-8'))) // 1024} KB;"
    return "<style>" + out + "</style>"
body = re.sub(r"<style>(.*?)</style>", _css_esbuild, body, count=1, flags=re.S)
# The app wrapper checks the server against the API contract this page was built for; it reads the number from a tag in the
# head, because after minification the constant no longer has its name in the script.
_contract = re.search(r"const API_CONTRACT = (\d+)", body)
contract_tag = f'<meta name="imorat:api-contract" content="{_contract.group(1)}">\n' if _contract else ""
# Smaller copies of the site's own photos (img/s — 200 px, img/m — 400 px): the page offers them through srcset, and a phone takes
# a 1.5 KB tile instead of an 8 KB one. A copy is (re)made when its photo is new or has changed (tools/thumbs.json remembers the
# photo's hash); that needs Pillow. Without Pillow the existing copies are used; if some are missing the page keeps full photos.
import hashlib, json
def _thumbs():
    img, memo_f = ROOT / "img", ROOT / "tools" / "thumbs.json"
    memo = json.loads(memo_f.read_text(encoding="utf-8")) if memo_f.exists() else {}
    try: from PIL import Image
    except Exception: Image = None
    made, complete, seen = 0, True, {}
    for f in sorted(img.glob("*.webp")):
        h = hashlib.sha1(f.read_bytes()).hexdigest()[:16]; seen[f.name] = h
        outs = [(img / sub / f.name, w) for sub, w in (("s", 200), ("m", 400))]
        if memo.get(f.name) == h and all(o.exists() for o, _ in outs): continue
        if not Image: complete = False; seen[f.name] = memo.get(f.name, ""); continue
        im = Image.open(f); im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        for o, w in outs:
            o.parent.mkdir(exist_ok=True); t = im.copy(); t.thumbnail((w, w), Image.LANCZOS); t.save(o, "WEBP", quality=78, method=6); made += 1
    for sub in ("s", "m"):  # a copy whose photo is gone
        for o in (img / sub).glob("*.webp"):
            if o.name not in seen: o.unlink()
    if Image: memo_f.write_text(json.dumps(seen, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    return complete, made
_thumbs_ok, _thumbs_made = _thumbs()

# The page script leaves the HTML and becomes app.js; the English dictionary becomes en.js. The HTML that arrives first is
# then ~50 KB (styles, the start screen, empty containers) instead of ~460 KB: the start screen is painted while the script is
# still on its way, and browsers and test tools that count "first paint" from the end of the HTML see it early too. Both files
# are requested with ?v=<hash of the content>, so a new build is never mixed with an old cached script and the files may be
# cached for a year (server/Caddyfile).
_scripts = re.findall(r"<script>([\s\S]*?)</script>", body)
main_js = max(_scripts, key=len)
_en = re.findall(r"^const EN = (\{.*\});$", main_js, flags=re.M)
if len(_en) != 1 or main_js.count('const EN_FILE = "";') != 1 or main_js.count('const UZ_FILE = "";') != 1 or main_js.count("const THUMBS = false;") != 1:
    sys.exit("build aborted: the page script must have one `const EN = {…};` line, one `const EN_FILE = \"\";`, one `const UZ_FILE = \"\";` and one `const THUMBS = false;`")
_ver = lambda text: hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
_NODE_PATH = os.pathsep.join(d for d in [os.environ.get("ESBUILD_NODE_PATH", ""), os.environ.get("NODE_PATH", ""), str(ROOT / "node_modules"), str(ROOT / "tools" / "node_modules"),
                                          str(ROOT / "app" / "node_modules"), "/opt/npm-tools/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"] if d)
app_js = (main_js.replace("const EN = " + _en[0] + ";", "const EN = window.IMORAT_EN || {};")
          .replace("const THUMBS = false;", "const THUMBS = %s;" % ("true" if _thumbs_ok else "false")))
# The page script carries Russian only: the Uzbek and English texts written inline — L("ru", "uz", "en") — go to tables in
# uz.js and en.js (tools/l10n_split.js; needs acorn — `npm i acorn` next to esbuild). A Russian reader downloads neither
# (about 58 KB less, gzipped); the page takes a language's file with it when that language is saved, or on a switch.
# Without acorn the texts stay inline and the site works the same.
en_js = "window.IMORAT_EN=" + _en[0] + ";\n"
_sp = subprocess.run(["node", str(ROOT / "tools" / "l10n_split.js")], input=app_js, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": _NODE_PATH})
UZ_URL, _l10n = "", "texts of all languages inline (acorn is not installed)"
if _sp.returncode == 0 and _sp.stdout:
    _t = json.loads(_sp.stdout); app_js = _t["code"]
    uz_js = "window.IMORAT_UZ=" + json.dumps(_t["uz"], ensure_ascii=False, separators=(",", ":")) + ";\n"
    en_js += "window.IMORAT_ENT=" + json.dumps(_t["en"], ensure_ascii=False, separators=(",", ":")) + ";\n"
    (ROOT / "uz.js").write_text(uz_js, encoding="utf-8"); UZ_URL = "uz.js?v=" + _ver(uz_js)
    _l10n = f"{_t['calls']} inline texts moved to uz.js / en.js"
elif _sp.returncode != 3:
    sys.exit("build aborted: tools/l10n_split.js failed: " + (_sp.stderr.strip().splitlines() or ["?"])[-1][:200])
EN_URL = "en.js?v=" + _ver(en_js)
app_js = app_js.replace('const EN_FILE = "";', f'const EN_FILE = "{EN_URL}";').replace('const UZ_FILE = "";', f'const UZ_FILE = "{UZ_URL}";')
# The scripts are minified with esbuild when it is installed (about 60 KB less to download over a phone network).
# Without esbuild they stay as written and the site works the same — only bigger. MINIFY=0 keeps them readable.
# Where to get it: `npm i esbuild` in tools/ or in the repository root, or set ESBUILD_NODE_PATH to a node_modules that has it.
_MIN_JS = ("const e=require('esbuild');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>{"
           "const r=e.transformSync(s,{minify:true,target:'es2020',charset:'utf8',legalComments:'none'});process.stdout.write(r.code.trim())})")
_min_state = {"on": os.environ.get("MINIFY", "1") != "0", "saved": 0, "why": "MINIFY=0"}
def _minify(js, inline=False):
    if not _min_state["on"]: return js
    r = subprocess.run(["node", "-e", _MIN_JS], input=js, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": _NODE_PATH})
    out = r.stdout
    if r.returncode or not out.strip() or (inline and "</script" in out.lower()):
        _min_state["on"] = False; _min_state["why"] = "esbuild not found" if "Cannot find module" in r.stderr else (r.stderr.strip().splitlines() or ["minifier failed"])[-1][:160]
        return js
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f: f.write(out); tmp = f.name
    try:
        if subprocess.run(["node", "--check", tmp], capture_output=True).returncode: sys.exit("build aborted: the minified script does not parse")
    finally: os.unlink(tmp)
    _min_state["saved"] += len(js.encode("utf-8")) - len(out.encode("utf-8"))
    return out
app_js = _minify(app_js).rstrip() + "\n"
APP_URL = "app.js?v=" + _ver(app_js)
(ROOT / "app.js").write_text(app_js, encoding="utf-8")
(ROOT / "en.js").write_text(en_js, encoding="utf-8")
if not UZ_URL and (ROOT / "uz.js").exists(): (ROOT / "uz.js").unlink()  # a table left from a build that had acorn
# In the page: config.js (the public settings) runs first, then this loader adds the dictionary (only when the saved language is
# English — the page's first script has put it on <html lang>) and the page script. Scripts added this way run in order and do
# not hold the parser or the first paint; the head preloads the page script, so it is requested from the first bytes of the page.
# With the launch animation on the screen the loader first lets the browser paint it and only then starts the page script
# (the download is already running): starting a megabyte of script must not be what the first frame waits for. On a repeat
# visit (no animation), in a background tab and in automated browsers it starts at once.
LOADER = ('(function(){var d=document,e=d.documentElement,f={en:"%s",uz:"%s"}[e.lang],l=f?[f,"%s"]:["%s"],n=0;'
          'function go(){if(n++)return;for(var i=0;i<l.length;i++){var s=d.createElement("script");s.src=l[i];s.async=false;d.body.appendChild(s)}}'
          'if(!/\\bintro-on\\b/.test(e.className)||navigator.webdriver||d.visibilityState!=="visible"||!window.PerformanceObserver)return go();'
          'try{new PerformanceObserver(function(a,o){if(a.getEntriesByName("first-contentful-paint").length){o.disconnect();go()}}).observe({type:"paint",buffered:true})}catch(x){return go()}'
          'setTimeout(go,300)})();' % (EN_URL, UZ_URL, APP_URL, APP_URL))
_at = body.index("<script>" + main_js + "</script>")
body = body[:_at] + '<script src="config.js"></script>\n<script>' + LOADER + "</script>" + body[_at + len("<script>" + main_js + "</script>"):]
body = re.sub(r"<script>([\s\S]*?)</script>", lambda m: m.group(0) if m.group(1) == LOADER else "<script>" + _minify(m.group(1), inline=True) + "</script>", body)
# Web fonts must not hold the first paint: the head only preloads their stylesheet, the page's first script attaches it
# (CSP forbids an inline onload handler); without scripts the <noscript> copy applies.
def _fonts(m): return f'<link rel="preload" as="style" href="{m.group(1)}">\n<noscript><link rel="stylesheet" href="{m.group(1)}"></noscript>'
head_tags, _nf = re.subn(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)">', _fonts, head_tags)
if _nf != 1: sys.exit("build aborted: expected one Google Fonts stylesheet link in the page head, found %d" % _nf)
# Content-Security-Policy: only the page's own inline scripts (by their hash), its own files and the few services it loads code from
# may run. A script smuggled into a store name or a review (<img onerror=…>) does not execute — the app has no inline handlers.
# 'unsafe-eval' is required by Yandex Maps; localhost is allowed for connections so the test builds can reach a local API.
import base64, hashlib
_hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(js.encode("utf-8")).digest()).decode() + "'" for js in re.findall(r"<script>([\s\S]*?)</script>", body))
CSP = ("default-src 'self'; "
       f"script-src 'self' {_hashes} 'unsafe-eval' https://api-maps.yandex.ru https://*.api-maps.yandex.ru https://yandex.ru https://*.yandex.ru https://*.yandex.net https://yastatic.net https://accounts.google.com https://appleid.cdn-apple.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com https://*.yandex.ru https://yastatic.net; "
       "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*; media-src 'self' data: blob: https:; "
       "connect-src 'self' data: blob: https: wss: http://127.0.0.1:* http://localhost:*; frame-src https:; worker-src 'self' blob: https://*.api-maps.yandex.ru https://yastatic.net; manifest-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'self' https:")
html = ("<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
        f"<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">\n"
        f"{meta}\n{contract_tag}<style>{RESET}</style>\n<link rel=\"preload\" as=\"script\" href=\"config.js\">\n<link rel=\"preload\" as=\"script\" href=\"{APP_URL}\">\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#FFFFFF\">\n<link rel=\"icon\" type=\"image/png\" href=\"icons/favicon-64.png\">\n<link rel=\"icon\" href=\"favicon.ico\" sizes=\"any\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:site_name\" content=\"Quriliş Go\">\n<meta property=\"og:title\" content=\"Quriliş Go — стройматериалы из магазинов Ташкента с доставкой\">\n<meta property=\"og:description\" content=\"Сравнение цен 9 магазинов, Usta AI считает материалы, 3D-дизайнер комнаты, мастера и доставка Яндекс.\">\n<meta property=\"og:image\" content=\"https://usmonovm7777-crypto.github.io/Imorat/icons/og-image.png\">\n<meta property=\"og:image:width\" content=\"1200\">\n<meta property=\"og:image:height\" content=\"630\">\n<meta name=\"twitter:card\" content=\"summary_large_image\">\n<link rel=\"apple-touch-icon\" href=\"icons/apple-touch-icon.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Quriliş Go\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n{head_tags.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n")
(ROOT / "index.html").write_text(html, encoding="utf-8")
import time
sw = (ROOT / "tools" / "sw.template.js").read_text(encoding="utf-8").replace("__BUILD__", time.strftime("%Y%m%d%H%M%S")).replace("__APP__", APP_URL)
(ROOT / "sw.js").write_text(sw, encoding="utf-8")
print("built index.html", len(html), "bytes, app.js", len(app_js.encode("utf-8")), "bytes, en.js + sw.js;",
      f"scripts minified (−{_min_state['saved'] // 1024} KB);{_css_note}" if _min_state["on"] and _min_state["saved"] else f"scripts as written ({_min_state['why']});", _l10n + ";",
      f"photo copies: {_thumbs_made} made" if _thumbs_ok else "photo copies incomplete (Pillow is not installed) — the page uses full photos")
import sys; sys.path.insert(0, str(ROOT / "tools")); import build_seo; build_seo.build()
