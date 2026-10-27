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
RESET = (":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
         "body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}"
         "img{max-width:100%}[hidden]{display:none!important}")
meta = ('<meta name="description" content="Imorat — маркетплейс строительных магазинов Ташкента: '
        'сравнение цен, Usta AI, калькуляторы ремонта и доставка Яндекс.">')
html = ("<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
        f"{meta}\n<style>{RESET}</style>\n<script src=\"config.js\"></script>\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#0B6E69\">\n<link rel=\"icon\" type=\"image/png\" href=\"icons/favicon-64.png\">\n<link rel=\"apple-touch-icon\" href=\"icons/apple-touch-icon.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Imorat\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n{head_tags.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n")
(ROOT / "index.html").write_text(html, encoding="utf-8")
import time
sw = (ROOT / "tools" / "sw.template.js").read_text(encoding="utf-8").replace("__BUILD__", time.strftime("%Y%m%d%H%M%S"))
(ROOT / "sw.js").write_text(sw, encoding="utf-8")
print("built index.html", len(html), "bytes + sw.js")
import sys; sys.path.insert(0, str(ROOT / "tools")); import build_seo; build_seo.build()
