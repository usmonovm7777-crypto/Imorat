"""Build the standalone website (index.html, app.js, en.js, sw.js) from src/page.html.

src/page.html is the page body as authored for the Claude artifact: it starts with <title>, meta and
font links, then <style>, markup and <script>. This script moves the head tags into a real <head>
and wraps everything in a complete HTML document, so the site runs on any static host
(GitHub Pages, Netlify, nginx).
"""
import re, json
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
# The typefaces are the site's own files (tools/build_fonts.py made them and tools/fonts.json describes them). The styles get
# stand-in faces — a system font scaled to the web font's width — right after each web font in the font stacks, so the text
# keeps its line breaks when the web font arrives.
FONTS = json.loads((ROOT / "tools" / "fonts.json").read_text(encoding="utf-8")) if (ROOT / "tools" / "fonts.json").exists() else None
if FONTS:
    _n1 = body.count('"Unbounded", "Arial Black",'); _n2 = body.count('"Golos Text", system-ui,')
    if _n1 != 1 or _n2 != 1: sys.exit("build aborted: the font stacks in the page's styles are not the ones this script knows")
    body = body.replace('"Unbounded", "Arial Black",', '"Unbounded", "Unbounded Fallback", "Unbounded Fallback R",').replace('"Golos Text", system-ui,', '"Golos Text", "Golos Text Fallback", "Golos Text Fallback R", system-ui,')
    body = body.replace("<style>", "<style>" + FONTS["fallbacks"] + "\n", 1)
body = re.sub(r"<style>(.*?)</style>", _css_min, body, count=1, flags=re.S)
# A rule that lost its selector or a brace does not break the page loudly — the browser just drops styles from there on. Such a
# page is not built.
_cssx = re.sub(r'"[^"\n]*"|\'[^\'\n]*\'', '""', re.search(r"<style>(.*?)</style>", body, flags=re.S).group(1))
if _cssx.count("{") != _cssx.count("}") or "${" in _cssx: sys.exit(f"build aborted: the page's styles are damaged (braces {_cssx.count('{')} / {_cssx.count('}')}" + (", script text inside the styles" if "${" in _cssx else "") + ")")
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
# The page script goes out minified together with its source map (app.js.map): whoever opens the browser's developer tools —
# we, looking at a visitor's error report — sees readable lines instead of one endless one. The map is fetched only by those
# tools, never by an ordinary visit. (The script's source is this repository's src/page.html anyway.)
_MAP_JS = ("const e=require('esbuild');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>{"
           "const r=e.transformSync(s,{minify:true,target:'es2020',charset:'utf8',legalComments:'none',sourcemap:'external',sourcefile:'app.src.js',sourcesContent:true});"
           "process.stdout.write(JSON.stringify({map:r.map}))})")
