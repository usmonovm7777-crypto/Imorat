"""Build the standalone website (index.html) from src/page.html.

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
# The app wrapper checks the server against the API contract this page was built for; it reads the number from a tag in the
# head, because after minification the constant no longer has its name in the script.
_contract = re.search(r"const API_CONTRACT = (\d+)", body)
contract_tag = f'<meta name="imorat:api-contract" content="{_contract.group(1)}">\n' if _contract else ""
# ...and the scripts minified with esbuild when it is installed (about 60 KB less to download over a phone network).
# Without esbuild the scripts stay as written and the site works the same — only bigger. MINIFY=0 keeps them readable.
# Where to get it: `npm i esbuild` in tools/ or in the repository root, or set ESBUILD_NODE_PATH to a node_modules that has it.
_MIN_JS = ("const e=require('esbuild');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>{"
           "const r=e.transformSync(s,{minify:true,target:'es2020',charset:'utf8',legalComments:'none'});process.stdout.write(r.code.trim())})")
_NODE_PATH = os.pathsep.join(d for d in [os.environ.get("ESBUILD_NODE_PATH", ""), os.environ.get("NODE_PATH", ""), str(ROOT / "node_modules"), str(ROOT / "tools" / "node_modules"),
                                          str(ROOT / "app" / "node_modules"), "/opt/npm-tools/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"] if d)
_min_state = {"on": os.environ.get("MINIFY", "1") != "0", "saved": 0, "why": "MINIFY=0"}
def _js_min(m):
    js = m.group(1)
    if not _min_state["on"]: return m.group(0)
    r = subprocess.run(["node", "-e", _MIN_JS], input=js, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "NODE_PATH": _NODE_PATH})
    out = r.stdout
    if r.returncode or not out.strip() or "</script" in out.lower():
        _min_state["on"] = False; _min_state["why"] = "esbuild not found" if "Cannot find module" in r.stderr else (r.stderr.strip().splitlines() or ["minifier failed"])[-1][:160]
        return m.group(0)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f: f.write(out); tmp = f.name
    try:
        if subprocess.run(["node", "--check", tmp], capture_output=True).returncode: sys.exit("build aborted: the minified script does not parse")
    finally: os.unlink(tmp)
    _min_state["saved"] += len(js.encode("utf-8")) - len(out.encode("utf-8"))
    return "<script>" + out + "</script>"
body = re.sub(r"<script>([\s\S]*?)</script>", _js_min, body)
# config.js (the public settings) is needed by the main script only: it is fetched from the first byte (preload in the head) and
# runs right before that script, so the start screen above it paints without waiting for it.
_main = body.rindex("<script>")
body = body[:_main] + '<script src="config.js"></script>\n' + body[_main:]
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
        f"{meta}\n{contract_tag}<style>{RESET}</style>\n<link rel=\"preload\" as=\"script\" href=\"config.js\">\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#FFFFFF\">\n<link rel=\"icon\" type=\"image/png\" href=\"icons/favicon-64.png\">\n<link rel=\"icon\" href=\"favicon.ico\" sizes=\"any\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:site_name\" content=\"Quriliş Go\">\n<meta property=\"og:title\" content=\"Quriliş Go — стройматериалы из магазинов Ташкента с доставкой\">\n<meta property=\"og:description\" content=\"Сравнение цен 9 магазинов, Usta AI считает материалы, 3D-дизайнер комнаты, мастера и доставка Яндекс.\">\n<meta property=\"og:image\" content=\"https://usmonovm7777-crypto.github.io/Imorat/icons/og-image.png\">\n<meta property=\"og:image:width\" content=\"1200\">\n<meta property=\"og:image:height\" content=\"630\">\n<meta name=\"twitter:card\" content=\"summary_large_image\">\n<link rel=\"apple-touch-icon\" href=\"icons/apple-touch-icon.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Quriliş Go\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n{head_tags.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n")
(ROOT / "index.html").write_text(html, encoding="utf-8")
import time
sw = (ROOT / "tools" / "sw.template.js").read_text(encoding="utf-8").replace("__BUILD__", time.strftime("%Y%m%d%H%M%S"))
(ROOT / "sw.js").write_text(sw, encoding="utf-8")
print("built index.html", len(html), "bytes + sw.js;", f"scripts minified (−{_min_state['saved'] // 1024} KB)" if _min_state["on"] and _min_state["saved"] else f"scripts as written ({_min_state['why']})")
import sys; sys.path.insert(0, str(ROOT / "tools")); import build_seo; build_seo.build()