_app_src = app_js
app_js = _minify(app_js).rstrip() + "\n"
_map_note = ""
if _min_state["on"] and app_js.rstrip() != _app_src.rstrip():
    _mr = subprocess.run(["node", "-e", _MAP_JS], input=_app_src, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": _NODE_PATH})
    try: _map = json.loads(_mr.stdout)["map"] if not _mr.returncode else ""
    except (ValueError, KeyError): _map = ""
    if _map:
        (ROOT / "app.js.map").write_text(_map, encoding="utf-8"); app_js = app_js.rstrip() + "\n//# sourceMappingURL=app.js.map\n"; _map_note = " with its source map;"
if not _map_note and (ROOT / "app.js.map").exists(): (ROOT / "app.js.map").unlink()
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
# When the page carries the ready first screen and shows it (window.__pre, see below), the loader waits for that screen's
# pictures (marked data-fs by tools/prerender.js; decoded and painted — where the browser reports its largest paint, that
# report is the signal, elsewhere two frames after the decoding) before it starts the web fonts and the page script: on a slow phone network the visitor's first
# screen must not share the line with a megabyte of script. The launch animation then opens on its own clock (about a second
# on the screen) over the ready screen, without waiting for the page script; showIntro() in the page script takes it over if
# the script gets there first (window.__intro says who has it).
LOADER = ('(function(){var d=document,e=d.documentElement,w=window,f={en:"%s",uz:"%s"}[e.lang],l=f?[f,"%s"]:["%s"],n=0;'
          'if(w.__pre&&w.IMORAT_API){["hdr","app","tabbar"].forEach(function(i){d.getElementById(i).textContent=""});e.classList.remove("pre");w.__pre=false}'
          'function go(){if(n++)return;w.__fonts&&w.__fonts();for(var i=0;i<l.length;i++){var s=d.createElement("script");s.src=l[i];s.async=false;d.body.appendChild(s)}}'
          'if(w.__pre&&!navigator.webdriver&&d.visibilityState==="visible"){var m=[].slice.call(d.querySelectorAll("img[data-fs]")),k=m.length+1,q=0,el=d.getElementById("intro"),'
          'io=function(){if(w.__intro||!el||!/\\bintro-on\\b/.test(e.className))return;w.__intro=1;el.classList.add("out");'
          'setTimeout(function(){e.classList.remove("intro-on");var t=e.getAttribute("data-theme"),c=d.querySelector(\'meta[name="theme-color"]:not([media])\');if(c)c.content=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches)?"#1D1A17":"#FFFFFF";'
          'el.classList.add("open");if(!(w.CSS&&CSS.registerProperty)||!(CSS.supports&&(CSS.supports("mask-image","none")||CSS.supports("-webkit-mask-image","none"))))el.classList.add("fade")},270);'
          'setTimeout(function(){el.parentNode&&el.parentNode.removeChild(el);w.__intro=2},1150)},'
          'z=function(){if(q++)return;setTimeout(io,Math.max(0,950-(Date.now()-(w.__bootT||Date.now()))));go()},'
          'L=0,y=function(){if(--k<=0){if(L)setTimeout(z,250);else requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(z,0)})})}};'
          'try{if(w.PerformanceObserver&&(PerformanceObserver.supportedEntryTypes||[]).indexOf("largest-contentful-paint")>=0){new PerformanceObserver(function(a,o){a.getEntries().forEach(function(x){if(x.element&&x.element.hasAttribute&&x.element.hasAttribute("data-fs")){o.disconnect();setTimeout(z,0)}})}).observe({type:"largest-contentful-paint",buffered:true});L=1}}catch(x){}'
          'm.forEach(function(i){if(i.decode)i.decode().then(y,y);else if(i.complete)y();else{i.addEventListener("load",y);i.addEventListener("error",y)}});y();setTimeout(z,2500);return}'
          'if(!/\\bintro-on\\b/.test(e.className)||navigator.webdriver||d.visibilityState!=="visible"||!w.PerformanceObserver)return go();'
          'try{new PerformanceObserver(function(a,o){if(a.getEntriesByName("first-contentful-paint").length){o.disconnect();go()}}).observe({type:"paint",buffered:true})}catch(x){return go()}'
          'setTimeout(go,300)})();' % (EN_URL, UZ_URL, APP_URL, APP_URL))
# The ready first screen is shown by this script, placed right after the page's empty containers. It moves the fitting
# <template> into the header, the main area and the tab bar; if the page had chosen the still start screen, that screen steps
# aside. It does not wait for config.js (one more round trip before the first screen). The ready screen is the demo
# catalogue's, and this script builds it only when config.js names no server; should someone name a server there without
# rebuilding the site, the loader — which does run after config.js — takes the ready screen away before the page script starts.
PRE_SHOW = ('(function(){var d=document,e=d.documentElement,w=window;if(!w.__pre)return;'
            'var t=d.getElementById(matchMedia("(max-width:760px)").matches?"pre-m":"pre-d");'
            'if(!t||!t.content){w.__pre=false;w.__fonts&&w.__fonts();return}'
            '["hdr","app","tabbar"].forEach(function(id){var s=t.content.querySelector(\'[data-pre="\'+id+\'"]\'),h=d.getElementById(id);if(s&&h)while(s.firstChild)h.appendChild(s.firstChild)});'
            '(t.getAttribute("data-cls")||"").split(" ").forEach(function(c){c&&e.classList.add(c)});e.classList.add("pre");if(/\\bboot-plain\\b/.test(e.className)){e.classList.remove("boot-plain");var i=d.getElementById("intro");i&&i.parentNode.removeChild(i)}})();')
_at = body.index("<script>" + main_js + "</script>")
body = body[:_at] + '<script src="config.js"></script>\n<script>' + LOADER + "</script>" + body[_at + len("<script>" + main_js + "</script>"):]
body = re.sub(r"<script>([\s\S]*?)</script>", lambda m: m.group(0) if m.group(1) == LOADER else "<script>" + _minify(m.group(1), inline=True) + "</script>", body)
# the ready first screen (if any) goes right after the page's empty containers
_tb = re.search(r'<nav class="tabbar" id="tabbar"[^>]*></nav>\n', body)
if not _tb: sys.exit("build aborted: the tab bar container was not found in the page")
PRE_MARK = "<!--ready-first-screen-->"
body = body[:_tb.end()] + PRE_MARK + body[_tb.end():]
# Web fonts. With the site's own files: the Google Fonts links leave the head; the @font-face rules sit in a <style> that is
# switched off (media="not all") until the page's first script turns it on — at once, or, on a phone showing the ready first
# screen, after that screen's pictures. A computer also preloads the two text faces: they are on every screen there, and a
# face that is already here when the first frame is drawn never has to be swapped in.
# Without tools/fonts.json the Google stylesheet stays, preloaded so that it does not hold the first paint.
def _fonts(m): return f'<link rel="preload" as="style" href="{m.group(1)}">\n<noscript><link rel="stylesheet" href="{m.group(1)}"></noscript>'
if FONTS:
    head_tags = re.sub(r'<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com"[^>]*>\n?', "", head_tags)
    _wf = (f'<style id="wf" media="not all">{FONTS["faces"]}</style>\n<noscript><style>{FONTS["faces"]}</style></noscript>\n'
           + "".join(f'<link rel="preload" as="font" type="font/woff2" href="{FONTS["files"][k]["file"]}" crossorigin media="(min-width: 761px)">\n' for k in ("unbounded", "golos")))
    head_tags, _nf = re.subn(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com/[^"]+">\n?', lambda m: _wf, head_tags)
else:
    head_tags, _nf = re.subn(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)">', _fonts, head_tags)
if _nf != 1: sys.exit("build aborted: expected one Google Fonts stylesheet link in the page head, found %d" % _nf)
# Content-Security-Policy: only the page's own inline scripts (by their hash), its own files and the few services it loads code from
# may run. A script smuggled into a store name or a review (<img onerror=…>) does not execute — the app has no inline handlers.
# 'unsafe-eval' is required by Yandex Maps; localhost is allowed for connections so the test builds can reach a local API.
import base64, hashlib
def _page(body, app_link, head_extra=""):
  _hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(js.encode("utf-8")).digest()).decode() + "'" for js in re.findall(r"<script>([\s\S]*?)</script>", body))
  CSP = ("default-src 'self'; "
         f"script-src 'self' {_hashes} 'unsafe-eval' https://api-maps.yandex.ru https://*.api-maps.yandex.ru https://yandex.ru https://*.yandex.ru https://*.yandex.net https://yastatic.net https://accounts.google.com https://appleid.cdn-apple.com; "
         "style-src 'self' 'unsafe-inline'" + ("" if FONTS else " https://fonts.googleapis.com") + " https://accounts.google.com https://*.yandex.ru https://yastatic.net; "
         "font-src 'self' data:" + ("" if FONTS else " https://fonts.gstatic.com") + "; img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*; media-src 'self' data: blob: https:; "
         "connect-src 'self' data: blob: https: wss: http://127.0.0.1:* http://localhost:*; frame-src https:; worker-src 'self' blob: https://*.api-maps.yandex.ru https://yastatic.net; manifest-src 'self'; "
         "object-src 'none'; base-uri 'none'; form-action 'self' https:")
  html = ("<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n"
          "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
          f"<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">\n"
          f"{meta}\n{contract_tag}<style>{RESET}</style>\n<link rel=\"preload\" as=\"script\" href=\"config.js\">\n{app_link}\n{head_extra}<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#FFFFFF\">\n<link rel=\"icon\" type=\"image/png\" href=\"icons/favicon-64.png\">\n<link rel=\"icon\" href=\"favicon.ico\" sizes=\"any\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:site_name\" content=\"Quriliş Go\">\n<meta property=\"og:title\" content=\"Quriliş Go — стройматериалы из магазинов Ташкента с доставкой\">\n<meta property=\"og:description\" content=\"Сравнение цен 9 магазинов, Usta AI считает материалы, 3D-дизайнер комнаты, мастера и доставка Яндекс.\">\n<meta property=\"og:image\" content=\"https://usmonovm7777-crypto.github.io/Imorat/icons/og-image.png\">\n<meta property=\"og:image:width\" content=\"1200\">\n<meta property=\"og:image:height\" content=\"630\">\n<meta name=\"twitter:card\" content=\"summary_large_image\">\n<link rel=\"apple-touch-icon\" href=\"icons/apple-touch-icon.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Quriliş Go\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n{head_tags.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n")
  return html
html = _page(body.replace(PRE_MARK, ""), f'<link rel="preload" as="script" href="{APP_URL}">')
(ROOT / "index.html").write_text(html, encoding="utf-8")
# The ready first screen of the home (tools/prerender.js opens the site just written in a headless browser and takes the header,
# the first blocks and the tab bar as the page script rendered them, at a phone's and at a computer's size). A first-time
# visitor's browser then has the first screen in the page itself; the page script, when it arrives, renders the same over it.
# Needs node with the "playwright" package; without it, with PRERENDER=0, or for a site connected to a server (config.js names
# the server: its catalogue is not the demo's) the page is left as written above and renders from the page script.
PRE_SIZES = ("m", "d")  # a phone's first screen and a computer's
_pre_note = "PRERENDER=0"
if os.environ.get("PRERENDER", "1") != "0":
    _cfg = (ROOT / "config.js").read_text(encoding="utf-8") if (ROOT / "config.js").exists() else ""
    if re.search(r'IMORAT_API\s*=\s*"[^"]+"', _cfg): _pre_note = "the site is connected to a server"
    else:
        try: _pr = subprocess.run(["node", str(ROOT / "tools" / "prerender.js"), str(ROOT)], capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": _NODE_PATH}, timeout=420)
        except (OSError, subprocess.TimeoutExpired) as _e: _pr = None; _pre_note = "prerender did not run: " + str(_e)[:120]
        if _pr is not None and _pr.returncode == 3: _pre_note = "playwright not found"
        elif _pr is not None and _pr.returncode: _pre_note = "prerender failed: " + (_pr.stderr.strip().splitlines() or ["?"])[-1][:160]
        elif _pr is not None:
            _snap, _tpl, _kept = json.loads(_pr.stdout), "", []
            for _k in PRE_SIZES:
                _v = _snap.get(_k) or {}
                _parts = "".join(f'<div data-pre="{_id}">{_v.get(_id, "")}</div>' for _id in ("hdr", "app", "tabbar"))
                if not _v.get("stable") or re.search(r"</template|<script|<template", _parts, re.I): continue  # words that change with the hour, or markup a template cannot hold: this size renders from the page script
                _tpl += f'<template id="pre-{_k}" data-cls="{_v.get("cls", "")}">{_parts}</template>\n'; _kept.append(_k)
            if _tpl:
                _extra = ""  # each size's largest picture is asked for with the first bytes of the page
                for _k, _media in (("m", "(max-width: 760px)"), ("d", "(min-width: 761px)")):
                    for _lcp in ((_snap.get(_k) or {}).get("lcp") or []) if _k in _kept else []:
                      if _lcp.get("src") and '"' not in _lcp["src"] + _lcp["srcset"] + _lcp["sizes"]:
                        _extra += f'<link rel="preload" as="image" href="{_lcp["src"]}"' + (f' imagesrcset="{_lcp["srcset"]}" imagesizes="{_lcp["sizes"]}"' if _lcp["srcset"] else "") + f' fetchpriority="high" media="{_media}">\n'
                html = _page(body.replace(PRE_MARK, _tpl + "<script>" + PRE_SHOW + "</script>\n"), f'<link rel="x-app" href="{APP_URL}" data-pre="{" ".join(_kept)}">', _extra)
                (ROOT / "index.html").write_text(html, encoding="utf-8")
                _pre_note = "ready first screen: " + " + ".join({"m": "phone", "d": "computer"}[k] for k in _kept) + f" ({len(_tpl.encode('utf-8')) // 1024} KB of markup)"
            else: _pre_note = "the home page changes with the hour — no ready first screen"
import time
sw = (ROOT / "tools" / "sw.template.js").read_text(encoding="utf-8").replace("__BUILD__", time.strftime("%Y%m%d%H%M%S")).replace("__APP__", APP_URL)
(ROOT / "sw.js").write_text(sw, encoding="utf-8")
print("built index.html", len(html), "bytes, app.js", len(app_js.encode("utf-8")), "bytes, en.js + sw.js;",
      f"scripts minified (−{_min_state['saved'] // 1024} KB);{_map_note}{_css_note}" if _min_state["on"] and _min_state["saved"] else f"scripts as written ({_min_state['why']});", _l10n + ";",
      f"photo copies: {_thumbs_made} made" if _thumbs_ok else "photo copies incomplete (Pillow is not installed) — the page uses full photos", "; " + _pre_note)
import sys; sys.path.insert(0, str(ROOT / "tools")); import build_seo; build_seo.build()
